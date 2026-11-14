import type { DatabaseSync } from 'node:sqlite';
import { classifySearchQuery, containsCjk, type SessionRole } from '@sm/shared';
import type { ArchiveDatabase } from '@sm/store';

export type SearchDatabase = ArchiveDatabase | DatabaseSync;

export interface SearchSqlPlan {
  originalQuery: string;
  strategy: 'empty' | 'like' | 'tri' | 'uni' | 'mixed';
  targetTables: ('item' | 'item_fts_uni' | 'item_fts_tri' | 'conv_fts_tri')[];
  sql: string;
  params: unknown[];
  explanation: string;
}

export interface ArchiveSearchOptions {
  limit?: number;
  offset?: number;
  provider?: string;
  role?: SessionRole | string;
  includeHidden?: boolean;
  includeSynthetic?: boolean;
  downweightSynthetic?: boolean;
  nowMs?: number;
}

export type SearchMatchSource =
  | 'item_fts_uni'
  | 'item_fts_tri'
  | 'conv_fts_tri'
  | 'like'
  | 'mixed';

export interface ArchiveSearchHit {
  item_id: number;
  conversation_id: number;
  conversation_title: string | null;
  provider: string;
  role: string;
  kind: string;
  tool_name: string | null;
  text: string | null;
  ordinal: number;
  created_at: number | null;
  is_synthetic: boolean;
  is_hidden: boolean;
  match_source: SearchMatchSource;
  bm25_raw: number;
  score: number;
  snippet: string;
}

export interface ArchiveSearchResult {
  query: string;
  strategy: SearchSqlPlan['strategy'];
  total: number;
  hits: ArchiveSearchHit[];
}

interface RawSearchCandidateRow {
  item_id: number;
  conversation_id: number;
  conversation_title: string | null;
  provider: string;
  role: string;
  kind: string;
  tool_name: string | null;
  text: string | null;
  ordinal: number;
  created_at: number | null;
  is_synthetic: number;
  is_hidden: number;
  bm25_raw: number;
}

interface PartitionedTokens {
  latinTokens: string[];
  cjkTrigramTerms: string[];
  cjkShortTerms: string[];
}

const CJK_RUN_REGEX =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/gu;
const LATIN_TOKEN_REGEX = /[a-zA-Z0-9_]+/gu;

/**
 * Escapes FTS5 special operators (", *, +, -, OR, AND, NOT) for safe query matching.
 */
export function escapeFts5Query(query: string): string {
  const sanitized = query.replace(/[^\p{L}\p{N}\s_]/gu, ' ').trim();
  const tokens = sanitized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function escapeFts5Tokens(tokens: readonly string[]): string {
  const cleaned = tokens
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '').trim())
    .filter(Boolean);
  if (cleaned.length === 0) return '""';
  return cleaned.map((t) => `"${t}"`).join(' ');
}

function escapeLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Separates a query string into Latin tokens, >=3-char CJK runs (suitable for trigram FTS5),
 * and 1-2-char CJK runs (must use bounded LIKE because FTS5 trigram skips <3-char tokens).
 */
export function partitionSearchTokens(query: string): PartitionedTokens {
  const latinTokens: string[] = [];
  const cjkTrigramTerms: string[] = [];
  const cjkShortTerms: string[] = [];

  const cjkMatches = query.match(CJK_RUN_REGEX) ?? [];
  for (const run of cjkMatches) {
    const trimmed = run.trim();
    if (!trimmed) continue;
    if ([...trimmed].length >= 3) {
      cjkTrigramTerms.push(trimmed);
    } else {
      cjkShortTerms.push(trimmed);
    }
  }

  const withoutCjk = query.replace(CJK_RUN_REGEX, ' ');
  const latinMatches = withoutCjk.match(LATIN_TOKEN_REGEX) ?? [];
  for (const tok of latinMatches) {
    if (tok.trim()) {
      latinTokens.push(tok.trim());
    }
  }

  return { latinTokens, cjkTrigramTerms, cjkShortTerms };
}

