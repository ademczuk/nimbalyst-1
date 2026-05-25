/**
 * Ambient type shim for the `@nimbalyst/runtime/ai/server` subpath.
 *
 * The extension imports `StreamChunk` from this subpath as a TYPE-ONLY import
 * (exactly as the host's extensionProviderTurnBridge does), so vite erases it
 * from the bundle and the host's real runtime module supplies the value at run
 * time. This declaration only exists so an ISOLATED `tsc --noEmit` of this
 * extension can resolve the type without pulling the entire @nimbalyst/runtime
 * source graph (which is node-heavy and only type-checks as part of the
 * monorepo). It mirrors the StreamChunk shape from
 * packages/runtime/src/ai/server/types.ts (the load-bearing fields).
 *
 * If the runtime's published .d.ts ever ships, TypeScript prefers the real
 * declaration over this ambient fallback when both resolve.
 */
declare module '@nimbalyst/runtime/ai/server' {
  export interface StreamChunk {
    type:
      | 'text'
      | 'tool_call'
      | 'tool_error'
      | 'error'
      | 'complete'
      | 'stream_edit_start'
      | 'stream_edit_content'
      | 'stream_edit_end'
      | 'pre_edit_snapshot';
    content?: string;
    isSystem?: boolean;
    toolCall?: {
      id?: string;
      name: string;
      arguments?: Record<string, unknown>;
      result?: unknown;
      toolUseId?: string;
    };
    toolError?: {
      name: string;
      arguments?: Record<string, unknown>;
      error: string;
      result?: unknown;
    };
    error?: string;
    isAuthError?: boolean;
    isBedrockToolError?: boolean;
    isServerError?: boolean;
    isComplete?: boolean;
    config?: unknown;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    modelUsage?: Record<string, unknown>;
    contextFillTokens?: number;
    contextWindow?: number;
    contextCompacted?: boolean;
    preEditSnapshot?: {
      toolUseId: string;
      entries: Array<{ path: string; content: string | null; kind?: string }>;
    };
  }
}
