import * as fzstd from 'fzstd';
import * as zlib from 'node:zlib';

/**
 * Zstandard 4-byte magic number: 0xFD2FB528 (little-endian byte sequence 0x28, 0xB5, 0x2F, 0xFD)
 */
export const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Checks whether the buffer begins with the standard Zstandard magic header.
 */
export function isZstdBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 4) {
    return false;
  }
  return buf.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * Decompresses a single-frame or multi-frame Zstandard-compressed buffer.
 * Prefers Node.js native `zlib.zstdDecompressSync(..., { info: true })` in a frame
 * loop (20x+ faster than pure JS), falling back to `fzstd.decompress`.
 */
export function decompressZstd(buf: Buffer): Buffer {
  if (!isZstdBuffer(buf)) {
    throw new Error('Invalid zstd magic header: buffer does not start with 0xFD2FB528');
  }

  const maybeZlib = zlib as unknown as {
    zstdDecompressSync?: (
      b: Buffer,
      opts?: { info?: boolean }
    ) => Buffer | { buffer: Buffer; engine?: { bytesWritten?: number } };
  };

  if (typeof maybeZlib.zstdDecompressSync === 'function') {
    try {
      const frames: Buffer[] = [];
      let offset = 0;
      while (offset < buf.length) {
        if (offset + 4 > buf.length || buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
          throw new Error(`Invalid zstd frame magic at byte offset ${offset}`);
        }
        const res = maybeZlib.zstdDecompressSync(
          offset === 0 ? buf : buf.subarray(offset),
          { info: true }
        );
        if (Buffer.isBuffer(res)) {
          frames.push(res);
          break;
        }
        frames.push(res.buffer);
        const consumed = res.engine?.bytesWritten ?? 0;
        if (consumed <= 0) {
          throw new Error(`Native zstd frame reported 0 bytesWritten at offset ${offset}`);
        }
        offset += consumed;
      }
      return frames.length === 1 ? frames[0]! : Buffer.concat(frames);
    } catch {
      // Fall through to fzstd if native engine fails on edge-case frames
    }
  }

  try {
    const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const decompressed = fzstd.decompress(uint8);
    return Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
  } catch (fzstdErr) {
    throw new Error(`Failed to decompress zstd payload: ${String(fzstdErr)}`);
  }
}