/**
 * Routes search queries across SQLite indexes according to query language and length:
 * - 1-2 char CJK queries -> bounded `LIKE '%term%'`
 * - >= 3 char CJK queries -> `item_fts_tri` + `conv_fts_tri` (trigram)
 * - Pure Latin / alphanumeric -> `item_fts_uni` (unicode61 over text + tool_name)
 * - Mixed language queries -> Union of `item_fts_uni` and `item_fts_tri` / `conv_fts_tri` / `LIKE`
 */
export function buildSearchSqlPlan(query: string): SearchSqlPlan {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      originalQuery: query,
      strategy: 'empty',
      targetTables: [],
      sql: '',
      params: [],
      explanation: 'Empty query',
    };
  }

  const kind = classifySearchQuery(trimmed);

  if (kind === 'cjk_short') {
    const likePattern = escapeLikePattern(trimmed);
    return {
      originalQuery: query,
      strategy: 'like',
      targetTables: ['item'],
      sql: `SELECT i.id AS item_id, i.conversation_id, c.title AS conversation_title, c.provider, i.role, i.kind, i.tool_name, i.text, i.ordinal, COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at, i.is_synthetic, i.is_hidden FROM item i JOIN conversation c ON i.conversation_id = c.id WHERE c.deleted_at IS NULL AND (i.text LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\') ORDER BY COALESCE(i.created_at, c.updated_at, 0) DESC, i.id DESC LIMIT 50`,
      params: [likePattern, likePattern],
      explanation: 'Short CJK query (<3 chars) routed to bounded LIKE operator for substring recall',
    };
  }

  if (kind === 'cjk_trigram') {
    const ftsQuery = escapeFts5Query(trimmed);
    return {
      originalQuery: query,
      strategy: 'tri',
      targetTables: ['item_fts_tri', 'conv_fts_tri'],
      sql: `SELECT i.id AS item_id, i.conversation_id, c.title AS conversation_title, c.provider, i.role, i.kind, i.tool_name, i.text, i.ordinal, COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at, i.is_synthetic, i.is_hidden, bm25(item_fts_tri) AS rank FROM item_fts_tri f JOIN item i ON f.rowid = i.id JOIN conversation c ON i.conversation_id = c.id WHERE item_fts_tri MATCH ? AND c.deleted_at IS NULL ORDER BY rank LIMIT 50`,
      params: [ftsQuery],
      explanation: 'CJK query (>=3 chars) routed to item_fts_tri and conv_fts_tri (trigram tokenizer)',
    };
  }

  if (kind === 'latin') {
    const ftsQuery = escapeFts5Query(trimmed);
    return {
      originalQuery: query,
      strategy: 'uni',
      targetTables: ['item_fts_uni'],
      sql: `SELECT i.id AS item_id, i.conversation_id, c.title AS conversation_title, c.provider, i.role, i.kind, i.tool_name, i.text, i.ordinal, COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at, i.is_synthetic, i.is_hidden, bm25(item_fts_uni) AS rank FROM item_fts_uni f JOIN item i ON f.rowid = i.id JOIN conversation c ON i.conversation_id = c.id WHERE item_fts_uni MATCH ? AND c.deleted_at IS NULL ORDER BY rank LIMIT 50`,
      params: [ftsQuery],
      explanation: 'Latin query routed to item_fts_uni (unicode61 over text + tool_name)',
    };
  }

  // Mixed query: Union across item_fts_uni (Latin tokens) and item_fts_tri / LIKE (CJK tokens)
  const parts = partitionSearchTokens(trimmed);
  const uniQuery = parts.latinTokens.length > 0 ? escapeFts5Tokens(parts.latinTokens) : escapeFts5Query(trimmed);
  const triQuery =
    parts.cjkTrigramTerms.length > 0 ? escapeFts5Tokens(parts.cjkTrigramTerms) : escapeFts5Query(trimmed);

  if (parts.cjkTrigramTerms.length === 0 && parts.cjkShortTerms.length > 0) {
    const shortPattern = escapeLikePattern(parts.cjkShortTerms[0]!);
    return {
      originalQuery: query,
      strategy: 'mixed',
      targetTables: ['item_fts_uni', 'item'],
      sql: `SELECT i.id AS item_id, i.conversation_id, c.title AS conversation_title, c.provider, i.role, i.kind, i.tool_name, i.text, i.ordinal, COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at, i.is_synthetic, i.is_hidden, MIN(u.rank) AS rank FROM (SELECT rowid, bm25(item_fts_uni) AS rank FROM item_fts_uni WHERE item_fts_uni MATCH ? UNION ALL SELECT i2.id AS rowid, -0.5 AS rank FROM item i2 WHERE i2.text LIKE ? ESCAPE '\\' LIMIT 100) u JOIN item i ON u.rowid = i.id JOIN conversation c ON i.conversation_id = c.id WHERE c.deleted_at IS NULL GROUP BY i.id ORDER BY rank LIMIT 50`,
      params: [uniQuery, shortPattern],
      explanation: 'Mixed query (Latin + short CJK) routed to item_fts_uni + bounded LIKE fusion',
    };
  }

  return {
    originalQuery: query,
    strategy: 'mixed',
    targetTables: ['item_fts_uni', 'item_fts_tri', 'conv_fts_tri'],
    sql: `SELECT i.id AS item_id, i.conversation_id, c.title AS conversation_title, c.provider, i.role, i.kind, i.tool_name, i.text, i.ordinal, COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at, i.is_synthetic, i.is_hidden, MIN(u.rank) AS rank FROM (SELECT rowid, bm25(item_fts_uni) AS rank FROM item_fts_uni WHERE item_fts_uni MATCH ? UNION ALL SELECT rowid, bm25(item_fts_tri) AS rank FROM item_fts_tri WHERE item_fts_tri MATCH ?) u JOIN item i ON u.rowid = i.id JOIN conversation c ON i.conversation_id = c.id WHERE c.deleted_at IS NULL GROUP BY i.id ORDER BY rank LIMIT 50`,
    params: [uniQuery, triQuery],
    explanation: 'Mixed query routed to union of item_fts_uni and item_fts_tri/conv_fts_tri with rank fusion',
  };
}

