// 局域网直连加密：与电脑端 desktop/core/internal/lan/crypto_test.go 用同一组固定输入，结果必须完全一致。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePairUrl } from '../src/protocol/deepLink';
import { gcm } from '@noble/ciphers/aes';

import {
  AsyncFrameCipher,
  concat,
  FRAME_TEXT,
  FrameCipher,
  fromBase64,
  sas,
  sessionKeys,
  toBase64,
  toHex,
  transcript,
  utf8,
  type AesGcm,
  type RawSocket,
  SecureSocket,
} from '../src/protocol/secure';

const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

describe('加密算法与电脑端一致', () => {
  it('会话密钥、帧加密、配对摘要、配对码', () => {
    const { c2s, s2c } = sessionKeys(fill(32, 0x11), fill(16, 0x22), fill(16, 0x33));
    assert.equal(toHex(c2s), 'bb384ad708167679f9cf608764bd5c5b417acbe2d8174d085b47ab1b9811bfc8');
    assert.equal(toHex(s2c), 'e4cb9a4169fbdff52368f13be2a01e79af563047f3975ecda19ebd2d831f1210');
    const c = new FrameCipher(c2s);
    assert.equal(toHex(c.seal(FRAME_TEXT, utf8('{"a":1}'))), '9eef98253b91207d9c6291e11a19e38c1d216345a82b296e');
    assert.equal(toHex(c.seal(FRAME_TEXT, utf8('你好'))), '4f16ffd19c55f5bdd36ecd8d594357ba65b090d748fb3d');
    const t = transcript(utf8('PUBPHONE'), utf8('PUBPC'), 'phone-1', 'pc-1');
    assert.equal(toHex(t), '21ee8fd8e658512f1b68c8c4deeca8359e9b224f169066d11f60d52b8fae5dde');
    assert.equal(sas(fill(32, 0x44), t), '088755');
  });

  it('解密：正确、重放、篡改', () => {
    const { c2s } = sessionKeys(fill(32, 1), fill(16, 2), fill(16, 3));
    const frame = new FrameCipher(c2s).seal(FRAME_TEXT, utf8('hi'));
    const rd = new FrameCipher(c2s);
    assert.equal(new TextDecoder().decode(rd.open(frame).payload), 'hi');
    assert.throws(() => rd.open(frame), '重放的帧不能解开');
    const bad = frame.slice();
    bad[2] ^= 1;
    assert.throws(() => new FrameCipher(c2s).open(bad));
  });

  it('base64 往返', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
      assert.deepEqual(fromBase64(toBase64(b)), b);
    }
    assert.equal(toBase64(utf8('ab')), Buffer.from('ab').toString('base64'));
  });
});

