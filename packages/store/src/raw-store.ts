import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RawStorePersistResult {
  sha256: string;
  relPath: string;
  absPath: string;
  size: number;
}

/**
 * RawStore manages the immutable raw staging layer:
 * `raw/<provider>/<sha256_prefix>/<filename>`
 * Preserves the exact bytes of exported archives, single files, and directories for zero-loss reproducibility.
 */
export class RawStore {
  public readonly rootDir: string;
  private readonly ensuredDirs = new Set<string>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  private ensureDirSync(dir: string): void {
    if (this.ensuredDirs.has(dir)) return;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.ensuredDirs.add(dir);
  }

  /**
   * Sanitizes entry name to prevent directory traversal and invalid filename characters.
   */
  private sanitizeFilename(entryName: string): string {
    const base = path.basename(entryName.trim());
    const sanitized = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    return sanitized.length > 0 ? sanitized : 'data.bin';
  }

  /**
   * Computes the relative and absolute storage paths for an entry.
   */
  getRawPath(provider: string, entryName: string, sha256: string): { relPath: string; absPath: string } {
    const prefix = sha256.slice(0, 2);
    const filename = this.sanitizeFilename(entryName);
    const relPath = path.posix.join('raw', provider, prefix, filename);
    const absPath = path.resolve(this.rootDir, relPath);
    return { relPath, absPath };
  }

  /**
   * Persists raw bytes into immutable storage asynchronously.
   * If the file already exists, the write is skipped (content-addressed / immutable).
   */
  async persistRaw(
    provider: string,
    entryName: string,
    bytes: Buffer | Uint8Array
  ): Promise<RawStorePersistResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const { relPath, absPath } = this.getRawPath(provider, entryName, sha256);

    const dir = path.dirname(absPath);
    await this.ensureDir(dir);

    try {
      await fs.promises.access(absPath, fs.constants.F_OK);
    } catch {
      // Write to temp file then rename for atomic write
      const tmpPath = `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.promises.writeFile(tmpPath, buf);
      await fs.promises.rename(tmpPath, absPath);
    }

    return {
      sha256,
      relPath,
      absPath,
      size: buf.length,
    };
  }

  /**
   * Synchronous variant of persistRaw for synchronous pipeline stages.
   */
  persistRawSync(
    provider: string,
    entryName: string,
    bytes: Buffer | Uint8Array
  ): RawStorePersistResult {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const { relPath, absPath } = this.getRawPath(provider, entryName, sha256);

    const dir = path.dirname(absPath);
    this.ensureDirSync(dir);

    if (!fs.existsSync(absPath)) {
      const tmpPath = `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, absPath);
    }

    return {
      sha256,
      relPath,
      absPath,
      size: buf.length,
    };
  }

  /**
   * Resolves a relative raw path to an absolute path.
   */
  resolvePath(relPath: string): string {
    return path.resolve(this.rootDir, relPath);
  }

  /**
   * Checks whether the given raw file exists on disk.
   */
  hasRaw(relOrAbsPath: string): boolean {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? relOrAbsPath
      : path.resolve(this.rootDir, relOrAbsPath);
    return fs.existsSync(absPath);
  }

  /**
   * Reads raw bytes from disk.
   */
  async readRaw(relOrAbsPath: string): Promise<Buffer> {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? relOrAbsPath
      : path.resolve(this.rootDir, relOrAbsPath);
    return fs.promises.readFile(absPath);
  }

  /**
   * Synchronously reads raw bytes from disk.
   */
  readRawSync(relOrAbsPath: string): Buffer {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? relOrAbsPath
      : path.resolve(this.rootDir, relOrAbsPath);
    return fs.readFileSync(absPath);
  }
}
