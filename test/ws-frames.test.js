import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccept, handshakeKey, encodeFrame, closeFrame, parseClose, FrameDecoder, FrameError, OPCODE } from '../src/ws-frames.js';

test('computeAccept matches the RFC 6455 worked example', () => {
  // The key/accept pair from RFC 6455 §1.3.
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshakeKey is 16 random bytes in base64', () => {
  const key = handshakeKey();
  assert.equal(Buffer.from(key, 'base64').length, 16);
  assert.notEqual(key, handshakeKey());
});

test('encode/decode round trip across all three length encodings, masked and not', () => {
  for (const len of [0, 5, 125, 126, 65535, 65536, 70_000]) {
    for (const mask of [false, true]) {
      const payload = Buffer.alloc(len, 0xab);
      const frame = encodeFrame(OPCODE.BINARY, payload, { mask });
      assert.equal((frame[1] & 0x80) !== 0, mask, `mask bit for len ${len}`);
      const [msg] = new FrameDecoder().push(frame);
      assert.equal(msg.opcode, OPCODE.BINARY);
      assert.ok(msg.payload.equals(payload), `payload for len ${len} mask ${mask}`);
    }
  }
});

test('the decoder reassembles bytes that arrive one at a time', () => {
  const frame = encodeFrame(OPCODE.TEXT, 'hello, world', { mask: true });
  const dec = new FrameDecoder();
  const out = [];
  for (const byte of frame) out.push(...dec.push(Buffer.from([byte])));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString(), 'hello, world');
});

test('several frames in one chunk come out in order', () => {
  const chunk = Buffer.concat([
    encodeFrame(OPCODE.TEXT, 'one'), encodeFrame(OPCODE.PING, 'p'), encodeFrame(OPCODE.TEXT, 'two'),
  ]);
  const out = new FrameDecoder().push(chunk);
  assert.deepEqual(out.map(m => [m.opcode, m.payload.toString()]), [[1, "one"], [9, "p"], [1, "two"]]);
});

test('a fragmented message is delivered once, whole, with a control frame interleaved', () => {
  const dec = new FrameDecoder();
  const parts = [
    encodeFrame(OPCODE.TEXT, '{"type":"resp', { fin: false }),
    encodeFrame(OPCODE.PONG, ''),
    encodeFrame(OPCODE.CONTINUATION, 'onse.create","mo', { fin: false }),
    encodeFrame(OPCODE.CONTINUATION, 'del":"x"}'),
  ];
  const out = parts.flatMap(p => dec.push(p));
  assert.deepEqual(out.map(m => m.opcode), [OPCODE.PONG, OPCODE.TEXT]);
  assert.equal(out[1].payload.toString(), '{"type":"response.create","model":"x"}');
});

test('protocol violations throw a FrameError with a close code', () => {
  const bad = (frames, code, dec = new FrameDecoder()) => {
    assert.throws(() => frames.forEach(f => dec.push(f)), (err) => err instanceof FrameError && err.code === code);
  };
  bad([encodeFrame(OPCODE.CONTINUATION, 'x')], 1002);                                        // no message open
  bad([encodeFrame(OPCODE.TEXT, 'a', { fin: false }), encodeFrame(OPCODE.TEXT, 'b')], 1002); // new data mid-message
  bad([encodeFrame(OPCODE.CLOSE, '', { fin: false })], 1002);                                // fragmented control frame
  bad([encodeFrame(3, 'x')], 1002);                                                          // reserved opcode
  bad([encodeFrame(OPCODE.BINARY, Buffer.alloc(200))], 1009, new FrameDecoder({ maxPayload: 100 }));
});

test('the payload ceiling applies to fragmented messages as a whole', () => {
  const dec = new FrameDecoder({ maxPayload: 100 });
  dec.push(encodeFrame(OPCODE.BINARY, Buffer.alloc(60), { fin: false }));
  assert.throws(() => dec.push(encodeFrame(OPCODE.CONTINUATION, Buffer.alloc(60))), (e) => e.code === 1009);
});

test('the ceiling is enforced from the header, before the payload is buffered', () => {
  const dec = new FrameDecoder({ maxPayload: 1000 });
  const header = Buffer.from([0x82, 127, 0, 0, 0, 0, 0, 0x10, 0, 0]); // 1 MiB announced
  assert.throws(() => dec.push(header), (e) => e.code === 1009);
});

test('close frames carry a code and a reason, and an empty one carries neither', () => {
  const [msg] = new FrameDecoder().push(closeFrame(1012, 'reconnect'));
  assert.equal(msg.opcode, OPCODE.CLOSE);
  assert.deepEqual(parseClose(msg.payload), { code: 1012, reason: 'reconnect' });
  assert.deepEqual(parseClose(new FrameDecoder().push(closeFrame(null))[0].payload), { code: null, reason: '' });
  // Reasons are clipped so the control frame stays within 125 bytes.
  const long = new FrameDecoder().push(closeFrame(1000, 'x'.repeat(500)))[0];
  assert.equal(long.payload.length, 125);
});
