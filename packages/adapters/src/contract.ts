import type { OcaConversationDraft, OcaProviderId } from '@sm/oca';

export type SourceRef =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'sqlite'; path: string };

export interface ProbeResult {
  adapterId: string;
  version: string;
  confidence: number;
  evidence: string[];
  entries: string[];
  warnings: string[];
}

export interface ImportTask {
  id: string;
  src: SourceRef;
  entry?: string;
  range?: [number, number];
  estimatedBytes: number;
}

export interface ParseCtx {
  persistRaw(entry: string, bytes: Buffer | NodeJS.ReadableStream): Promise<{ sha256: string; path: string }>;
  streamArray<T>(src: NodeJS.ReadableStream): AsyncIterable<T>;
  spill(payload: unknown): Promise<string>;
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void;
  recordUnrecognizedField?(key: string): void;
}

export interface Adapter {
  readonly id: OcaProviderId;
  probe(src: SourceRef): Promise<ProbeResult | null>;
  plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask>;
  parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]>;
}

/**
 * Extracts vendor-specific or unknown fields into Level-3 `ext._unmapped` reservoir
 * for zero-loss schema drift recovery and notifies ParseCtx for field spike detection.
 */
export function partitionVendorFields<T extends Record<string, unknown>>(
  raw: T,
  knownKeys: readonly string[],
  ctx?: ParseCtx
): Record<string, unknown> | undefined {
  const knownSet = new Set(knownKeys);
  const unmapped: Record<string, unknown> = {};
  let hasUnmapped = false;

  for (const [key, value] of Object.entries(raw)) {
    if (!knownSet.has(key) && value !== undefined) {
      unmapped[key] = value;
      hasUnmapped = true;
      ctx?.recordUnrecognizedField?.(key);
    }
  }

  return hasUnmapped ? unmapped : undefined;
}
