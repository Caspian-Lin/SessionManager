export * from './types.js';
export * from './normalize.js';
export * from './hash.js';
export * from './minhash.js';
export * from './validate.js';

// Convenience aliases for CLI and downstream consumers
export {
  computeItemSemanticHash as computeSemanticItemHash,
  computeConversationMerkleRoot as computeConversationMerkleHash,
} from './hash.js';
export {
  computeMinHash128 as computeMinHashFingerprint,
  estimateMinHashSimilarity as estimateJaccardSimilarity,
} from './minhash.js';
