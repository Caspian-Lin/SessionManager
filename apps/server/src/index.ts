/**
 * @sm/server — Local HTTP API Server for Session Manager
 *
 * Binds strictly to 127.0.0.1, validates ephemeral token via X-SM-Token or Authorization,
 * and exposes API endpoints for Flutter Windows UI (ui-win) and tools.
 * Zero external runtime dependencies required to compile.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export interface ServerOptions {
  port?: number;
  token?: string;
  dbPath?: string;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  token: string;
  dbPath: string;
  close: () => Promise<void>;
}

export interface ConversationSummaryRow {
  id: number;
  provider: string;
  account_id: number | null;
  external_id: string | null;
  title: string | null;
  summary: string | null;
  created_at: number | null;
  updated_at: number | null;
  exported_at: number | null;
  default_model: string | null;
  cwd: string | null;
  item_count: number;
  char_count: number;
  blob_count: number;
  head_hash: string | null;
  content_hash: string | null;
  fingerprint: string | null;
  starred: number;
  archived: number;
}

export interface ItemRow {
  id: number;
  conversation_id: number;
  parent_id: number | null;
  external_id: string | null;
  ordinal: number;
  depth: number;
  role: string;
  kind: string;
  created_at: number | null;
  model: string | null;
  text: string | null;
  text_len: number;
  content_hash: string;
  is_active_branch: number;
  is_hidden: number;
  is_synthetic: number;
  status: string | null;
  payload_ref: string | null;
}

export interface BlockRow {
  id: number;
  item_id: number;
  idx: number;
  type: string;
  text: string | null;
  lang: string | null;
  tool_name: string | null;
  tool_input: string | null;
  status: string | null;
  blob_id: number | null;
  meta_json: string | null;
}

export interface BlobRow {
  id: number;
  sha256: string;
  mime: string;
  bytes: number;
  ext: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  rel_path: string;
  origin_kind: string;
  created_at: number;
}

export interface ImportBatchRow {
  id: number;
  provider: string;
  adapter_id: string;
  adapter_version: string;
  account_id: number | null;
  kind: string;
  source_path: string | null;
  source_sha256: string;
  exported_at: number | null;
  imported_at: number;
  status: string;
  stats_json: string | null;
  report_json: string | null;
}

/** Initialize essential SQLite schema if database is new */
export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT,
      external_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batch (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      account_id INTEGER REFERENCES account(id),
      kind TEXT NOT NULL,
      source_path TEXT,
      source_sha256 TEXT NOT NULL,
      exported_at INTEGER,
      imported_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      stats_json TEXT,
      report_json TEXT
    );

    CREATE TABLE IF NOT EXISTS import_file (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER,
      role TEXT,
      parsed_ok INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS project (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT,
      external_id TEXT,
      root_path TEXT,
      UNIQUE(provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS tag (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id INTEGER REFERENCES account(id),
      external_id TEXT,
      title TEXT,
      title_source TEXT,
      summary TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      exported_at INTEGER,
      default_model TEXT,
      cwd TEXT,
      project_id INTEGER REFERENCES project(id),
      item_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      blob_count INTEGER NOT NULL DEFAULT 0,
      head_hash TEXT,
      content_hash TEXT,
      fingerprint TEXT,
      revision_count INTEGER NOT NULL DEFAULT 1,
      first_batch_id INTEGER REFERENCES import_batch(id),
      last_batch_id INTEGER REFERENCES import_batch(id),
      starred INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      flags_json TEXT
    );

    CREATE TABLE IF NOT EXISTS item (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES item(id) ON DELETE CASCADE,
      external_id TEXT,
      ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER,
      model TEXT,
      text TEXT,
      text_len INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      is_active_branch INTEGER NOT NULL DEFAULT 1,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_synthetic INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      payload_ref TEXT,
      flags_json TEXT
    );

    CREATE TABLE IF NOT EXISTS block (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      lang TEXT,
      tool_name TEXT,
      tool_input TEXT,
      status TEXT,
      blob_id INTEGER REFERENCES blob(id),
      meta_json TEXT
    );

    CREATE TABLE IF NOT EXISTS blob (
      id INTEGER PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      ext TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      rel_path TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dedupe_candidate (
      id INTEGER PRIMARY KEY,
      a_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      similarity REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  // Ensure default meta entry
  const checkMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const existingVersion = checkMeta.get('schema_version') as { value: string } | undefined;
  if (!existingVersion) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('created_at', Date.now().toString());
  }
}

/** Check if incoming request satisfies ephemeral token authentication */
function isAuthorized(req: http.IncomingMessage, expectedToken: string): boolean {
  const smToken = req.headers['x-sm-token'];
  if (typeof smToken === 'string' && smToken === expectedToken) {
    return true;
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    if (auth === expectedToken || auth === `Bearer ${expectedToken}`) {
      return true;
    }
  }
  return false;
}

/** Send JSON response with standard CORS & security headers */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-SM-Token, Content-Type, Range',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** Send error JSON response */
function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message, status: statusCode });
}

