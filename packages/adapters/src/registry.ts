import type { ProviderId } from '@sm/shared';
import { anthropicWebAdapter } from './anthropic-web/index.js';
import { claudeCodeLocalAdapter } from './claude-code-local/index.js';
import { codexLocalAdapter } from './codex-local/index.js';
import type { Adapter, ProbeResult, SourceRef } from './contract.js';
import { deepseekWebAdapter } from './deepseek-web/index.js';
import { dshLocalAdapter } from './dsh-local/index.js';
import { genericJsonAdapter, genericMdAdapter } from './generic/index.js';
import { openaiWebAdapter } from './openai-web/index.js';
import { opencodeLocalAdapter } from './opencode-local/index.js';
import { smNativeAdapter } from './sm-native/index.js';
import { zcodeLocalAdapter } from './zcode-local/index.js';

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, Adapter>();

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.register(smNativeAdapter);
      this.register(openaiWebAdapter);
      this.register(anthropicWebAdapter);
      this.register(deepseekWebAdapter);
      this.register(codexLocalAdapter);
      this.register(claudeCodeLocalAdapter);
      this.register(dshLocalAdapter);
      this.register(zcodeLocalAdapter);
      this.register(opencodeLocalAdapter);
      this.register(genericJsonAdapter);
      this.register(genericMdAdapter);
    }
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): Adapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly Adapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Executes probe against all registered adapters and returns matching ProbeResults
   * sorted by confidence in descending order.
   */
  async probeSource(src: SourceRef): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];

    for (const adapter of this.adapters.values()) {
      try {
        const res = await adapter.probe(src);
        if (res && res.confidence > 0) {
          results.push(res);
        }
      } catch {
        // Probe errors from one adapter shouldn't block other adapters
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }
}

export const defaultAdapterRegistry = new AdapterRegistry();
