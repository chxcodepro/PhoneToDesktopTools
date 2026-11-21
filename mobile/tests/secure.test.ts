// 局域网直连加密：与电脑端 desktop/core/internal/lan/crypto_test.go 用同一组固定输入，结果必须完全一致。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePairUrl } from '../src/protocol/deepLink';
import {
  FRAME_TEXT,
  FrameCipher,
  fromBase64,
  sas,
  sessionKeys,
  toBase64,
  toHex,
  transcript,
  utf8,
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
