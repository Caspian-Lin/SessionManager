export interface KeyFrequencyInfo {
  count: number;
  types: string[];
}

export interface SchemaSummary {
  candidateRoleKeys: string[];
  candidateContentKeys: string[];
  keyFrequency: Record<string, KeyFrequencyInfo>;
}

const ROLE_KEY_RE = /^(?:role|sender|author|speaker|from|user_type|sender_role|author_role)$/i;
const ROLE_VAL_RE = /^(?:user|assistant|human|system|bot|ai|agent|tool|developer|model)$/i;
const CONTENT_KEY_RE = /^(?:content|text|message|body|parts|utterance|content_text|prompt|response)$/i;

function determineValueType(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

/**
 * Derives structural metadata (key frequencies, type distributions, candidate role and content keys)
 * from arbitrary JSON items without storing or leaking sensitive conversation text.
 */
export function learnJsonSchemaSummary(sampleItems: unknown[]): SchemaSummary {
  const keyFrequency: Record<string, KeyFrequencyInfo> = {};
  const candidateRoleKeys = new Set<string>();
  const candidateContentKeys = new Set<string>();

  const inspectObject = (obj: Record<string, unknown>) => {
    for (const [key, val] of Object.entries(obj)) {
      const typeStr = determineValueType(val);
      let info = keyFrequency[key];
      if (!info) {
        info = { count: 0, types: [] };
        keyFrequency[key] = info;
      }
      info.count++;
      if (!info.types.includes(typeStr)) {
        info.types.push(typeStr);
      }

      // Role key heuristics
      if (ROLE_KEY_RE.test(key) || (typeof val === 'string' && ROLE_VAL_RE.test(val.trim()))) {
        candidateRoleKeys.add(key);
      }

      // Content key heuristics
      if (CONTENT_KEY_RE.test(key) || ((typeStr === 'string' || typeStr === 'array') && /text|content/i.test(key))) {
        candidateContentKeys.add(key);
      }
    }
  };

  for (const item of sampleItems) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      inspectObject(item as Record<string, unknown>);

      // If item contains nested array of messages, also inspect sample nested entries
      const record = item as Record<string, unknown>;
      for (const nestedKey of ['messages', 'chat_messages', 'items', 'turns', 'conversation']) {
        const nestedVal = record[nestedKey];
        if (Array.isArray(nestedVal)) {
          for (const subItem of nestedVal.slice(0, 10)) {
            if (subItem && typeof subItem === 'object' && !Array.isArray(subItem)) {
              inspectObject(subItem as Record<string, unknown>);
            }
          }
        }
      }
    }
  }

  return {
    candidateRoleKeys: [...candidateRoleKeys],
    candidateContentKeys: [...candidateContentKeys],
    keyFrequency,
  };
}
