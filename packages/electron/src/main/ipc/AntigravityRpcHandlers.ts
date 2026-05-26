/**
 * Main-side IPC bridge for the Antigravity language-server RPC.
 *
 * The gemini-antigravity marketplace extension runs in the renderer where
 * neither child_process.spawn (for the language_server binary) nor Node's
 * https module with rejectUnauthorized:false (for the self-signed cert on
 * 127.0.0.1) are available. This bridge keeps the existing
 * AntigravityServerManager singleton in main and exposes the methods the
 * extension's renderer-side providers need.
 *
 * All payloads are JSON-serializable. The bridge never exposes raw child
 * process handles or sockets.
 *
 * Channels:
 *   antigravity:is-installed       -> { installed, hasAuth }
 *   antigravity:ensure-running     -> { ok, error? }
 *   antigravity:get-models         -> { ok, data: AntigravityModelInfo[] }
 *   antigravity:resolve-model      -> { ok, data: enumName }
 *   antigravity:get-model-response -> { ok, data: text }
 *   antigravity:get-user-status    -> { ok, data: rawUserStatus }
 *
 * Agent-specific channels (used by AntigravityAgentProvider in the extension):
 *   antigravity:agent:get-system-prompt -> { ok, data: systemPrompt }
 *   antigravity:agent:get-tools         -> { ok, data: OpenAITool[] }
 *   antigravity:agent:execute-tool      -> { ok, data: result }
 */

import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';

interface Ok<T> { ok: true; data: T }
interface OkVoid { ok: true }
interface Err { ok: false; error: string; versionGate?: boolean }
type Result<T> = Ok<T> | OkVoid | Err;

function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
function okVoid(): OkVoid { return { ok: true }; }
function err(message: string, opts?: { versionGate?: boolean }): Err {
  return { ok: false, error: message, ...(opts?.versionGate ? { versionGate: true } : {}) };
}

/**
 * Load AntigravityServerManager via dynamic import so this module doesn't pull
 * the heavy server-lifecycle code into every main-process boot path. Cached
 * after first successful load.
 */
let serverManagerImport: Promise<typeof import('@nimbalyst/runtime/ai/server/providers/antigravity/AntigravityServerManager')> | null = null;
function getServerManager() {
  if (!serverManagerImport) {
    serverManagerImport = import('@nimbalyst/runtime/ai/server/providers/antigravity/AntigravityServerManager');
  }
  return serverManagerImport;
}

export function registerAntigravityRpcHandlers(): void {
  safeHandle('antigravity:is-installed', async (): Promise<Result<{ installed: boolean; hasAuth: boolean }>> => {
    try {
      const { AntigravityServerManager } = await getServerManager();
      return ok({
        installed: AntigravityServerManager.isInstalled(),
        hasAuth: AntigravityServerManager.hasGeminiAuth(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:ensure-running', async (): Promise<Result<void>> => {
    try {
      const { AntigravityServerManager } = await getServerManager();
      await AntigravityServerManager.shared().ensureRunning();
      return okVoid();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:get-models', async (): Promise<Result<Array<{ key: string; enum: string; displayName: string; apiProvider?: string; maxTokens?: number }>>> => {
    try {
      const { AntigravityServerManager } = await getServerManager();
      const catalog = await AntigravityServerManager.shared().getAvailableModels();
      const arr: Array<{ key: string; enum: string; displayName: string; apiProvider?: string; maxTokens?: number }> = [];
      for (const [key, info] of catalog.entries()) {
        arr.push({
          key,
          enum: info.enum,
          displayName: info.displayName,
          apiProvider: info.apiProvider,
          maxTokens: info.maxTokens,
        });
      }
      return ok(arr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:resolve-model', async (_e, payload: { keyOrDisplayName?: string }): Promise<Result<string>> => {
    try {
      if (!payload?.keyOrDisplayName) {
        return err('antigravity:resolve-model requires { keyOrDisplayName }');
      }
      const { AntigravityServerManager } = await getServerManager();
      const enumName = await AntigravityServerManager.shared().resolveModelEnum(payload.keyOrDisplayName);
      return ok(enumName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:get-model-response', async (_e, payload: { prompt?: string; modelKeyOrEnum?: string; timeoutMs?: number }): Promise<Result<string>> => {
    try {
      if (!payload?.prompt || !payload?.modelKeyOrEnum) {
        return err('antigravity:get-model-response requires { prompt, modelKeyOrEnum }');
      }
      const { AntigravityServerManager, AntigravityVersionGateError } = await getServerManager();
      try {
        const text = await AntigravityServerManager.shared().getModelResponse(
          payload.prompt,
          payload.modelKeyOrEnum,
          payload.timeoutMs ?? 120_000,
        );
        return ok(text);
      } catch (e) {
        if (e instanceof AntigravityVersionGateError) {
          return err(e.message, { versionGate: true });
        }
        throw e;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:get-user-status', async (): Promise<Result<unknown>> => {
    try {
      const { AntigravityServerManager } = await getServerManager();
      const us = await AntigravityServerManager.shared().getUserStatus();
      return ok(us);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  // -------- Agent-specific channels --------
  // For Tier 1 of the marketplace migration, the agent-provider IPC channels
  // return safe stubs. The renderer-side AntigravityAgentProvider needs:
  //   - getSystemPrompt: an empty prompt is fine; the loop still works
  //   - getTools: empty array means the model only produces text (no tool calls)
  //   - executeTool: refuses with an error (never called when tools is empty)
  //
  // A follow-up plumb through MessageStreamingHandler / BaseAgentProvider so
  // the renderer-side agent has the full Nimbalyst tool registry.

  safeHandle('antigravity:agent:get-system-prompt', async (_e, _payload: unknown): Promise<Result<string>> => {
    try {
      // Minimal default - the agent will still run as a tool-less assistant.
      // Future: load buildClaudeCodeSystemPrompt / buildMetaAgentSystemPrompt
      // from @nimbalyst/runtime/ai/prompt and route by session.agentRole.
      const defaultPrompt = 'You are a helpful AI coding assistant. When tools are available, you can call them via the JSON tool_call envelope. Respond with plain text when you are done.';
      return ok(defaultPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:agent:get-tools', async (_e, _payload: unknown): Promise<Result<Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>>> => {
    try {
      // Tier-1: no tools. The agent loop becomes a multi-turn chat (still
      // useful for meta-agent workflows that don't need file edits).
      // Tier-2: source tools from a runtime registry shared with built-in agents.
      return ok([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:agent:execute-tool', async (_e, payload: { name?: string }): Promise<Result<unknown>> => {
    return err(`antigravity:agent:execute-tool not yet wired (called with '${payload?.name ?? 'unknown'}')`);
  });

  logger.main.info('[AntigravityRpc] handlers registered');
}
