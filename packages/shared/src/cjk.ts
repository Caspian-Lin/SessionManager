/**
 * CJK identification and search query classifier for SQLite FTS5 index selection.
 */

export type SearchQueryClassification = 'cjk_short' | 'cjk_trigram' | 'latin' | 'mixed';

const CJK_TEST_REGEX =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

const CJK_GLOBAL_REGEX =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu;

const LATIN_REGEX = /[a-zA-Z0-9\p{Script=Latin}]/u;

/**
 * Returns true if the query string contains any CJK (Han, Hiragana, Katakana, Hangul) characters.
 */
export function containsCjk(q: string): boolean {
  if (!q) {
    return false;
  }
  return CJK_TEST_REGEX.test(q);
}

/**
 * Classifies search queries into FTS5 index routing categories:
 * - 'cjk_short': CJK-only query with character count < 3 (below FTS5 trigram threshold)
 * - 'cjk_trigram': CJK-only query with character count >= 3 (matches item_fts_tri / conv_fts_tri)
 * - 'latin': Latin/alphanumeric query (matches item_fts_uni unicode61 tokenizer)
 * - 'mixed': Contains both CJK and Latin tokens
 */
export function classifySearchQuery(q: string): SearchQueryClassification {
  if (!q || !q.trim()) {
    return 'latin';
  }

  const cjkMatches = q.match(CJK_GLOBAL_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const hasLatin = LATIN_REGEX.test(q);
  const hasCjk = cjkCount > 0;

  if (hasCjk && hasLatin) {
    return 'mixed';
  }
  if (hasCjk) {
    return cjkCount >= 3 ? 'cjk_trigram' : 'cjk_short';
  }
  return 'latin';
}
