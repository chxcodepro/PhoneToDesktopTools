// 局域网直连的加密通道（与电脑端 desktop/core/internal/lan 对应，见 docs/PROTOCOL.md 第 9 节）。
// - 配对密钥 K（32 字节）+ 双方随机数 → HKDF 派生两个方向的会话密钥；
// - 每条消息 ChaCha20-Poly1305 加密，nonce = 4 字节 0 + 8 字节大端计数器（每个方向各自递增）；
// - 明文第一个字节是帧类型（1 文本，2 二进制）。
// SecureSocket 实现 McpClient 需要的 WebSocketLike 接口，McpClient 本身不用改。
// 不依赖 React Native；随机数由调用方注入（RN 里用 expo-crypto）。

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

import type { WebSocketLike } from './mcpClient';

export type RandomBytes = (n: number) => Uint8Array;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string) => enc.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    const v = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    out.push((v >> 16) & 255);
    if (i + 2 < clean.length) out.push((v >> 8) & 255);
    if (i + 3 < clean.length) out.push(v & 255);
  }
  return new Uint8Array(out);
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function mac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  return hmac(sha256, key, concat(...parts));
}

export function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n = 32): Uint8Array {
  return hkdf(sha256, ikm, salt, info, n);
}

/** 配对时双方公钥和身份的摘要（每段前面加 4 字节大端长度） */
export function transcript(pubPhone: Uint8Array, pubPc: Uint8Array, phoneId: string, pcId: string): Uint8Array {
  const parts = [utf8('p2d pair v1'), pubPhone, pubPc, utf8(phoneId), utf8(pcId)].flatMap((p) => {
    const l = new Uint8Array(4);
    new DataView(l.buffer).setUint32(0, p.length);
    return [l, p];
  });
  return sha256(concat(...parts));
}

/** 配对码模式的 6 位短认证码 */
export function sas(shared: Uint8Array, t: Uint8Array): string {
  const b = hkdf32(shared, t, utf8('p2d sas'), 4);
  const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
  return String(n % 1_000_000).padStart(6, '0');
}

export function sessionKeys(k: Uint8Array, nc: Uint8Array, ns: Uint8Array): { c2s: Uint8Array; s2c: Uint8Array } {
  const okm = hkdf32(k, concat(nc, ns), utf8('p2d secure v1'), 64);
  return { c2s: okm.slice(0, 32), s2c: okm.slice(32) };
}

export const FRAME_TEXT = 1;
export const FRAME_BINARY = 2;

/** 一个方向的加密状态（计数器 nonce） */
export class FrameCipher {
  private counter = 0;
  constructor(private readonly key: Uint8Array) {}

  private nonce(): Uint8Array {
    const n = new Uint8Array(12);
    const v = new DataView(n.buffer);
    v.setUint32(4, Math.floor(this.counter / 2 ** 32));
    v.setUint32(8, this.counter >>> 0);
    this.counter++;
    return n;
  }

  seal(type: number, payload: Uint8Array): Uint8Array {
    return chacha20poly1305(this.key, this.nonce()).encrypt(concat(new Uint8Array([type]), payload));
  }

  /** 解密失败（密钥不对、被篡改、乱序）时抛错 */
  open(frame: Uint8Array): { type: number; payload: Uint8Array } {
    const pt = chacha20poly1305(this.key, this.nonce()).decrypt(frame);
    if (!pt.length) throw new Error('空帧');
    return { type: pt[0], payload: pt.subarray(1) };
  }
}

