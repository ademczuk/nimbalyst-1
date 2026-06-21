/**
 * Renderer-side RPC client for the Moonshot Kimi platform API.
 *
 * Auth + transport: delegates to a main-process IPC bridge (`kimi-code:*`)
 * that owns the HTTP client, the OAuth-file read (~/.kimi/credentials/
 * kimi-code.json), and the User-Agent + X-Msh-* device headers Moonshot's
 * api.kimi.com endpoint pins to.
 *
 * Channels (registered in packages/electron/src/main/ipc/KimiCodeRpcHandlers.ts):
 *   - kimi-code:chat:get-models           -> { ok, data: KimiCodeModelInfo[] }
 *   - kimi-code:chat:complete             -> { ok, data: KimiCompletionReply }
 *   - kimi-code:chat:test-connection      -> { ok } | { ok:false, error }
 *   - kimi-code:auth:status               -> { ok, data: KimiCodeAuthStatus }
 *   - kimi-code:agent:get-system-prompt   -> { ok, data: systemPrompt }
 *   - kimi-code:agent:get-tools           -> { ok, data: OpenAITool[] }
 *   - kimi-code:agent:execute-tool        -> { ok, data: result }
 */

export interface KimiCodeModelInfo {
  /** Stable model id, e.g. "kimi-for-coding". Used in the provider-prefixed model id. */
  id: string;
  /** Display name shown in the model picker. */
  displayName: string;
  /** Context window in tokens, surfaced by the host as maxTokens / contextWindow. */
  contextWindow?: number;
}

/** Read-only auth-status reply from main. Mirrors the gemini-antigravity
 *  ~/.gemini OAuth status card. */
export type KimiCodeAuthStatus =
  | { state: 'not-logged-in' }
  | { state: 'expired'; expiresAt: number }
  | { state: 'valid'; expiresAt: number; scope: string };

/** OpenAI-compatible chat message. */
export interface KimiCodeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Optional on assistant messages that ONLY issue tool_calls. The Kimi
   * endpoint rejects assistant messages with empty/whitespace `content`
   * alongside `tool_calls` (HTTP 400 "text content is empty"), so callers
   * must OMIT the key entirely - undefined is the only safe shape.
   */
  content?: string;
  /** Required when role === 'tool'; the id of the tool_call this result corresponds to. */
  tool_call_id?: string;
  /** Tool name; required on 'tool' role. */
  name?: string;
  /** Present on assistant messages that issued tool calls. */
  tool_calls?: KimiCodeToolCall[];
  /**
   * K2.6-specific. Required on assistant turns that included reasoning
   * when thinking mode is enabled. The server returns HTTP 400 if a
   * subsequent request omits this on prior assistant turns.
   */
  reasoning_content?: string;
}

/** OpenAI-style tool call carried on an assistant message. */
export interface KimiCodeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string per OpenAI's contract. */
    arguments: string;
  };
}

/** OpenAI-style tool definition passed in the request body. */
export interface KimiCodeToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface KimiCodeCompleteOptions {
  /** Full conversation as OpenAI-compatible messages. */
  messages: KimiCodeChatMessage[];
  /** Moonshot model id (e.g. "kimi-for-coding"). */
  model: string;
  /** Optional max tokens cap; main applies a sane default if omitted. */
  maxTokens?: number;
  /** Tools available for the model to call. Pass [] or omit to disable. */
  tools?: KimiCodeToolDef[];
  /** OpenAI tool_choice. K2.6 supports 'auto' and 'none'; 'required' is rejected. */
  tool_choice?: 'auto' | 'none';
  /** Optional request timeout (ms). Main applies a sane default if omitted. */
  timeoutMs?: number;
}

/** Assistant turn from the model. */
export interface KimiCompletionReply {
  /** Text content, if any. Null/empty when the model issued only tool_calls. */
  content: string | null;
  /** Tool calls the model wants the host to execute. */
  toolCalls: KimiCodeToolCall[];
  /**
   * K2.6-specific thinking text. Null when thinking is off. Must be echoed
   * back on the assistant turn in subsequent requests or the server 400s.
   */
  reasoningContent: string | null;
  /** OpenAI finish_reason: 'stop' | 'tool_calls' | 'length' | ... */
  finishReason: string;
}

export interface KimiCodeRpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const api = (globalThis as { window?: Window }).window?.electronAPI;
  if (!api?.invoke) {
    throw new Error('electronAPI.invoke is not available - extension must run in the Nimbalyst renderer');
  }
  const res = (await api.invoke(channel, payload ?? {})) as KimiCodeRpcResult<T>;
  if (!res?.ok) {
    throw new Error(res?.error ?? `${channel} failed`);
  }
  return res.data as T;
}

export class KimiCodeRpcClient {
  /** Probe connectivity + auth. Cheap call - hits GET /v1/models. */
  static async testConnection(): Promise<void> {
    await call<void>('kimi-code:chat:test-connection');
  }

  /** Full model catalog from the platform's GET /v1/models. */
  static async getAvailableModels(): Promise<KimiCodeModelInfo[]> {
    return call<KimiCodeModelInfo[]>('kimi-code:chat:get-models');
  }

  /** One-shot chat completion. Returns the assistant message (content +/or tool_calls). */
  static async complete(opts: KimiCodeCompleteOptions): Promise<KimiCompletionReply> {
    return call<KimiCompletionReply>('kimi-code:chat:complete', opts);
  }

  /** Read-only auth status check. Touches no network; mirrors the local
   *  credentials file. Used by the Settings panel's OAuth-status card. */
  static async authStatus(): Promise<KimiCodeAuthStatus> {
    return call<KimiCodeAuthStatus>('kimi-code:auth:status');
  }
}
