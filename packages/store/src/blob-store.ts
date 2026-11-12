import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OcaBlob, OcaBlobOriginKind } from '@sm/oca';

export interface SniffedMime {
  mime: string;
  ext: string;
}

/**
 * Sniffs MIME type and file extension based on magic numbers:
 * - PNG (89 50 4E 47)
 * - JPEG (FF D8)
 * - WebP (RIFF..WEBP)
 * - GIF (GIF8)
 * - PDF (%PDF)
 * - MP4 (ftyp at offset 4)
 * - JSON ({ or [)
 * - Fallback to application/octet-stream
 */
export function sniffMimeAndExt(buf: Buffer): SniffedMime {
  if (!buf || buf.length === 0) {
    return { mime: 'application/octet-stream', ext: '.bin' };
  }

  // 1. PNG: 89 50 4E 47
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { mime: 'image/png', ext: '.png' };
  }

  // 2. JPEG: FF D8 FF
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // 3. WebP: RIFF (bytes 0-3) + WEBP (bytes 8-11)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50  // WEBP
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  // 4. GIF: GIF8 (47 49 46 38)
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return { mime: 'image/gif', ext: '.gif' };
  }

  // 5. PDF: %PDF (25 50 44 46)
  if (
    buf.length >= 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  ) {
    return { mime: 'application/pdf', ext: '.pdf' };
  }

  // 6. MP4: ftyp at offset 4 (66 74 79 70)
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    return { mime: 'video/mp4', ext: '.mp4' };
  }

  // 7. JSON: check for JSON opening tokens after skipping whitespace and BOM
  let startIdx = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    startIdx = 3; // UTF-8 BOM
  }
  while (startIdx < buf.length && (buf[startIdx] === 0x20 || buf[startIdx] === 0x09 || buf[startIdx] === 0x0a || buf[startIdx] === 0x0d)) {
    startIdx++;
  }

  if (startIdx < buf.length) {
    const firstByte = buf[startIdx];
    if (firstByte === 0x7b || firstByte === 0x5b) { // '{' or '['
      try {
        const text = buf.toString('utf8');
        JSON.parse(text);
        return { mime: 'application/json', ext: '.json' };
      } catch {
        // Not valid JSON, continue to fallback
      }
    }
  }

  // 8. Fallback
  return { mime: 'application/octet-stream', ext: '.bin' };
}

/**
 * BlobStore manages content-addressed storage for media assets and spilled payloads:
 * `blobs/<sha256_prefix_2>/<sha256><ext>`
 * Deduplicates all binary content by SHA-256 hash across conversations and import batches.
 */
export class BlobStore {
  public readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Resolves a relative or absolute blob path to an absolute path.
   */
  getBlobAbsPath(relPath: string): string {
    return path.isAbsolute(relPath) ? relPath : path.resolve(this.rootDir, relPath);
  }

  /**
   * Checks whether a blob file exists on disk.
   */
  hasBlob(relPath: string): boolean {
    return fs.existsSync(this.getBlobAbsPath(relPath));
  }

  /**
   * Reads the content of a blob.
   */
  async readBlob(relPath: string): Promise<Buffer> {
    return fs.promises.readFile(this.getBlobAbsPath(relPath));
  }

  /**
   * Reads the content of a blob synchronously.
   */
  readBlobSync(relPath: string): Buffer {
    return fs.readFileSync(this.getBlobAbsPath(relPath));
  }

  /**
   * Stores a binary buffer into content-addressed blob storage asynchronously.
   */
  async putBlob(
    buf: Buffer,
    originKind: OcaBlobOriginKind,
    overrideMime?: string,
    overrideExt?: string
  ): Promise<OcaBlob> {
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const sniffed = sniffMimeAndExt(buf);
    const mime = overrideMime ?? sniffed.mime;
    const ext = overrideExt ?? sniffed.ext;

    const prefix2 = sha256.slice(0, 2);
    const rel_path = path.posix.join('blobs', prefix2, `${sha256}${ext}`);
    const absPath = this.getBlobAbsPath(rel_path);

    const dir = path.dirname(absPath);
    await fs.promises.mkdir(dir, { recursive: true });

    try {
      await fs.promises.access(absPath, fs.constants.F_OK);
    } catch {
      const tmpPath = `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.promises.writeFile(tmpPath, buf);
      await fs.promises.rename(tmpPath, absPath);
    }

    return {
      sha256,
      mime,
      bytes: buf.length,
      ext,
      rel_path,
      origin_kind: originKind,
      created_at: Date.now(),
    };
  }

  /**
   * Synchronously stores a binary buffer into content-addressed blob storage.
   */
  putBlobSync(
    buf: Buffer,
    originKind: OcaBlobOriginKind,
    overrideMime?: string,
    overrideExt?: string
  ): OcaBlob {
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const sniffed = sniffMimeAndExt(buf);
    const mime = overrideMime ?? sniffed.mime;
    const ext = overrideExt ?? sniffed.ext;

    const prefix2 = sha256.slice(0, 2);
    const rel_path = path.posix.join('blobs', prefix2, `${sha256}${ext}`);
    const absPath = this.getBlobAbsPath(rel_path);

    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(absPath)) {
      const tmpPath = `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, absPath);
    }

    return {
      sha256,
      mime,
      bytes: buf.length,
      ext,
      rel_path,
      origin_kind: originKind,
      created_at: Date.now(),
    };
  }

  /**
   * Spills an arbitrary payload (object, array, string, or Buffer) to blob storage
   * when it exceeds inline size limits (e.g. > 32KB).
   */
  async spillPayload(
    payload: unknown | Buffer,
    originKind: OcaBlobOriginKind = 'oversized_payload'
  ): Promise<OcaBlob> {
    let buf: Buffer;
    let overrideMime: string | undefined;
    let overrideExt: string | undefined;

    if (Buffer.isBuffer(payload)) {
      buf = payload;
    } else if (typeof payload === 'string') {
      buf = Buffer.from(payload, 'utf8');
      overrideMime = 'text/plain';
      overrideExt = '.txt';
    } else {
      buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      overrideMime = 'application/json';
      overrideExt = '.json';
    }

    return this.putBlob(buf, originKind, overrideMime, overrideExt);
  }

  /**
   * Synchronous variant of spillPayload.
   */
  spillPayloadSync(
    payload: unknown | Buffer,
    originKind: OcaBlobOriginKind = 'oversized_payload'
  ): OcaBlob {
    let buf: Buffer;
    let overrideMime: string | undefined;
    let overrideExt: string | undefined;

    if (Buffer.isBuffer(payload)) {
      buf = payload;
    } else if (typeof payload === 'string') {
      buf = Buffer.from(payload, 'utf8');
      overrideMime = 'text/plain';
      overrideExt = '.txt';
    } else {
      buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      overrideMime = 'application/json';
      overrideExt = '.json';
    }

    return this.putBlobSync(buf, originKind, overrideMime, overrideExt);
  }
}