/** 底层（未加密）WebSocket：需要支持二进制消息 */
export interface RawSocket {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface SecureSocketOptions {
  url: string;
  phoneId: string;
  key: Uint8Array;
  /** 用户手动点「连接」（电脑端点过「断开」后只接受手动连接） */
  manual: boolean;
  random: RandomBytes;
  createRaw: (url: string) => RawSocket;
  /** 握手成功时告诉调用方电脑信息 */
  onHello?: (info: { pc: string; name: string; os: string }) => void;
  /** 电脑端拒绝的原因代码（unpaired / suppressed 等） */
  onReject?: (code: string, message: string) => void;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * 加密的 WebSocket：握手完成后才变成 OPEN（触发 onopen），之后收发的都是明文字符串。
 * 电脑端拒绝（未配对 / 已断开）时以 code 4401 关闭，McpClient 会停止重连并把原因显示出来。
 */
export class SecureSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: { message?: string; error?: unknown }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private raw: RawSocket;
  private rd: FrameCipher | null = null;
  private wr: FrameCipher | null = null;
  private reject: { code: string; message: string } | null = null;
  private closed = false;

  constructor(private readonly opts: SecureSocketOptions) {
    const nc = opts.random(16);
    const raw = opts.createRaw(opts.url);
    raw.binaryType = 'arraybuffer';
    this.raw = raw;
    raw.onopen = () => raw.send(JSON.stringify({ type: 'hello', v: 1, phone: opts.phoneId, nc: toBase64(nc), manual: opts.manual }));
    raw.onerror = (ev) => this.onerror?.(ev);
    raw.onclose = (ev) => this.finish(ev?.code ?? 1006, ev?.reason ?? '');
    raw.onmessage = (ev) => {
      if (this.closed) return;
      if (!this.rd) {
        // 握手：第一条是明文 JSON
        let m: { type?: string; ns?: string; pc?: string; name?: string; os?: string; code?: string; message?: string };
        try {
          m = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(toBytes(ev.data) ?? new Uint8Array()));
        } catch {
          this.fail('握手数据格式错误');
          return;
        }
        if (m.type === 'error') {
          this.reject = { code: m.code ?? 'error', message: m.message ?? '电脑端拒绝连接' };
          opts.onReject?.(this.reject.code, this.reject.message);
          return; // 等电脑端关闭
        }
        if (m.type !== 'hello' || !m.ns) {
          this.fail('握手失败');
          return;
        }
        const { c2s, s2c } = sessionKeys(opts.key, nc, fromBase64(m.ns));
        this.wr = new FrameCipher(c2s);
        this.rd = new FrameCipher(s2c);
        this.readyState = 1;
        opts.onHello?.({ pc: m.pc ?? '', name: m.name ?? '', os: m.os ?? '' });
        this.onopen?.({});
        return;
      }
      const bytes = toBytes(ev.data);
      if (!bytes) {
        this.fail('收到未加密的消息');
        return;
      }
      let frame: { type: number; payload: Uint8Array };
      try {
        frame = this.rd.open(bytes);
      } catch {
        this.fail('解密失败（配对密钥不一致或数据被篡改）');
        return;
      }
      this.onmessage?.({ data: frame.type === FRAME_TEXT ? dec.decode(frame.payload) : frame.payload });
    };
  }

  send(data: string): void {
    if (!this.wr || this.readyState !== 1) throw new Error('连接未就绪');
    const sealed = this.wr.seal(FRAME_TEXT, utf8(data));
    this.raw.send(sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer);
  }

  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
    this.finish(code ?? 1000, reason ?? '');
  }

  private fail(message: string): void {
    this.onerror?.({ message });
    this.raw.close(4000, 'secure error');
    this.finish(4000, message);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    // 电脑端明确拒绝：用 4401 让 McpClient 停止自动重连，reason 显示给用户
    if (this.reject && ['unpaired', 'suppressed'].includes(this.reject.code)) this.onclose?.({ code: 4401, reason: this.reject.message });
    else this.onclose?.({ code, reason: this.reject?.message ?? reason });
  }
}

// ---------- 配对 ----------

export interface PairResult {
  pcId: string;
  name: string;
  os: string;
  key: Uint8Array;
  addrs: string[];
  port: number;
}

export interface PairOptions {
  /** ws://IP:端口 */
  base: string;
  mode: 'qr' | 'code';
  phoneId: string;
  phoneName: string;
  /** 扫码模式：二维码里的一次性密钥 */
  secret?: string;
  random: RandomBytes;
  createRaw: (url: string) => RawSocket;
  /** 配对码模式：让用户输入电脑上显示的 6 位码；返回 null 表示取消。check 用来核对，不一致时可以重新输入 */
  askCode?: (check: (code: string) => boolean) => Promise<string | null>;
  timeoutMs?: number;
}