/**
 * Computes weighted search score combining BM25 relevance (-bm25), user role boost (+0.15),
 * recency decay (+0.1 * decay), and default downweighting of synthetic turns.
 */
export function computeWeightedSearchScore(params: {
  bm25Raw: number;
  role: string;
  createdAt: number | null;
  isSynthetic: boolean;
  downweightSynthetic: boolean;
  nowMs: number;
  titleBonus?: number;
  multiSourceCount?: number;
}): number {
  const bm25Relevance = Math.max(0, -params.bm25Raw);
  const roleBoost = params.role === 'user' ? 1 : 0;
  let recencyDecay = 0;
  if (params.createdAt != null && params.createdAt > 0) {
    const ageDays = Math.max(0, (params.nowMs - params.createdAt) / 86_400_000);
    recencyDecay = 1 / (1 + ageDays / 30);
  }

  const multiBoost =
    (params.multiSourceCount ?? 1) > 1 ? 0.25 * ((params.multiSourceCount ?? 1) - 1) : 0;

  const baseScore =
    bm25Relevance +
    (params.titleBonus ?? 0) +
    0.15 * roleBoost +
    0.1 * recencyDecay +
    multiBoost;

  if (params.isSynthetic && params.downweightSynthetic) {
    return baseScore * 0.2 - 0.5;
  }
  return baseScore;
}

function buildFilterClauses(
  options: ArchiveSearchOptions,
  itemAlias: string,
  convAlias: string
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [`${convAlias}.deleted_at IS NULL`];
  const params: unknown[] = [];

  if (options.provider !== undefined) {
    clauses.push(`${convAlias}.provider = ?`);
    params.push(options.provider);
  }
  if (options.role !== undefined) {
    clauses.push(`${itemAlias}.role = ?`);
    params.push(options.role);
  }
  if (options.includeSynthetic === false) {
    clauses.push(`${itemAlias}.is_synthetic = 0`);
  }
  if (options.includeHidden === false) {
    clauses.push(`${itemAlias}.is_hidden = 0`);
  }

  return { clauses, params };
}