describe('SecureSocket', () => {
  /** 模拟电脑端：握手后把收到的消息原样（加密）回给手机 */
  function fakeServer(key: Uint8Array, reject?: { code: string; message: string }) {
    const sent: unknown[] = [];
    let srvRd: FrameCipher;
    let srvWr: FrameCipher;
    const raw: RawSocket = {
      readyState: 1,
      send(data) {
        sent.push(data);
        if (typeof data === 'string') {
          const hello = JSON.parse(data);
          setTimeout(() => {
            if (reject) {
              raw.onmessage?.({ data: JSON.stringify({ type: 'error', ...reject }) });
              raw.onclose?.({ code: 1008, reason: reject.code });
              return;
            }
            const ns = fill(16, 9);
            const k = sessionKeys(key, fromBase64(hello.nc), ns);
            srvRd = new FrameCipher(k.c2s);
            srvWr = new FrameCipher(k.s2c);
            raw.onmessage?.({ data: JSON.stringify({ type: 'hello', pc: 'pc1', name: 'PC', os: 'windows', ns: toBase64(ns) }) });
          }, 1);
          return;
        }
        const { payload } = srvRd.open(new Uint8Array(data as ArrayBuffer));
        const echo = srvWr.seal(FRAME_TEXT, payload);
        setTimeout(() => raw.onmessage?.({ data: echo.buffer.slice(echo.byteOffset, echo.byteOffset + echo.byteLength) }), 1);
      },
      close() {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    return { raw, sent };
  }

  it('握手后收发明文，线路上是密文', async () => {
    const key = fill(32, 7);
    const { raw, sent } = fakeServer(key);
    let n = 0;
    const s = new SecureSocket({
      url: 'ws://x/p2d/secure',
      phoneId: 'ph',
      key,
      manual: true,
      random: (len) => fill(len, ++n),
      createRaw: () => raw,
    });
    const opened = new Promise<void>((r) => (s.onopen = () => r()));
    raw.onopen?.({});
    await opened;
    assert.equal(s.readyState, 1);
    assert.equal(JSON.parse(sent[0] as string).manual, true);
    const got = new Promise<string>((r) => (s.onmessage = (ev) => r(ev.data as string)));
    s.send('{"jsonrpc":"2.0","id":1}');
    assert.equal(await got, '{"jsonrpc":"2.0","id":1}');
    assert.ok(sent[1] instanceof ArrayBuffer, '发出去的应是二进制密文');
    assert.ok(!new TextDecoder().decode(new Uint8Array(sent[1] as ArrayBuffer)).includes('jsonrpc'));
  });

  it('连接中就被关闭：底层连接之后才连上时立即断开，不发握手', () => {
    const sent: unknown[] = [];
    let rawClosed = 0;
    const raw: RawSocket = {
      readyState: 0,
      send: (d) => sent.push(d),
      close: () => rawClosed++,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    const s = new SecureSocket({
      url: 'ws://x',
      phoneId: 'ph',
      key: fill(32, 1),
      manual: false,
      random: (len) => fill(len, 1),
      createRaw: () => raw,
    });
    s.close();
    raw.onopen?.({}); // Android 上 close() 没能取消连接，稍后仍然连上了
    assert.equal(sent.length, 0);
    assert.equal(rawClosed, 2);
  });

  it('电脑端拒绝（未配对）时以 4401 关闭并带原因', async () => {
    const { raw } = fakeServer(fill(32, 1), { code: 'unpaired', message: '这台电脑没有和这部手机配对' });
    const s = new SecureSocket({
      url: 'ws://x',
      phoneId: 'ph',
      key: fill(32, 1),
      manual: false,
      random: (len) => fill(len, 1),
      createRaw: () => raw,
    });
    const closed = new Promise<{ code?: number; reason?: string }>((r) => (s.onclose = r));
    raw.onopen?.({});
    const ev = await closed;
    assert.equal(ev.code, 4401);
    assert.match(ev.reason ?? '', /没有和这部手机配对/);
  });
});

describe('配对二维码', () => {
  it('解析电脑端的二维码内容', () => {
    const p = parsePairUrl(
      'p2d://pair?h=192.168.31.159%2C10.0.0.2&p=39272&id=0123456789abcdef&n=PC-%E5%8A%9E%E5%85%AC%E5%AE%A4&s=AAAAAAAAAAAAAAAAAAAAAA',
    );
    assert.deepEqual(p, {
      addrs: ['192.168.31.159', '10.0.0.2'],
      port: 39272,
      pcId: '0123456789abcdef',
      name: 'PC-办公室',
      secret: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    assert.equal(parsePairUrl('p2d://pair?h=1.2.3.4&p=39272&id=xyz&s=AAAAAAAAAAAAAAAAAAAAAA'), null);
    assert.equal(parsePairUrl('https://example.com'), null);
  });
});

describe('AES-GCM（握手商定后用系统原生实现）', () => {
  // 测试里用 @noble/ciphers 的 AES-GCM 代替 expo-crypto；随机延迟，模拟原生调用乱序完成
  const delay = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  const nobleAes: AesGcm = {
    importKey: async (k) => k,
    encrypt: async (k, n, pt) => {
      await delay();
      return gcm(k as Uint8Array, n).encrypt(pt);
    },
    decrypt: async (k, n, s) => {
      await delay();
      return gcm(k as Uint8Array, n).decrypt(s);
    },
  };

  it('帧加密结果和电脑端一致', async () => {
    const { c2s } = sessionKeys(fill(32, 0x11), fill(16, 0x22), fill(16, 0x33));
    const c = new AsyncFrameCipher(nobleAes, c2s);
    const [f0, f1] = await Promise.all([c.seal(FRAME_TEXT, utf8('{"a":1}')), c.seal(FRAME_TEXT, utf8('你好'))]);
    assert.equal(toHex(f0), 'da0855921bcf83e8488fef21e436ddcc0ffba85ca8aba1f3');
    assert.equal(toHex(f1), '6937f98f4fedd015e34f87d12fbd08751d091a7e0243db');
    const rd = new AsyncFrameCipher(nobleAes, c2s);
    assert.equal(new TextDecoder().decode((await rd.open(f0)).payload), '{"a":1}');
    await assert.rejects(rd.open(f0), '重放的帧不能解开');
  });

  /** 模拟电脑端：认识 aes-gcm 时用它，否则用 ChaCha20；把收到的消息原样回给手机 */
  function server(key: Uint8Array, supportsAes: boolean) {
    const sent: unknown[] = [];
    let srv: { open(b: Uint8Array): Uint8Array; seal(p: Uint8Array): Uint8Array };
    let picked = '';
    const raw: RawSocket = {
      readyState: 1,
      send(data) {
        sent.push(data);
        if (typeof data === 'string') {
          const hello = JSON.parse(data);
          const ns = fill(16, 9);
          const k = sessionKeys(key, fromBase64(hello.nc), ns);
          const useAes = supportsAes && hello.ciphers?.includes('aes-gcm');
          picked = useAes ? 'aes-gcm' : 'chacha';
          if (useAes) {
            let rc = 0;
            let wc = 0;
            const nonce = (c: number) => {
              const n = new Uint8Array(12);
              new DataView(n.buffer).setUint32(8, c);
              return n;
            };
            srv = {
              open: (b) => gcm(k.c2s, nonce(rc++)).decrypt(b).subarray(1),
              seal: (p) => gcm(k.s2c, nonce(wc++)).encrypt(concat(new Uint8Array([FRAME_TEXT]), p)),
            };
          } else {
            const rd = new FrameCipher(k.c2s);
            const wr = new FrameCipher(k.s2c);
            srv = { open: (b) => rd.open(b).payload, seal: (p) => wr.seal(FRAME_TEXT, p) };
          }
          const reply = { type: 'hello', pc: 'pc1', name: 'PC', os: 'windows', ns: toBase64(ns), ...(useAes ? { cipher: 'aes-gcm' } : {}) };
          setTimeout(() => raw.onmessage?.({ data: JSON.stringify(reply) }), 1);
          return;
        }
        const echo = srv.seal(srv.open(new Uint8Array(data as ArrayBuffer)));
        raw.onmessage?.({ data: echo.buffer.slice(echo.byteOffset, echo.byteOffset + echo.byteLength) });
      },
      close() {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    return { raw, sent, picked: () => picked };
  }

  for (const supportsAes of [true, false]) {
    it(supportsAes ? '电脑端支持：改用 AES-GCM，乱序完成也按顺序收发' : '旧版电脑端：仍用 ChaCha20', async () => {
      const key = fill(32, 5);
      const srv = server(key, supportsAes);
      const s = new SecureSocket({
        url: 'ws://x/p2d/secure',
        phoneId: 'ph',
        key,
        manual: false,
        random: (len) => fill(len, 3),
        createRaw: () => srv.raw,
        aes: nobleAes,
      });
      const opened = new Promise<void>((r) => (s.onopen = () => r()));
      srv.raw.onopen?.({});
      await opened;
      assert.deepEqual(JSON.parse(srv.sent[0] as string).ciphers, ['aes-gcm', 'chacha20-poly1305']);
      assert.equal(srv.picked(), supportsAes ? 'aes-gcm' : 'chacha');
      const got: string[] = [];
      const all = new Promise<void>((r) => {
        s.onmessage = (ev) => {
          got.push(ev.data as string);
          if (got.length === 30) r();
        };
      });
      const want = Array.from({ length: 30 }, (_, i) => `{"id":${i},"x":"${'数据'.repeat(i * 50)}"}`);
      for (const m of want) s.send(m);
      await all;
      assert.deepEqual(got, want);
    });
  }
});
