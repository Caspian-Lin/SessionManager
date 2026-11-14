import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Zero-dependency ZIP reader & writer built on Node's `node:zlib` (`inflateRawSync` / `deflateRawSync`).
 * Supports Stored (0) and Deflate (8) methods, Central Directory listing, selective entry reading,
 * and ZIP64 extra fields for large offsets/sizes.
 */

const EOCD_SIG = 0x06054b50;
const CD_HEADER_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

export interface ZipEntryInfo {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export interface ZipWriteEntry {
  name: string;
  data: Buffer | string;
  compress?: boolean;
}

function normalizeEntryName(rawName: string): string {
  return rawName.replace(/\\/g, '/').replace(/^\/+/, '');
}

function readUInt64LEAsNumber(buf: Buffer, offset: number): number {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return hi * 0x100000000 + lo;
}

interface ByteReader {
  readonly size: number;
  readSlice(offset: number, length: number): Buffer;
  close(): void;
}

class BufferByteReader implements ByteReader {
  readonly size: number;
  constructor(private readonly buf: Buffer) {
    this.size = buf.length;
  }
  readSlice(offset: number, length: number): Buffer {
    const end = Math.min(this.size, offset + length);
    return this.buf.subarray(offset, end);
  }
  close(): void {
    // no-op
  }
}

class FileByteReader implements ByteReader {
  readonly size: number;
  private fd: number | null;

  constructor(filePath: string) {
    const stat = fs.statSync(filePath);
    this.size = stat.size;
    this.fd = fs.openSync(filePath, 'r');
  }

  readSlice(offset: number, length: number): Buffer {
    if (this.fd === null) {
      throw new Error('ZipArchive has already been closed');
    }
    const clampedLen = Math.max(0, Math.min(length, this.size - offset));
    const out = Buffer.allocUnsafe(clampedLen);
    let totalRead = 0;
    while (totalRead < clampedLen) {
      const n = fs.readSync(this.fd, out, totalRead, clampedLen - totalRead, offset + totalRead);
      if (n === 0) break;
      totalRead += n;
    }
    return totalRead === clampedLen ? out : out.subarray(0, totalRead);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export class ZipArchive {
  private readonly entriesByName = new Map<string, ZipEntryInfo>();
  private readonly orderedEntries: ZipEntryInfo[] = [];

  private constructor(private readonly reader: ByteReader) {
    this.parseCentralDirectory();
  }

  static fromBuffer(buf: Buffer): ZipArchive {
    return new ZipArchive(new BufferByteReader(buf));
  }

  static open(filePath: string): ZipArchive {
    return new ZipArchive(new FileByteReader(filePath));
  }

  listEntries(): ZipEntryInfo[] {
    return [...this.orderedEntries];
  }

  getEntry(name: string): ZipEntryInfo | undefined {
    return this.entriesByName.get(normalizeEntryName(name));
  }

  readEntry(name: string): Buffer {
    const entry = this.getEntry(name);
    if (!entry) {
      throw new Error(`ZIP entry not found: ${name}`);
    }
    if (entry.isDirectory) {
      return Buffer.alloc(0);
    }

    const lfh = this.reader.readSlice(entry.localHeaderOffset, 30);
    if (lfh.length < 30 || lfh.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
      throw new Error(`Invalid ZIP local file header for entry: ${entry.name}`);
    }

    const fileNameLen = lfh.readUInt16LE(26);
    const extraLen = lfh.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLen + extraLen;
    const compressedBuf = this.reader.readSlice(dataOffset, entry.compressedSize);

    if (compressedBuf.length < entry.compressedSize) {
      throw new Error(`Truncated ZIP entry data for ${entry.name}`);
    }

    if (entry.compressionMethod === 0) {
      return Buffer.from(compressedBuf);
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(compressedBuf);
    }
    throw new Error(
      `Unsupported ZIP compression method ${entry.compressionMethod} for entry: ${entry.name}`
    );
  }

  readEntryText(name: string, encoding: BufferEncoding = 'utf8'): string {
    return this.readEntry(name).toString(encoding);
  }

  close(): void {
    this.reader.close();
  }

  private parseCentralDirectory(): void {
    const fileSize = this.reader.size;
    if (fileSize < 22) {
      throw new Error('Invalid ZIP file: smaller than minimum EOCD size');
    }

    // EOCD is at the end of the file, with at most 65535 bytes of ZIP comment
    const searchLen = Math.min(fileSize, 65535 + 22);
    const tailStart = fileSize - searchLen;
    const tail = this.reader.readSlice(tailStart, searchLen);

    let eocdOffsetInTail = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        const commentLen = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLen === tail.length) {
          eocdOffsetInTail = i;
          break;
        }
      }
    }

    if (eocdOffsetInTail === -1) {
      throw new Error('Invalid ZIP file: End of Central Directory record not found');
    }

    let cdSize = tail.readUInt32LE(eocdOffsetInTail + 12);
    let cdOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
    let totalEntries = tail.readUInt16LE(eocdOffsetInTail + 10);

