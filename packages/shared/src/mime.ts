/**
 * Zero-dependency MIME magic-number sniffer and data-URI parser.
 */

export interface SniffedMime {
  mime: string;
  ext: string;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/json': '.json',
  'text/plain': '.txt',
};

/**
 * Sniffs MIME type and extension from raw magic bytes.
 */
export function sniffMimeFromBuffer(buf: Buffer): SniffedMime {
  if (!buf || buf.length === 0) {
    return { mime: 'application/octet-stream', ext: '.bin' };
  }

  // PNG: 89 50 4E 47
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' };
  }

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  // WAV: RIFF....WAVE
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  ) {
    return { mime: 'audio/wav', ext: '.wav' };
  }

  // GIF: GIF8
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mime: 'image/gif', ext: '.gif' };
  }

  // PDF: %PDF
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { mime: 'application/pdf', ext: '.pdf' };
  }

  // MP4: ftyp at offset 4
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'video/mp4', ext: '.mp4' };
  }

  // MP3: ID3 or sync word
  if (
    (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)
  ) {
    return { mime: 'audio/mpeg', ext: '.mp3' };
  }

  // JSON: leading BOM + whitespace + '{' or '['
  let startIdx = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    startIdx = 3;
  }
  while (
    startIdx < buf.length &&
    (buf[startIdx] === 0x20 || buf[startIdx] === 0x09 || buf[startIdx] === 0x0a || buf[startIdx] === 0x0d)
  ) {
    startIdx++;
  }
  if (startIdx < buf.length && (buf[startIdx] === 0x7b || buf[startIdx] === 0x5b)) {
    try {
      JSON.parse(buf.subarray(startIdx).toString('utf8'));
      return { mime: 'application/json', ext: '.json' };
    } catch {
      // not valid JSON
    }
  }

  return { mime: 'application/octet-stream', ext: '.bin' };
}

export function extForMime(mime: string): string {
  const normalized = mime.toLowerCase().split(';')[0]!.trim();
  return MIME_TO_EXT[normalized] ?? '.bin';
}

export interface ParsedDataUri {
  mime: string;
  ext: string;
  buffer: Buffer;
}

const DATA_URI_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Parses an inline `data:<mime>;base64,<data>` URI into raw bytes and sniffed MIME.
 */
export function parseBase64DataUri(uri: string): ParsedDataUri | null {
  const trimmed = uri.trim();
  const match = DATA_URI_RE.exec(trimmed);
  if (!match) return null;

  const declaredMime = match[1]!.toLowerCase();
  const b64 = match[2]!.replace(/\s+/g, '');
  const buffer = Buffer.from(b64, 'base64');
  const sniffed = sniffMimeFromBuffer(buffer);
  const mime = sniffed.mime !== 'application/octet-stream' ? sniffed.mime : declaredMime;
  const ext = sniffed.mime !== 'application/octet-stream' ? sniffed.ext : extForMime(declaredMime);
  return { mime, ext, buffer };
}
