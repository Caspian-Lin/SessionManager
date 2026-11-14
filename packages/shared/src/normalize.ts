/**
 * Deterministic, meaning-preserving text normalization for semantic hashing & deduplication.
 *
 * Rules:
 * 1. \r\n and \r -> \n; strip trailing horizontal whitespace on each line
 * 2. Collapse consecutive blank lines (>=3 newlines -> 2 newlines)
 * 3. Strip ANSI escape sequences (terminal colors / cursor controls)
 * 4. Unicode NFC normalization; convert fullwidth space (\u3000) to ASCII space
 * 5. Strip volatile leading timestamp prefixes (e.g. "[2026-11-13 02:00:00]", "当前时间: ...", "Current time: ...")
 *
 * Explicitly NOT done: path rewriting, number stripping, truncation, or translation.
 */

// Matches CSI and OSC ANSI escape codes
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

// Matches volatile leading lines injected by wrappers/prompts
const VOLATILE_PREFIX_LINE_RE =
  /^(?:\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]\s*|(?:当前时间|Current\s+time|Current\s+date)\s*[:：]\s*\d{4}[-/]\d{2}[-/]\d{2}[^\n]*\n?)/i;

export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';

  // 1. Unicode NFC + fullwidth space -> ASCII space
  let text = input.normalize('NFC').replace(/\u3000/g, ' ');

  // 2. Strip ANSI escape sequences
  text = text.replace(ANSI_ESCAPE_RE, '');

  // 3. Normalize line endings (\r\n, \r -> \n) and strip trailing spaces per line
  text = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');

  // 4. Strip volatile leading timestamp prefixes
  text = text.replace(VOLATILE_PREFIX_LINE_RE, '');

  // 5. Collapse >= 3 consecutive newlines into 2 newlines (single blank line) and trim outer whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
