# `@sm/oca` — Open Conversation Archive (v1)

> **Specification License**: CC0-1.0  
> **Reference Implementation License**: MIT  
> **Runtime Dependencies**: 0 (Pure Node/TS standard library + JSON Schema Draft 2020-12)

`@sm/oca` defines the canonical intermediate representation for archiving, deduplicating, and verifying conversations across web AI exports (`openai-web`, `anthropic-web`, `deepseek-web`) and local AI agent trajectories (`codex-local`, `claude-code-local`, `dsh-local`).

## Core Design Principles

1. **Parent-Pointer DAG Topology**: Every item is a node (`external_id`, `parent_external_id`, `is_active_branch`) preserving regenerated branches and sub-agent sidechains without flattening.
2. **Orthogonal `role` × `kind` + `is_synthetic`**: Separates who sent an item (`user | assistant | system | tool | developer`) from what it represents (`message | reasoning | tool_call | tool_result | compaction | ...`) and whether it was machine-injected (`is_synthetic`).
3. **32 KB Spill Rule (`OCA_SPILL_THRESHOLD_BYTES`)**: Payloads or inline base64 media exceeding 32 KB are spilled to content-addressed `OcaBlob` storage (`sha256`).
4. **Three-Tier Vendor Compatibility**:
   - **Level 1**: Core strong-typed columns on `OcaConversation`, `OcaItem`, `OcaBlock`, `OcaBlob`.
   - **Level 2**: Namespaced provider extensions (`ext.openai`, `ext.codex`, `ext.claude_code`, `ext.dsh`, etc.).
   - **Level 3**: Unrecognized upstream fields captured in `ext._unmapped` or `payload_ref` for zero-loss schema drift recovery.
5. **Five-Level Deterministic Hashing**:
   - Raw file SHA-256 -> Blob SHA-256 -> Item Semantic Hash (`normalizeText` + `role|kind|tool_name`) -> Conversation Merkle Root -> MinHash(128) LSH Fingerprint.