    // Check for ZIP64 EOCD Locator immediately before EOCD
    if (
      (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) &&
      eocdOffsetInTail >= 20 &&
      tail.readUInt32LE(eocdOffsetInTail - 20) === ZIP64_EOCD_LOCATOR_SIG
    ) {
      const zip64EocdOffset = readUInt64LEAsNumber(tail, eocdOffsetInTail - 12);
      const z64 = this.reader.readSlice(zip64EocdOffset, 56);
      if (z64.length >= 56 && z64.readUInt32LE(0) === ZIP64_EOCD_SIG) {
        totalEntries = readUInt64LEAsNumber(z64, 32);
        cdSize = readUInt64LEAsNumber(z64, 40);
        cdOffset = readUInt64LEAsNumber(z64, 48);
      }
    }

    const cdBuf = this.reader.readSlice(cdOffset, cdSize);
    let pos = 0;

    while (pos + 46 <= cdBuf.length && this.orderedEntries.length < totalEntries) {
      if (cdBuf.readUInt32LE(pos) !== CD_HEADER_SIG) {
        break;
      }

      const flags = cdBuf.readUInt16LE(pos + 8);
      const compressionMethod = cdBuf.readUInt16LE(pos + 10);
      const crc32 = cdBuf.readUInt32LE(pos + 16);
      let compressedSize = cdBuf.readUInt32LE(pos + 20);
      let uncompressedSize = cdBuf.readUInt32LE(pos + 24);
      const fileNameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      let localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

      const nameStart = pos + 46;
      const nameEnd = nameStart + fileNameLen;
      const encoding = (flags & 0x0800) !== 0 ? 'utf8' : 'latin1';
      const rawName = cdBuf.subarray(nameStart, nameEnd).toString(encoding);
      const name = normalizeEntryName(rawName);

      // Parse ZIP64 extra field (header ID 0x0001) if needed
      if (
        (uncompressedSize === 0xffffffff ||
          compressedSize === 0xffffffff ||
          localHeaderOffset === 0xffffffff) &&
        extraLen >= 4
      ) {
        let exPos = nameEnd;
        const exEnd = nameEnd + extraLen;
        while (exPos + 4 <= exEnd) {
          const headerId = cdBuf.readUInt16LE(exPos);
          const dataSize = cdBuf.readUInt16LE(exPos + 2);
          if (headerId === 0x0001) {
            let fieldPos = exPos + 4;
            if (uncompressedSize === 0xffffffff && fieldPos + 8 <= exEnd) {
              uncompressedSize = readUInt64LEAsNumber(cdBuf, fieldPos);
              fieldPos += 8;
            }
            if (compressedSize === 0xffffffff && fieldPos + 8 <= exEnd) {
              compressedSize = readUInt64LEAsNumber(cdBuf, fieldPos);
              fieldPos += 8;
            }
            if (localHeaderOffset === 0xffffffff && fieldPos + 8 <= exEnd) {
              localHeaderOffset = readUInt64LEAsNumber(cdBuf, fieldPos);
            }
            break;
          }
          exPos += 4 + dataSize;
        }
      }

      const info: ZipEntryInfo = {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        crc32,
        localHeaderOffset,
        isDirectory: rawName.endsWith('/'),
      };

      this.orderedEntries.push(info);
      if (name) {
        this.entriesByName.set(name, info);
      }

      pos = nameEnd + extraLen + commentLen;
    }
  }
}

export function listZipEntries(filePath: string): ZipEntryInfo[] {
  const zip = ZipArchive.open(filePath);
  try {
    return zip.listEntries();
  } finally {
    zip.close();
  }
}

export function readZipEntry(filePath: string, entryName: string): Buffer {
  const zip = ZipArchive.open(filePath);
  try {
    return zip.readEntry(entryName);
  } finally {
    zip.close();
  }
}

/**
 * Builds a valid PKZIP archive buffer in memory (zero-dependency).
 */
export function createZipBuffer(entries: readonly ZipWriteEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const item of entries) {
    const name = normalizeEntryName(item.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = typeof item.data === 'string' ? Buffer.from(item.data, 'utf8') : item.data;
    const shouldCompress = item.compress !== false && rawBuf.length > 0;
    const compressedBuf = shouldCompress ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = shouldCompress ? 8 : 0;
    const crc = zlib.crc32(rawBuf) >>> 0;

    // Local file header (30 bytes + name)
    const lfh = Buffer.allocUnsafe(30 + nameBuf.length);
    lfh.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x5421, 12); // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressedBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(lfh, 30);

    localParts.push(lfh, compressedBuf);

    // Central Directory header (46 bytes + name)
    const cdh = Buffer.allocUnsafe(46 + nameBuf.length);
    cdh.writeUInt32LE(CD_HEADER_SIG, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(0x5421, 14); // mod date
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressedBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);

    cdParts.push(cdh);
    offset += lfh.length + compressedBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}
