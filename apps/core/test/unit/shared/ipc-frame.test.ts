import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError,
} from '@core/shared/ipc-frame.js';
const bodies = (decoder: FrameDecoder, buf: Buffer) =>
  decoder.push(buf).map((b) => b.toString('utf8'));
describe('ipc-frame', () => {
  it('round-trips a single frame', () => {
    const d = new FrameDecoder();
    expect(bodies(d, encodeFrame('hello'))).toEqual(['hello']);
  });
  it('handles two frames in one chunk (coalesced)', () => {
    const d = new FrameDecoder();
    const buf = Buffer.concat([encodeFrame('a'), encodeFrame('bb')]);
    expect(bodies(d, buf)).toEqual(['a', 'bb']);
  });
  it('handles a frame split across reads (partial)', () => {
    const d = new FrameDecoder();
    const f = encodeFrame('split-me');
    expect(bodies(d, f.subarray(0, 3))).toEqual([]);
    expect(bodies(d, f.subarray(3))).toEqual(['split-me']);
  });
  it('zero-length read yields nothing', () => {
    const d = new FrameDecoder();
    expect(bodies(d, Buffer.alloc(0))).toEqual([]);
  });
  it('rejects an oversized declared length', () => {
    const d = new FrameDecoder({ maxBytes: 8 });
    const big = Buffer.alloc(4);
    big.writeUInt32BE(9, 0);
    expect(() => d.push(big)).toThrow(FrameTooLargeError);
  });
  it('encodeFrame rejects an oversized body', () => {
    expect(() => encodeFrame(Buffer.alloc(9), 8)).toThrow(FrameTooLargeError);
  });
  it('property: any byte-split of a frame stream decodes identically', () => {
    const msgs = [
      '',
      'x',
      'hello world',
      JSON.stringify({ a: 1, b: [1, 2, 3] }),
    ];
    const stream = Buffer.concat(msgs.map((m) => encodeFrame(m)));
    for (let cut = 0; cut <= stream.length; cut++) {
      const d = new FrameDecoder();
      const out = [
        ...d.push(stream.subarray(0, cut)),
        ...d.push(stream.subarray(cut)),
      ];
      expect(out.map((b) => b.toString('utf8'))).toEqual(msgs);
    }
  });
});