function buildSnippet(text: string | null, query: string): string {
  if (!text) return '';
  if (text.length <= 200) return text;

  const lowerText = text.toLowerCase();
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let matchIdx = lowerText.indexOf(query.trim().toLowerCase());
  if (matchIdx < 0) {
    for (const term of terms) {
      const idx = lowerText.indexOf(term.toLowerCase());
      if (idx >= 0) {
        matchIdx = idx;
        break;
      }
    }
  }

  if (matchIdx < 0) {
    return `${text.slice(0, 160)}...`;
  }
  const start = Math.max(0, matchIdx - 40);
  const end = Math.min(text.length, matchIdx + 120);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

interface CandidateAccumulator {
  row: RawSearchCandidateRow;
  sources: Set<SearchMatchSource>;
  bestBm25: number;
  titleBonus: number;
}

function addCandidate(
  map: Map<string, CandidateAccumulator>,
  row: RawSearchCandidateRow,
  source: SearchMatchSource,
  titleBonus = 0
): void {
  const key = `${row.conversation_id}:${row.item_id}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      row,
      sources: new Set([source]),
      bestBm25: row.bm25_raw,
      titleBonus,
    });
    return;
  }
  existing.sources.add(source);
  if (row.bm25_raw < existing.bestBm25) {
    existing.bestBm25 = row.bm25_raw;
  }
  if (titleBonus > existing.titleBonus) {
    existing.titleBonus = titleBonus;
  }
}

function queryItemFtsUni(
  db: SearchDatabase,
  ftsQuery: string,
  options: ArchiveSearchOptions,
  candidateLimit: number
): RawSearchCandidateRow[] {
  if (ftsQuery === '""') return [];
  const { clauses, params } = buildFilterClauses(options, 'i', 'c');
  const sql = `
    SELECT
      i.id AS item_id,
      i.conversation_id,
      c.title AS conversation_title,
      c.provider,
      i.role,
      i.kind,
      i.tool_name,
      i.text,
      i.ordinal,
      COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at,
      i.is_synthetic,
      i.is_hidden,
      bm25(item_fts_uni) AS bm25_raw
    FROM item_fts_uni f
    JOIN item i ON f.rowid = i.id
    JOIN conversation c ON i.conversation_id = c.id
    WHERE item_fts_uni MATCH ? AND ${clauses.join(' AND ')}
    ORDER BY bm25_raw ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(ftsQuery, ...params, candidateLimit) as unknown as RawSearchCandidateRow[];
}

function queryItemFtsTri(
  db: SearchDatabase,
  ftsQuery: string,
  options: ArchiveSearchOptions,
  candidateLimit: number
): RawSearchCandidateRow[] {
  if (ftsQuery === '""') return [];
  const { clauses, params } = buildFilterClauses(options, 'i', 'c');
  const sql = `
    SELECT
      i.id AS item_id,
      i.conversation_id,
      c.title AS conversation_title,
      c.provider,
      i.role,
      i.kind,
      i.tool_name,
      i.text,
      i.ordinal,
      COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at,
      i.is_synthetic,
      i.is_hidden,
      bm25(item_fts_tri) AS bm25_raw
    FROM item_fts_tri f
    JOIN item i ON f.rowid = i.id
    JOIN conversation c ON i.conversation_id = c.id
    WHERE item_fts_tri MATCH ? AND ${clauses.join(' AND ')}
    ORDER BY bm25_raw ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(ftsQuery, ...params, candidateLimit) as unknown as RawSearchCandidateRow[];
}

function queryConvFtsTri(
  db: SearchDatabase,
  ftsQuery: string,
  options: ArchiveSearchOptions,
  candidateLimit: number
): RawSearchCandidateRow[] {
  if (ftsQuery === '""') return [];
  const convClauses: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [ftsQuery];

  if (options.provider !== undefined) {
    convClauses.push('c.provider = ?');
    params.push(options.provider);
  }
  if (options.role !== undefined) {
    convClauses.push('i.role = ?');
    params.push(options.role);
  }
  if (options.includeSynthetic === false) {
    convClauses.push('COALESCE(i.is_synthetic, 0) = 0');
  }
  if (options.includeHidden === false) {
    convClauses.push('COALESCE(i.is_hidden, 0) = 0');
  }

  const sql = `
    SELECT
      COALESCE(i.id, 0) AS item_id,
      c.id AS conversation_id,
      c.title AS conversation_title,
      c.provider,
      COALESCE(i.role, 'system') AS role,
      COALESCE(i.kind, 'message') AS kind,
      i.tool_name,
      COALESCE(i.text, c.title) AS text,
      COALESCE(i.ordinal, 0) AS ordinal,
      COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at,
      COALESCE(i.is_synthetic, 0) AS is_synthetic,
      COALESCE(i.is_hidden, 0) AS is_hidden,
      bm25(conv_fts_tri) AS bm25_raw
    FROM conv_fts_tri f
    JOIN conversation c ON f.rowid = c.id
    LEFT JOIN item i ON i.id = (
      SELECT i2.id FROM item i2
      WHERE i2.conversation_id = c.id AND i2.is_active_branch = 1
      ORDER BY i2.is_synthetic ASC, i2.ordinal ASC, i2.id ASC
      LIMIT 1
    )
    WHERE conv_fts_tri MATCH ? AND ${convClauses.join(' AND ')}
    ORDER BY bm25_raw ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, candidateLimit) as unknown as RawSearchCandidateRow[];
}

