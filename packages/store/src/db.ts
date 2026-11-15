import { DatabaseSync, StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCHEMA_001_SQL, FTS_REBUILD_SQL } from './schema-sql.js';

export interface ArchiveDatabaseOptions {
  enableForeignKeyConstraints?: boolean;
}

/**
 * High-performance SQLite database connection and transaction wrapper using
 * Node.js 24 native built-in `node:sqlite` (DatabaseSync).
 */
export class ArchiveDatabase {
  public readonly rawDb: DatabaseSync;
  public readonly path: string;
  private txDepth = 0;

  constructor(db: DatabaseSync, dbPath: string) {
    this.rawDb = db;
    this.path = dbPath;
  }

  /**
   * Opens an archive SQLite database with WAL mode and foreign key constraints enabled.
   * Creates parent directories automatically when a filesystem path is specified.
   */
  static openArchiveDb(dbPath: string, _options?: ArchiveDatabaseOptions): ArchiveDatabase {
    if (dbPath !== ':memory:') {
      const resolved = path.resolve(dbPath);
      const parentDir = path.dirname(resolved);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }

    const db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
    });

    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 10000;');
    db.exec('PRAGMA cache_size = -65536;');
    db.exec('PRAGMA temp_store = MEMORY;');
    db.exec('PRAGMA mmap_size = 268435456;');

    return new ArchiveDatabase(db, dbPath);
  }

  /**
   * Opens an external SQLite database file (e.g. state.vscdb, SQLite exports) in read-only mode.
   */
  static openExternalSqliteReadOnly(filePath: string): DatabaseSync {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`External SQLite database file not found: ${resolved}`);
    }

    return new DatabaseSync(resolved, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
  }

  /**
   * Executes the baseline schema (001_init.sql) and ensures metadata entries exist.
   */
  migrate(): void {
    // Recreate column-scoped AFTER UPDATE FTS5 triggers on existing DBs so
    // non-text updates (parent_id, is_active_branch, starred) never re-index FTS5.
    this.rawDb.exec(`
      DROP TRIGGER IF EXISTS item_fts_uni_au;
      DROP TRIGGER IF EXISTS item_fts_tri_au;
      DROP TRIGGER IF EXISTS conv_fts_tri_au;
    `);
    this.rawDb.exec(SCHEMA_001_SQL);

    const now = Date.now().toString();
    const stmt = this.rawDb.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
    stmt.run('schema_version', '1');
    stmt.run('created_at', now);
  }

  /**
   * Rebuilds all FTS5 full-text search indexes (item_fts_uni, item_fts_tri, conv_fts_tri)
   * and records the timestamp in the meta table.
   */
  rebuildFts(): void {
    this.rawDb.exec(FTS_REBUILD_SQL);

    const now = Date.now().toString();
    const stmt = this.rawDb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    stmt.run('last_reindex_at', now);
  }

  /**
   * Executes an arbitrary SQL script.
   */
  exec(sql: string): void {
    this.rawDb.exec(sql);
  }

  /**
   * Prepares a SQL statement for repeated execution.
   */
  prepare(sql: string): StatementSync {
    return this.rawDb.prepare(sql);
  }

  /**
   * Retrieves a metadata value by key.
   */
  getMeta(key: string): string | undefined {
    const stmt = this.rawDb.prepare('SELECT value FROM meta WHERE key = ?');
    const row = stmt.get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  /**
   * Sets or updates a metadata key-value pair.
   */
  setMeta(key: string, value: string): void {
    const stmt = this.rawDb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    stmt.run(key, value);
  }

  /**
   * Executes a synchronous callback within a transaction.
   * Supports nested calls via SQLite SAVEPOINTs and automatically commits/releases
   * on success or rolls back on error.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const savepoint = `sm_sp_${this.txDepth}`;
      this.txDepth++;
      this.rawDb.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        this.rawDb.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        this.rawDb.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.rawDb.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw err;
      } finally {
        this.txDepth--;
      }
    }

    this.txDepth++;
    this.rawDb.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /**
   * Closes the underlying database connection.
   */
  close(): void {
    this.rawDb.close();
  }
}

/** Standalone convenience function to open an archive database */
export function openArchiveDb(dbPath: string): ArchiveDatabase {
  return ArchiveDatabase.openArchiveDb(dbPath);
}

/** Standalone convenience function to open an external SQLite file in read-only mode */
export function openExternalSqliteReadOnly(filePath: string): DatabaseSync {
  return ArchiveDatabase.openExternalSqliteReadOnly(filePath);
}