export class PairError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 和电脑配对（扫码或配对码），成功后返回配对密钥和电脑信息 */
export function pairWithPc(opts: PairOptions): Promise<PairResult> {
  return new Promise<PairResult>((resolve, reject) => {
    const priv = opts.random(32);
    const pub = x25519.getPublicKey(priv);
    const raw = opts.createRaw(`${opts.base}/p2d/pair`);
    let step: 'hello' | 'confirm' | 'done' = 'hello';
    let expectServerMac: Uint8Array | null = null;
    let key: Uint8Array | null = null;
    let settled = false;
    const timer = setTimeout(
      () => done(new PairError('timeout', '连接电脑超时：请确认电脑端已打开、手机和电脑在同一个局域网，并允许了防火墙')),
      opts.timeoutMs ?? 12_000,
    );
    const done = (err: Error | null, result?: PairResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        raw.close(1000, 'done');
      } catch {
        // 忽略
      }
      if (err) reject(err);
      else resolve(result!);
    };
    raw.onopen = () =>
      raw.send(JSON.stringify({ type: 'pair', v: 1, mode: opts.mode, phone: opts.phoneId, name: opts.phoneName, pub: toBase64(pub) }));
    raw.onerror = (ev) =>
      done(
        new PairError(
          'network',
          `连不上电脑（${ev?.message ?? '网络错误'}）。请确认电脑端已打开、在同一个 WiFi；手机开着 VPN / 代理时，要在其中打开「绕过局域网」`,
        ),
      );
    raw.onclose = () => done(new PairError('closed', step === 'confirm' ? '配对未完成，电脑端已关闭连接' : '电脑端关闭了连接'));
    raw.onmessage = async (ev) => {
      let m: Record<string, string>;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return done(new PairError('bad', '电脑端返回的数据格式错误'));
      }
      if (m.type === 'error') return done(new PairError(m.code ?? 'error', m.message ?? '电脑端拒绝配对'));
      if (step === 'hello' && m.type === 'pair') {
        clearTimeout(timer);
        const pcPub = fromBase64(m.pub ?? '');
        const shared = x25519.getSharedSecret(priv, pcPub);
        const t = transcript(pub, pcPub, opts.phoneId, m.pc ?? '');
        let confirmMac: Uint8Array;
        if (opts.mode === 'qr') {
          const secret = fromBase64(opts.secret ?? '');
          confirmMac = mac(secret, utf8('c'), t);
          expectServerMac = mac(secret, utf8('s'), t);
          key = hkdf32(shared, secret, concat(utf8('p2d key'), t));
        } else {
          const code = sas(shared, t);
          const typed = opts.askCode ? await opts.askCode((c) => c.replace(/\D/g, '') === code) : null;
          if (typed === null || typed.replace(/\D/g, '') !== code) return done(new PairError('cancelled', '已取消配对'));
          const kconf = hkdf32(shared, t, utf8('p2d confirm'));
          confirmMac = mac(kconf, utf8('c'));
          expectServerMac = mac(kconf, utf8('s'));
          key = hkdf32(shared, t, utf8('p2d key'));
        }
        step = 'confirm';
        raw.send(JSON.stringify({ type: 'confirm', mac: toBase64(confirmMac) }));
        return;
      }
      if (step === 'confirm' && m.type === 'ok') {
        const got = fromBase64(m.mac ?? '');
        if (!expectServerMac || toHex(got) !== toHex(expectServerMac))
          return done(new PairError('mismatch', '电脑端校验失败，配对可能被干扰'));
        step = 'done';
        const r = m as unknown as { pc: string; name: string; os: string; addrs?: string[]; port?: number };
        return done(null, { pcId: r.pc, name: r.name, os: r.os, key: key!, addrs: r.addrs ?? [], port: Number(r.port) || 0 });
      }
    };
  });
}