function queryBoundedLike(
  db: SearchDatabase,
  term: string,
  options: ArchiveSearchOptions,
  candidateLimit: number
): RawSearchCandidateRow[] {
  const pattern = escapeLikePattern(term);
  const { clauses, params } = buildFilterClauses(options, 'i', 'c');
  const sql = `
    SELECT
      i.id AS item_id,
      i.conversation_id,
      c.title AS conversation_title,
      c.provider,
      i.role,
      i.kind,
      i.tool_name,
      i.text,
      i.ordinal,
      COALESCE(i.created_at, c.updated_at, c.created_at) AS created_at,
      i.is_synthetic,
      i.is_hidden,
      CASE
        WHEN i.text LIKE ? ESCAPE '\\' THEN -0.6
        ELSE -0.35
      END AS bm25_raw
    FROM item i
    JOIN conversation c ON i.conversation_id = c.id
    WHERE ${clauses.join(' AND ')}
      AND (i.text LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')
    ORDER BY COALESCE(i.created_at, c.updated_at, 0) DESC, i.id DESC
    LIMIT ?
  `;
  return db
    .prepare(sql)
    .all(pattern, ...params, pattern, pattern, candidateLimit) as unknown as RawSearchCandidateRow[];
}

/**
 * Executes dual-index FTS5 search against SQLite using `buildSearchSqlPlan` routing
 * and weighted BM25 ranking (`-bm25 + 0.15 * role_boost(user) + 0.1 * recency_decay`,
 * downweighting `is_synthetic = 1` by default).
 */
