// @ts-check
// Minimal WebSocket server (RFC 6455) for the server → page event channel.
//
// Why not Server-Sent Events: browsers allow only six simultaneous HTTP/1.1 connections per
// host, shared by every page in the same browser profile. Inside OBS all Studio Host pages
// (studio hub, guest slots, screen share, dock) share one profile, so long-lived SSE
// connections used up the limit and every further request to the server stalled.
// WebSocket connections do not count toward that limit.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

export class WsConnection {
  /** @param {import('node:stream').Duplex} socket */
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    /** @type {Buffer} */ this.buffer = Buffer.alloc(0);
    /** @type {Buffer[]} */ this.fragments = [];
    /** @type {((text: string) => void)|null} */ this.onmessage = null;
    /** @type {((data: Buffer) => void)|null} */ this.onbinary = null;
    /** Opcode of the message being received (fragments carry 0). */ this.opcode = 0;
    /** @type {(() => void)|null} */ this.onclose = null;
    /** @type {any} */ (socket).setNoDelay?.(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
    this.pinger = setInterval(() => this.frame(0x9, Buffer.alloc(0)), 25_000);
    this.pinger.unref();
  }

  /** @param {string} text */
  send(text) { this.frame(0x1, Buffer.from(text, 'utf8')); }

  /** @param {Buffer} data */
  sendBinary(data) { this.frame(0x2, data); }

  /** Bytes written but not yet sent. */
  get backlog() { return this.socket.writableLength; }

  /** @param {number} [code] @param {string} [reason] */
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.frame(0x8, body);
    this.socket.end();
    this.closed();
  }

  /** @param {number} opcode @param {Buffer} payload */
  frame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** @param {Buffer} chunk */
  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'too big');
        len = Number(big); offset = 10;
      }
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len > MAX_MESSAGE) return this.close(1009, 'too big');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) this.opcode = opcode;
        this.fragments.push(payload);
        if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return this.close(1009, 'too big');
        if (fin) {
          const data = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.opcode === 0x2) this.onbinary?.(data);
          else this.onmessage?.(data.toString('utf8'));
        }
      }
    }
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.pinger);
    this.socket.destroy();
    this.onclose?.();
  }
}

/**
 * Completes the WebSocket handshake for an HTTP upgrade request.
 * @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket
 * @returns {WsConnection|null}
 */
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket);
}
