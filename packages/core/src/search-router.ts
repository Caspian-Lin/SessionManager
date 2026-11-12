import { classifySearchQuery } from '@sm/shared';

export interface SearchSqlPlan {
  originalQuery: string;
  strategy: 'empty' | 'like' | 'tri' | 'uni' | 'mixed';
  targetTables: ('item' | 'item_fts_uni' | 'item_fts_tri')[];
  sql: string;
  params: unknown[];
  explanation: string;
}

/**
 * Escapes FTS5 special operators (", *, +, -, OR, AND, NOT) for safe query matching.
 */
export function escapeFts5Query(query: string): string {
  const sanitized = query.replace(/[^\p{L}\p{N}\s_]/gu, ' ').trim();
  const tokens = sanitized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' ');
}

/**
 * Routes search queries across SQLite indexes according to query language and length:
 * - 1-2 char CJK queries -> `LIKE '%term%'`
 * - >= 3 char CJK queries -> `item_fts_tri` (trigram)
 * - Pure Latin / alphanumeric -> `item_fts_uni` (unicode61 + porter stemmer)
 * - Mixed language queries -> Union of `item_fts_uni` and `item_fts_tri` with BM25 rank fusion
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
    return {
      originalQuery: query,
      strategy: 'like',
      targetTables: ['item'],
      sql: `SELECT id, conversation_id, role, kind, text, ordinal, created_at FROM item WHERE text LIKE ? ORDER BY id DESC LIMIT 50`,
      params: [`%${trimmed}%`],
      explanation: 'Short CJK query (<3 chars) routed to LIKE operator for substring recall',
    };
  }

  if (kind === 'cjk_trigram') {
    const ftsQuery = escapeFts5Query(trimmed);
    return {
      originalQuery: query,
      strategy: 'tri',
      targetTables: ['item_fts_tri'],
      sql: `SELECT i.id, i.conversation_id, i.role, i.kind, i.text, i.ordinal, i.created_at, bm25(item_fts_tri) AS rank FROM item_fts_tri f JOIN item i ON f.rowid = i.id WHERE item_fts_tri MATCH ? ORDER BY rank LIMIT 50`,
      params: [ftsQuery],
      explanation: 'CJK query (>=3 chars) routed to item_fts_tri (trigram tokenizer)',
    };
  }

  if (kind === 'latin') {
    const ftsQuery = escapeFts5Query(trimmed);
    return {
      originalQuery: query,
      strategy: 'uni',
      targetTables: ['item_fts_uni'],
      sql: `SELECT i.id, i.conversation_id, i.role, i.kind, i.text, i.ordinal, i.created_at, bm25(item_fts_uni) AS rank FROM item_fts_uni f JOIN item i ON f.rowid = i.id WHERE item_fts_uni MATCH ? ORDER BY rank LIMIT 50`,
      params: [ftsQuery],
      explanation: 'Latin query routed to item_fts_uni (unicode61 + porter stemmer)',
    };
  }

  // Mixed query: Union both FTS tables
  const ftsQuery = escapeFts5Query(trimmed);
  return {
    originalQuery: query,
    strategy: 'mixed',
    targetTables: ['item_fts_uni', 'item_fts_tri'],
    sql: `SELECT i.id, i.conversation_id, i.role, i.kind, i.text, i.ordinal, i.created_at, MIN(u.rank) AS rank FROM (SELECT rowid, bm25(item_fts_uni) AS rank FROM item_fts_uni WHERE item_fts_uni MATCH ? UNION ALL SELECT rowid, bm25(item_fts_tri) AS rank FROM item_fts_tri WHERE item_fts_tri MATCH ?) u JOIN item i ON u.rowid = i.id GROUP BY i.id ORDER BY rank LIMIT 50`,
    params: [ftsQuery, ftsQuery],
    explanation: 'Mixed query routed to union of item_fts_uni and item_fts_tri with rank fusion',
  };
}