export function executeArchiveSearch(
  db: SearchDatabase,
  query: string,
  options: ArchiveSearchOptions = {}
): ArchiveSearchResult {
  const plan = buildSearchSqlPlan(query);
  if (plan.strategy === 'empty') {
    return {
      query,
      strategy: 'empty',
      total: 0,
      hits: [],
    };
  }

  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);
  const candidateLimit = Math.min(Math.max((limit + offset) * 4, 200), 1000);
  const downweightSynthetic = options.downweightSynthetic !== false;
  const nowMs = options.nowMs ?? Date.now();

  const candidates = new Map<string, CandidateAccumulator>();
  const trimmed = query.trim();

  if (plan.strategy === 'uni') {
    const ftsQuery = escapeFts5Query(trimmed);
    for (const row of queryItemFtsUni(db, ftsQuery, options, candidateLimit)) {
      addCandidate(candidates, row, 'item_fts_uni');
    }
  } else if (plan.strategy === 'tri') {
    const ftsQuery = escapeFts5Query(trimmed);
    for (const row of queryItemFtsTri(db, ftsQuery, options, candidateLimit)) {
      addCandidate(candidates, row, 'item_fts_tri');
    }
    for (const row of queryConvFtsTri(db, ftsQuery, options, candidateLimit)) {
      addCandidate(candidates, row, 'conv_fts_tri', 0.25);
    }
  } else if (plan.strategy === 'like') {
    for (const row of queryBoundedLike(db, trimmed, options, candidateLimit)) {
      const titleBonus =
        row.conversation_title && row.conversation_title.includes(trimmed) ? 0.1 : 0;
      addCandidate(candidates, row, 'like', titleBonus);
    }
  } else {
    // Mixed query: union fusion across Latin (item_fts_uni), >=3-char CJK (item_fts_tri + conv_fts_tri),
    // and <3-char CJK (bounded LIKE). Never pass <3-char tokens to trigram FTS5.
    const parts = partitionSearchTokens(trimmed);
    if (parts.latinTokens.length > 0) {
      const uniQuery = escapeFts5Tokens(parts.latinTokens);
      for (const row of queryItemFtsUni(db, uniQuery, options, candidateLimit)) {
        addCandidate(candidates, row, 'item_fts_uni');
      }
    }
    if (parts.cjkTrigramTerms.length > 0) {
      const triQuery = escapeFts5Tokens(parts.cjkTrigramTerms);
      for (const row of queryItemFtsTri(db, triQuery, options, candidateLimit)) {
        addCandidate(candidates, row, 'item_fts_tri');
      }
      for (const row of queryConvFtsTri(db, triQuery, options, candidateLimit)) {
        addCandidate(candidates, row, 'conv_fts_tri', 0.2);
      }
    }
    for (const shortTerm of parts.cjkShortTerms) {
      for (const row of queryBoundedLike(db, shortTerm, options, candidateLimit)) {
        addCandidate(candidates, row, 'like');
      }
    }
    // Edge fallback if partition found nothing (e.g. non-standard Unicode scripts)
    if (
      parts.latinTokens.length === 0 &&
      parts.cjkTrigramTerms.length === 0 &&
      parts.cjkShortTerms.length === 0 &&
      containsCjk(trimmed)
    ) {
      for (const row of queryBoundedLike(db, trimmed, options, candidateLimit)) {
        addCandidate(candidates, row, 'like');
      }
    }
  }

  const scored: ArchiveSearchHit[] = [];
  for (const acc of candidates.values()) {
    const r = acc.row;
    const isSynthetic = r.is_synthetic === 1;
    const isHidden = r.is_hidden === 1;
    const matchSource: SearchMatchSource =
      acc.sources.size > 1 ? 'mixed' : ([...acc.sources][0] ?? 'like');

    const score = computeWeightedSearchScore({
      bm25Raw: acc.bestBm25,
      role: r.role,
      createdAt: r.created_at,
      isSynthetic,
      downweightSynthetic,
      nowMs,
      titleBonus: acc.titleBonus,
      multiSourceCount: acc.sources.size,
    });

    scored.push({
      item_id: r.item_id,
      conversation_id: r.conversation_id,
      conversation_title: r.conversation_title,
      provider: r.provider,
      role: r.role,
      kind: r.kind,
      tool_name: r.tool_name,
      text: r.text,
      ordinal: r.ordinal,
      created_at: r.created_at,
      is_synthetic: isSynthetic,
      is_hidden: isHidden,
      match_source: matchSource,
      bm25_raw: acc.bestBm25,
      score,
      snippet: buildSnippet(r.text, trimmed),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const timeA = a.created_at ?? 0;
    const timeB = b.created_at ?? 0;
    if (timeB !== timeA) return timeB - timeA;
    return b.item_id - a.item_id;
  });

  return {
    query,
    strategy: plan.strategy,
    total: scored.length,
    hits: scored.slice(offset, offset + limit),
  };
}
