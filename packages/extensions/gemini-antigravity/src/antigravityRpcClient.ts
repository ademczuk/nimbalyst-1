/**
 * Renderer-side RPC client for the Antigravity language server.
 *
 * The Antigravity language server runs as a child process and serves HTTPS
 * with a self-signed cert on localhost. Neither child_process.spawn nor
 * https.request with rejectUnauthorized:false is available in the renderer,
 * so this extension delegates every server interaction to a main-process IPC
 * bridge (`antigravity:rpc:*`). The bridge keeps the existing
 * AntigravityServerManager singleton in main and exposes the methods we need.
 *
 * Channels (registered in packages/electron/src/main/ipc/AntigravityRpcHandlers.ts):
 *   - antigravity:ensure-running   -> { ok, error? }
 *   - antigravity:get-models       -> { ok, models?: Map-like entries, error? }
 *   - antigravity:resolve-model    -> { ok, enumName?, error? }
 *   - antigravity:get-model-response -> { ok, response?, error? }
 *   - antigravity:get-user-status  -> { ok, userStatus?, error? }
 *   - antigravity:is-installed     -> { installed, hasAuth }
 *
 * The bridge never exposes raw child process handles or sockets; it only
 * passes JSON-serializable payloads.
 */

export interface AntigravityModelInfo {
  key: string;
  enum: string;
  displayName: string;
  apiProvider?: string;
  maxTokens?: number;
}

export interface AntigravityRpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  versionGate?: boolean;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const api = (globalThis as { window?: Window }).window?.electronAPI;
  if (!api?.invoke) {
    throw new Error('electronAPI.invoke is not available - extension must run in the Nimbalyst renderer');
  }
  const res = (await api.invoke(channel, payload ?? {})) as AntigravityRpcResult<T>;
  if (!res?.ok) {
    const err = new Error(res?.error ?? `${channel} failed`);
    if (res?.versionGate) {
      (err as Error & { isVersionGate?: boolean }).isVersionGate = true;
    }
    throw err;
  }
  return res.data as T;
}

export class AntigravityRpcClient {
  /** Ensure the underlying language server is reachable. Idempotent. */
  static async ensureRunning(): Promise<void> {
    await call<void>('antigravity:ensure-running');
  }

  /** True if the Antigravity language_server binary is installed. */
  static async isInstalled(): Promise<{ installed: boolean; hasAuth: boolean }> {
    return call<{ installed: boolean; hasAuth: boolean }>('antigravity:is-installed');
  }

  /** Full model catalog (key -> info). Returns an array of [key, info] tuples for JSON safety. */
  static async getAvailableModels(): Promise<AntigravityModelInfo[]> {
    return call<AntigravityModelInfo[]>('antigravity:get-models');
  }

  /** Resolve a stable model key to the server's current enum. */
  static async resolveModelEnum(keyOrDisplayName: string): Promise<string> {
    return call<string>('antigravity:resolve-model', { keyOrDisplayName });
  }

  /** Send a prompt to a model. Returns the full text response. */
  static async getModelResponse(prompt: string, modelKeyOrEnum: string, timeoutMs = 120_000): Promise<string> {
    return call<string>('antigravity:get-model-response', { prompt, modelKeyOrEnum, timeoutMs });
  }

  /** Raw GetUserStatus result (used by the usage meter). */
  static async getUserStatus(): Promise<unknown> {
    return call<unknown>('antigravity:get-user-status');
  }
}
