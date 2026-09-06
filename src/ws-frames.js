// WebSocket framing (RFC 6455), dependency-free.
//
// The Codex WebSocket relay needs to read frames on both sides of a spliced
// connection — the client's first `response.create` to learn the model before
// an account is chosen, and the upstream's `codex.rate_limits` and error
// events to keep the quota honest — and to write a few of its own (a close
// with a reason, an error event). Node ships a WebSocket *client* but no
// server-side framing, and this proxy carries no dependencies, so the codec
// lives here. It is deliberately small: no extensions (the relay declines
// permessage-deflate on the handshake, so RSV bits never carry meaning), no
// subprotocols, and the wire bytes are otherwise passed through untouched.

import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({ CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });

// Largest reassembled message the decoder will hold. A Codex `response.create`
// with a full transcript runs to a few hundred kilobytes; this is a ceiling
// against a hostile peer, not a budget.
export const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;

/** The `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`. */
export function computeAccept(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** A fresh `Sec-WebSocket-Key` for an outbound handshake. */
export function handshakeKey() {
  return randomBytes(16).toString('base64');
}

/** A decoding failure that maps onto a close code: 1002 for a protocol
 * violation, 1009 for a message past the size ceiling. */
export class FrameError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Encode one frame. Client-to-server frames MUST be masked (`mask: true`);
 * server-to-client frames MUST NOT be. `fin: false` starts a fragmented
 * message, which nothing here needs but the decoder is tested against.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const headerLen = 2 + (len >= 65536 ? 8 : len >= 126 ? 2 : 0) + (mask ? 4 : 0);
  const frame = Buffer.alloc(headerLen + len);
  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let off = 2;
  if (len >= 65536) {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  } else if (len >= 126) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    off = 4;
  } else {
    frame[1] = len;
  }
  if (mask) {
    const key = randomBytes(4);
    frame[1] |= 0x80;
    key.copy(frame, off);
    off += 4;
    for (let i = 0; i < len; i++) frame[off + i] = data[i] ^ key[i & 3];
  } else {
    data.copy(frame, off);
  }
  return frame;
}

/** A close frame carrying a status code and a (short) reason. */
export function closeFrame(code, reason = '', opts = {}) {
  if (code == null) return encodeFrame(OPCODE.CLOSE, Buffer.alloc(0), opts);
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OPCODE.CLOSE, payload, opts);
}

/** The `{ code, reason }` a close frame's payload carries; code null when it
 * carries none. */
export function parseClose(payload) {
  if (!payload || payload.length < 2) return { code: null, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

/**
 * Incremental frame decoder. Feed it every chunk read from a socket; it
 * returns the complete messages those bytes finished, reassembling
 * fragmented data frames and passing control frames through as they arrive.
 * Masked and unmasked frames are both accepted, since the relay reads both
 * directions with the same decoder.
 *
 * Throws a FrameError (with a close code) on a malformed stream; the caller
 * decides whether that closes the connection or merely stops observation.
 */
export class FrameDecoder {
  constructor({ maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.fragment = null;   // { opcode, parts, length } while a fragmented message is open
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      const frame = this._next();
      if (!frame) return out;
      const message = this._assemble(frame);
      if (message) out.push(message);
    }
  }

  /** Parse one frame off the buffer, or null when the buffer holds less than one. */
  _next() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameError('frame length out of range', 1009);
      len = Number(big);
      off = 10;
    }
    if (len > this.maxPayload) throw new FrameError(`frame of ${len} bytes exceeds the ${this.maxPayload} byte ceiling`, 1009);
    let key = null;
    if (masked) {
      if (b.length < off + 4) return null;
      key = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  /** Fold a frame into the open message; return a complete message or null. */
  _assemble({ fin, opcode, payload }) {
    if (opcode >= OPCODE.CLOSE) {
      // Control frames are never fragmented and never longer than 125 bytes.
      if (!fin || payload.length > 125) throw new FrameError('malformed control frame', 1002);
      return { opcode, payload, fin: true };
    }
    if (opcode === OPCODE.CONTINUATION) {
      if (!this.fragment) throw new FrameError('continuation frame with no message open', 1002);
      this.fragment.length += payload.length;
      if (this.fragment.length > this.maxPayload) throw new FrameError('fragmented message exceeds the size ceiling', 1009);
      this.fragment.parts.push(payload);
      if (!fin) return null;
      const message = { opcode: this.fragment.opcode, payload: Buffer.concat(this.fragment.parts), fin: true };
      this.fragment = null;
      return message;
    }
    if (opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) throw new FrameError(`reserved opcode ${opcode}`, 1002);
    if (this.fragment) throw new FrameError('data frame while a fragmented message is open', 1002);
    if (fin) return { opcode, payload, fin: true };
    this.fragment = { opcode, parts: [payload], length: payload.length };
    return null;
  }
}
