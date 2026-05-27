/**
 * Renderer-side RPC client for the Moonshot Kimi K2 platform API.
 *
 * Moonshot's API is OpenAI-compatible at https://api.moonshot.ai/v1. Neither
 * Node's https module nor fetch-with-API-key-from-electron-store is something
 * we want to do in the renderer, so this extension delegates every server
 * interaction to a main-process IPC bridge (`kimi-code:*`). The bridge owns
 * the HTTP client, the API key resolution (electron-store, NEVER process.env
 * per the repo's CLAUDE.md "Never Use Environment Variables as Implicit API
 * Key Sources" rule), and the response parsing.
 *
 * Channels (registered in packages/electron/src/main/ipc/KimiCodeRpcHandlers.ts):
 *   - kimi-code:chat:get-models           -> { ok, data: KimiCodeModelInfo[] }
 *   - kimi-code:chat:complete             -> { ok, data: text }
 *   - kimi-code:chat:test-connection      -> { ok } | { ok:false, error }
 *   - kimi-code:agent:get-system-prompt   -> { ok, data: systemPrompt }
 *   - kimi-code:agent:get-tools           -> { ok, data: OpenAITool[] }
 *   - kimi-code:agent:execute-tool        -> { ok, data: result }
 *
 * The bridge never exposes raw API keys or sockets; it only passes JSON-
 * serializable payloads.
 *
 * Mirrors the shape of packages/extensions/gemini-antigravity/src/antigravityRpcClient.ts.
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK contract lands,
 * this client moves INSIDE the extension's backend-module entry (utility-process
 * runtime) rather than going over IPC to a hand-written main-process handler.
 * The shape stays the same; the transport changes from window.electronAPI.invoke
 * to the backend-module RPC bridge.
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
  content: string;
  /** Required when role === 'tool'; identifies the tool call this result corresponds to. */
  tool_call_id?: string;
  /** Optional tool name on assistant turns that issued tool calls. */
  name?: string;
}

export interface KimiCodeCompleteOptions {
  /** Full conversation as OpenAI-compatible messages. */
  messages: KimiCodeChatMessage[];
  /** Moonshot model id (e.g. "kimi-k2.6"). */
  model: string;
  /** Optional max tokens cap; main applies a sane default if omitted. */
  maxTokens?: number;
  /** Optional sampling temperature (0..2). */
  temperature?: number;
  /** Optional request timeout (ms). Main applies a sane default if omitted. */
  timeoutMs?: number;
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

  /** Full model catalog from the platform's GET /v1/models, scoped to K2 family. */
  static async getAvailableModels(): Promise<KimiCodeModelInfo[]> {
    return call<KimiCodeModelInfo[]>('kimi-code:chat:get-models');
  }

  /** One-shot chat completion. Returns the assistant text. */
  static async complete(opts: KimiCodeCompleteOptions): Promise<string> {
    return call<string>('kimi-code:chat:complete', opts);
  }

  /** Read-only auth status check. Touches no network; mirrors the local
   *  credentials file. Used by the Settings panel's OAuth-status card. */
  static async authStatus(): Promise<KimiCodeAuthStatus> {
    return call<KimiCodeAuthStatus>('kimi-code:auth:status');
  }
}