/** Resolve and open SQLite database safely */
function getDatabase(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  initializeSchema(db);
  return db;
}

/**
 * Start the local SessionManager HTTP server.
 * Binds strictly to 127.0.0.1 with ephemeral token protection.
 */
export async function startLocalServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? 0; // 0 for automatic port selection
  const token = options.token ?? crypto.randomBytes(24).toString('hex');
  const dbPath = path.resolve(options.dbPath ?? './archive.db');
  const baseDir = path.dirname(dbPath);
  const blobsDir = path.join(baseDir, 'blobs');

  const db = getDatabase(dbPath);

  const server = http.createServer((req, res) => {
    // Standard CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-SM-Token, Content-Type, Range',
      });
      res.end();
      return;
    }

    const host = req.headers.host ?? '127.0.0.1';
    const parsed = new url.URL(req.url ?? '/', `http://${host}`);
    const pathname = parsed.pathname;

    // Public health check route
    if (pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        version: '0.1.0',
        uptime: process.uptime(),
        authenticated: isAuthorized(req, token),
        dbPath,
        dbConnected: true,
      });
      return;
    }

    // Enforce token validation for all other endpoints
    if (!isAuthorized(req, token)) {
      sendError(res, 401, 'Unauthorized: Invalid or missing X-SM-Token or Authorization header');
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /api/conversations
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/api/conversations' && req.method === 'GET') {
      const limitParam = parsed.searchParams.get('limit');
      const offsetParam = parsed.searchParams.get('offset');
      const providerParam = parsed.searchParams.get('provider');
      const starredParam = parsed.searchParams.get('starred');

      const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

      const conditions: string[] = ['deleted_at IS NULL'];
      const params: (string | number)[] = [];

      if (providerParam) {
        conditions.push('provider = ?');
        params.push(providerParam);
      }
      if (starredParam !== null) {
        conditions.push('starred = ?');
        params.push(starredParam === 'true' || starredParam === '1' ? 1 : 0);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countStmt = db.prepare(`SELECT COUNT(*) as count FROM conversation ${whereClause}`);
      const countResult = countStmt.get(...params) as { count: number } | undefined;
      const total = countResult?.count ?? 0;

      const listStmt = db.prepare(`
        SELECT id, provider, account_id, external_id, title, title_source, summary,
               created_at, updated_at, exported_at, default_model, cwd,
               item_count, char_count, blob_count, head_hash, content_hash,
               fingerprint, starred, archived
        FROM conversation
        ${whereClause}
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?
      `);

      const rows = listStmt.all(...params, limit, offset) as unknown as ConversationSummaryRow[];

      sendJson(res, 200, {
        total,
        limit,
        offset,
        items: rows,
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /api/conversations/:id
    // ─────────────────────────────────────────────────────────────
    const convDetailMatch = pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (convDetailMatch && req.method === 'GET') {
      const convId = parseInt(convDetailMatch[1] ?? '0', 10);
      const convStmt = db.prepare(`
        SELECT * FROM conversation WHERE id = ? AND deleted_at IS NULL
      `);
      const conv = convStmt.get(convId) as ConversationSummaryRow | undefined;

      if (!conv) {
        sendError(res, 404, `Conversation #${convId} not found`);
        return;
      }

      const itemsStmt = db.prepare(`
        SELECT id, conversation_id, parent_id, external_id, ordinal, depth,
               role, kind, created_at, model, text, text_len, content_hash,
               is_active_branch, is_hidden, is_synthetic, status, payload_ref
        FROM item
        WHERE conversation_id = ?
        ORDER BY ordinal ASC
      `);
      const items = itemsStmt.all(convId) as unknown as ItemRow[];

      const itemIds = items.map((it) => it.id);
      let blocks: BlockRow[] = [];
      if (itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(',');
        const blocksStmt = db.prepare(`
          SELECT id, item_id, idx, type, text, lang, tool_name, tool_input, status, blob_id, meta_json
          FROM block
          WHERE item_id IN (${placeholders})
          ORDER BY item_id ASC, idx ASC
        `);
        blocks = blocksStmt.all(...itemIds) as unknown as BlockRow[];
      }

      // Group blocks by item_id
      const blocksByItem = new Map<number, BlockRow[]>();
      for (const b of blocks) {
        const list = blocksByItem.get(b.item_id) ?? [];
        list.push(b);
        blocksByItem.set(b.item_id, list);
      }

      const enrichedItems = items.map((item) => ({
        ...item,
        is_active_branch: Boolean(item.is_active_branch),
        is_hidden: Boolean(item.is_hidden),
        is_synthetic: Boolean(item.is_synthetic),
        blocks: blocksByItem.get(item.id) ?? [],
      }));

      sendJson(res, 200, {
        conversation: conv,
        items: enrichedItems,
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /api/search?q=<query>&limit=<n>
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/api/search' && req.method === 'GET') {
      const q = parsed.searchParams.get('q') ?? '';
      const limitParam = parsed.searchParams.get('limit');
      const limit = Math.min(Math.max(parseInt(limitParam ?? '30', 10) || 30, 1), 100);

      if (!q.trim()) {
        sendJson(res, 200, { query: q, count: 0, results: [] });
        return;
      }

      // Fallback robust search across items and conversations
      const searchPattern = `%${q.trim()}%`;
      const searchStmt = db.prepare(`
        SELECT i.id AS item_id, i.conversation_id, i.role, i.kind, i.text, i.created_at,
               c.title, c.provider
        FROM item i
        JOIN conversation c ON i.conversation_id = c.id
        WHERE c.deleted_at IS NULL AND (i.text LIKE ? OR c.title LIKE ?)
        ORDER BY i.created_at DESC
        LIMIT ?
      `);

      const rows = searchStmt.all(searchPattern, searchPattern, limit) as {
        item_id: number;
        conversation_id: number;
        role: string;
        kind: string;
        text: string | null;
        created_at: number | null;
        title: string | null;
        provider: string;
      }[];

      const results = rows.map((r) => {
        let snippet = r.text ?? '';
        if (snippet.length > 200) {
          const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
          if (idx >= 0) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(snippet.length, idx + 120);
            snippet = (start > 0 ? '...' : '') + snippet.slice(start, end) + (end < snippet.length ? '...' : '');
          } else {
            snippet = snippet.slice(0, 160) + '...';
          }
        }
        return {
          item_id: r.item_id,
          conversation_id: r.conversation_id,
          provider: r.provider,
          title: r.title ?? 'Untitled',
          role: r.role,
          kind: r.kind,
          snippet,
          created_at: r.created_at,
        };
      });

      sendJson(res, 200, {
        query: q,
        count: results.length,
        results,
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /api/batches
    // ─────────────────────────────────────────────────────────────
    if (pathname === '/api/batches' && req.method === 'GET') {
      const batchesStmt = db.prepare(`
        SELECT id, provider, adapter_id, adapter_version, account_id, kind,
               source_path, source_sha256, exported_at, imported_at, status,
               stats_json, report_json
        FROM import_batch
        ORDER BY imported_at DESC
      `);
      const batches = batchesStmt.all() as unknown as ImportBatchRow[];

      const parsedBatches = batches.map((b) => ({
        ...b,
        stats: b.stats_json ? safeJsonParse(b.stats_json) : null,
        report: b.report_json ? safeJsonParse(b.report_json) : null,
      }));

      sendJson(res, 200, { batches: parsedBatches });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /api/batches/:id
    // ─────────────────────────────────────────────────────────────
    const batchDetailMatch = pathname.match(/^\/api\/batches\/(\d+)$/);
    if (batchDetailMatch && req.method === 'GET') {
      const batchId = parseInt(batchDetailMatch[1] ?? '0', 10);
      const batchStmt = db.prepare(`
        SELECT * FROM import_batch WHERE id = ?
      `);
      const batch = batchStmt.get(batchId) as ImportBatchRow | undefined;

      if (!batch) {
        sendError(res, 404, `Batch #${batchId} not found`);
        return;
      }

      sendJson(res, 200, {
        batch: {
          ...batch,
          stats: batch.stats_json ? safeJsonParse(batch.stats_json) : null,
          report: batch.report_json ? safeJsonParse(batch.report_json) : null,
        },
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Route: GET /blobs/:sha256
    // ─────────────────────────────────────────────────────────────
    const blobMatch = pathname.match(/^\/blobs\/([a-fA-F0-9]{64})$/);
    if (blobMatch && req.method === 'GET') {
      const sha256 = (blobMatch[1] ?? '').toLowerCase();

      const blobStmt = db.prepare(`SELECT * FROM blob WHERE sha256 = ?`);
      const blobInfo = blobStmt.get(sha256) as BlobRow | undefined;

      // Locate blob file: check rel_path or prefix directory
      let targetFile: string | null = null;
      if (blobInfo && blobInfo.rel_path) {
        const candidate = path.resolve(baseDir, blobInfo.rel_path);
        if (fs.existsSync(candidate)) targetFile = candidate;
      }

      if (!targetFile) {
        const prefix = sha256.slice(0, 2);
        const candidate = path.join(blobsDir, prefix, sha256);
        if (fs.existsSync(candidate)) {
          targetFile = candidate;
        } else {
          // Check without prefix
          const direct = path.join(blobsDir, sha256);
          if (fs.existsSync(direct)) targetFile = direct;
        }
      }

      if (!targetFile || !fs.existsSync(targetFile)) {
        sendError(res, 404, `Blob with SHA-256 ${sha256} not found`);
        return;
      }

      const stat = fs.statSync(targetFile);
      const mimeType = blobInfo?.mime ?? 'application/octet-stream';
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        // Range request support for audio / video streaming
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const part0 = parts[0];
        const part1 = parts[1];
        const start = part0 ? parseInt(part0, 10) : 0;
        const end = part1 ? parseInt(part1, 10) : stat.size - 1;
        const chunksize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
          'ETag': `"${sha256}"`,
        });

        const stream = fs.createReadStream(targetFile, { start, end });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
          'ETag': `"${sha256}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        const stream = fs.createReadStream(targetFile);
        stream.pipe(res);
      }
      return;
    }

    // Default 404
    sendError(res, 404, `Route not found: ${req.method ?? 'GET'} ${pathname}`);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({
        server,
        port: boundPort,
        token,
        dbPath,
        close: async () => {
          return new Promise<void>((resClose) => {
            server.close(() => {
              try {
                db.close();
              } catch {
                // ignore close error
              }
              resClose();
            });
          });
        },
      });
    });
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone runner execution when called directly
// ─────────────────────────────────────────────────────────────────────────────
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] ?? '').toLowerCase().endsWith(path.join('apps', 'server', 'dist', 'index.js').toLowerCase());

if (isMain) {
  const argv = process.argv.slice(2);
  let port = 0;
  let token: string | undefined;
  let dbPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const next = argv[++i];
      if (next) port = parseInt(next, 10);
    } else if (a === '--token') {
      token = argv[++i];
    } else if (a === '--db') {
      dbPath = argv[++i];
    }
  }

  startLocalServer({ port, token, dbPath })
    .then((running) => {
      // Machine-parseable ready signature for ui-win and CLI
      console.log(`SM_SERVER_READY port=${running.port} token=${running.token} db=${running.dbPath}`);
      console.log(`Session Manager local HTTP server listening on http://127.0.0.1:${running.port}`);
    })
    .catch((err: Error) => {
      console.error(`Failed to start Session Manager server: ${err.message}`);
      process.exit(1);
    });
}
