import { IPC_FRAME_MAX_BYTES } from '../config/index.js';

export class FrameTooLargeError extends Error {
  constructor(
    public readonly declared: number,
    public readonly max: number,
  ) {
    super(`IPC frame too large: ${declared} > ${max}`);
    this.name = 'FrameTooLargeError';
  }
}

export function encodeFrame(
  body: string | Buffer,
  maxBytes = IPC_FRAME_MAX_BYTES,
): Buffer {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  if (payload.length > maxBytes)
    throw new FrameTooLargeError(payload.length, maxBytes);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;
  constructor(opts: { maxBytes?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? IPC_FRAME_MAX_BYTES;
  }
  push(chunk: Buffer): Buffer[] {
    if (chunk.length)
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) throw new FrameTooLargeError(len, this.maxBytes);
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
  get buffered(): number {
    return this.buf.length;
  }
}
