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
 * Decompresses a Zstandard-compressed buffer.
 * Uses `fzstd.decompress` as the primary decompressor, falling back to
 * `zlib.zstdDecompressSync` if available in the Node runtime.
 */
export function decompressZstd(buf: Buffer): Buffer {
  if (!isZstdBuffer(buf)) {
    throw new Error('Invalid zstd magic header: buffer does not start with 0xFD2FB528');
  }

  // 1. Primary: fzstd pure-JS/WASM decompressor
  try {
    const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const decompressed = fzstd.decompress(uint8);
    return Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
  } catch (fzstdErr) {
    // 2. Fallback: Node.js zlib native zstdDecompressSync if exposed
    const maybeZlib = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    if (typeof maybeZlib.zstdDecompressSync === 'function') {
      try {
        return maybeZlib.zstdDecompressSync(buf);
      } catch (zlibErr) {
        throw new Error(
          `Failed to decompress zstd payload (fzstd: ${String(fzstdErr)}; zlib: ${String(zlibErr)})`
        );
      }
    }
    throw new Error(`Failed to decompress zstd payload: ${String(fzstdErr)}`);
  }
}
