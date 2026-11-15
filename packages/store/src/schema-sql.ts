/**
 * SQLite Schema definitions and FTS5 rebuild queries.
 * Embedded directly as TypeScript string constants to eliminate external asset copying during compilation.
 */

export const SCHEMA_001_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ── 元信息 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 账号与批次 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,
  label       TEXT,
  external_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account ON account(provider, IFNULL(external_id,''), IFNULL(label,''));

CREATE TABLE IF NOT EXISTS import_batch (
  id              INTEGER PRIMARY KEY,
  provider        TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  account_id      INTEGER REFERENCES account(id),
  kind            TEXT NOT NULL,
  source_path     TEXT,
  source_sha256   TEXT NOT NULL,
  exported_at     INTEGER,
  imported_at     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  stats_json      TEXT,
  report_json     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_batch ON import_batch(provider, kind, source_sha256);

CREATE TABLE IF NOT EXISTS import_file (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       INTEGER,
  role        TEXT,
  parsed_ok   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS ix_file_batch ON import_file(batch_id);
CREATE INDEX IF NOT EXISTS ix_file_sha   ON import_file(sha256);

-- ── 组织维度 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  provider    TEXT,
  external_id TEXT,
  root_path   TEXT,
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS conversation_tag (
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  tag_id          INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

-- ── 会话 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  account_id     INTEGER REFERENCES account(id),
  external_id    TEXT,
  title          TEXT,
  title_source   TEXT,
  summary        TEXT,
  created_at     INTEGER,
  updated_at     INTEGER,
  exported_at    INTEGER,
  default_model  TEXT,
  cwd            TEXT,
  project_id     INTEGER REFERENCES project(id),
  item_count     INTEGER NOT NULL DEFAULT 0,
  char_count     INTEGER NOT NULL DEFAULT 0,
  blob_count     INTEGER NOT NULL DEFAULT 0,
  head_hash       TEXT,
  content_hash    TEXT,
  fingerprint     TEXT,
  raw_format      TEXT,
  raw_blob_sha256 TEXT,
  revision_count  INTEGER NOT NULL DEFAULT 1,
  first_batch_id INTEGER REFERENCES import_batch(id),
  last_batch_id  INTEGER REFERENCES import_batch(id),
  starred        INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  deleted_at     INTEGER,
  flags_json     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conv_ext ON conversation(provider, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_conv_updated   ON conversation(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_conv_prov_time ON conversation(provider, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_head      ON conversation(head_hash);
CREATE INDEX IF NOT EXISTS ix_conv_project   ON conversation(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_deleted   ON conversation(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── 修订（同一会话多次导出/编辑的快照） ───────────────────
CREATE TABLE IF NOT EXISTS conversation_revision (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  batch_id        INTEGER REFERENCES import_batch(id),
  revision_no     INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  item_count      INTEGER,
  char_count      INTEGER,
  diff_json       TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(conversation_id, content_hash)
);

-- ── 轻量搜索与分支索引节点（正文与完整结构存原生切片） ──────
CREATE TABLE IF NOT EXISTS item (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  parent_id        INTEGER REFERENCES item(id) ON DELETE CASCADE,
  external_id      TEXT,
  ordinal          INTEGER NOT NULL,
  depth            INTEGER NOT NULL DEFAULT 0,
  role             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  created_at       INTEGER,
  model            TEXT,
  tool_name        TEXT,
  text             TEXT,
  text_len         INTEGER NOT NULL DEFAULT 0,
  blocks_json      TEXT,
  content_hash     TEXT NOT NULL,
  is_active_branch INTEGER NOT NULL DEFAULT 1,
  is_hidden        INTEGER NOT NULL DEFAULT 0,
  is_synthetic     INTEGER NOT NULL DEFAULT 0,
  status           TEXT,
  payload_ref      TEXT,
  flags_json       TEXT,
  UNIQUE(conversation_id, external_id)
);
CREATE INDEX IF NOT EXISTS ix_item_conv ON item(conversation_id, ordinal);
CREATE INDEX IF NOT EXISTS ix_item_cat  ON item(conversation_id, kind, ordinal);
CREATE INDEX IF NOT EXISTS ix_item_hash ON item(content_hash);
CREATE INDEX IF NOT EXISTS ix_item_role ON item(conversation_id, role) WHERE is_synthetic = 0;
CREATE INDEX IF NOT EXISTS ix_item_tool ON item(tool_name) WHERE tool_name IS NOT NULL;

-- ── 二进制与原生切片（内容寻址 → 天然去重） ──────────────────
CREATE TABLE IF NOT EXISTS blob (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  ext         TEXT,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  rel_path    TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_blob_mime ON blob(mime);

-- ── 查重候选 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dedupe_candidate (
  id         INTEGER PRIMARY KEY,
  a_id       INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  b_id       INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(a_id, b_id)
);
CREATE INDEX IF NOT EXISTS ix_dedupe_status ON dedupe_candidate(status, similarity DESC);

-- ── FTS5 虚拟表 ───────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS item_fts_uni USING fts5(
  text, tool_name, content='item', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS item_fts_tri USING fts5(
  text, content='item', content_rowid='id', tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts_tri USING fts5(
  title, content='conversation', content_rowid='id', tokenize='trigram'
);

-- ── FTS 同步触发器 ─────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS item_fts_uni_ai AFTER INSERT ON item BEGIN
  INSERT INTO item_fts_uni(rowid, text, tool_name)
    VALUES (new.id, new.text, new.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_uni_ad AFTER DELETE ON item BEGIN
  INSERT INTO item_fts_uni(item_fts_uni, rowid, text, tool_name)
    VALUES ('delete', old.id, old.text, old.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_uni_au AFTER UPDATE OF text, tool_name ON item BEGIN
  INSERT INTO item_fts_uni(item_fts_uni, rowid, text, tool_name)
    VALUES ('delete', old.id, old.text, old.tool_name);
  INSERT INTO item_fts_uni(rowid, text, tool_name)
    VALUES (new.id, new.text, new.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_tri_ai AFTER INSERT ON item BEGIN
  INSERT INTO item_fts_tri(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_tri_ad AFTER DELETE ON item BEGIN
  INSERT INTO item_fts_tri(item_fts_tri, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_tri_au AFTER UPDATE OF text ON item BEGIN
  INSERT INTO item_fts_tri(item_fts_tri, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO item_fts_tri(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS conv_fts_tri_ai AFTER INSERT ON conversation BEGIN
  INSERT INTO conv_fts_tri(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS conv_fts_tri_ad AFTER DELETE ON conversation BEGIN
  INSERT INTO conv_fts_tri(conv_fts_tri, rowid, title) VALUES ('delete', old.id, old.title);
END;

CREATE TRIGGER IF NOT EXISTS conv_fts_tri_au AFTER UPDATE OF title ON conversation BEGIN
  INSERT INTO conv_fts_tri(conv_fts_tri, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO conv_fts_tri(rowid, title) VALUES (new.id, new.title);
END;
`.trim();

export const FTS_REBUILD_SQL = `
INSERT INTO item_fts_uni(item_fts_uni) VALUES('rebuild');
INSERT INTO item_fts_tri(item_fts_tri) VALUES('rebuild');
INSERT INTO conv_fts_tri(conv_fts_tri) VALUES('rebuild');
`.trim();
