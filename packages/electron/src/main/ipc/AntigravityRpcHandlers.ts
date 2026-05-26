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
 *
 * Meta-agent wiring (CLA-185 Bug J, Task #60+#73):
 *   When the caller's session has `agentRole === 'meta-agent'` we serve
 *   `buildMetaAgentSystemPrompt` plus the canonical META_AGENT_ALLOWED_TOOLS
 *   schema and dispatch `mcp__nimbalyst-meta-agent__*` tool calls directly
 *   through MetaAgentService.invokeMetaAgentTool. The renderer-side
 *   antigravity provider sees these tools in its OpenAI-style tool list,
 *   the model emits `{"tool_call":{"name":"mcp__nimbalyst-meta-agent__...",
 *   "arguments":{...}}}` per AntigravityToolLoopProtocol, the loop sends
 *   that to `antigravity:agent:execute-tool`, and we run the same code
 *   path Claude Code uses for the SSE MCP transport (only without the
 *   HTTP round-trip). The result is returned as a string the loop hands
 *   back to the model as its tool result.
 */

import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { buildMetaAgentSystemPrompt } from '@nimbalyst/runtime/ai/server';
import { MetaAgentService } from '../services/MetaAgentService';

interface Ok<T> { ok: true; data: T }
interface OkVoid { ok: true }
interface Err { ok: false; error: string; versionGate?: boolean }
type Result<T> = Ok<T> | OkVoid | Err;

function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
function okVoid(): OkVoid { return { ok: true }; }
function err(message: string, opts?: { versionGate?: boolean }): Err {
  return { ok: false, error: message, ...(opts?.versionGate ? { versionGate: true } : {}) };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Canonical OpenAI-style descriptors for the meta-agent MCP tools. The
 * shapes are derived from the schemas registered in metaAgentServer.ts'
 * ListToolsRequestSchema handler (kept in sync deliberately so the model
 * sees the same arguments regardless of transport). We do NOT include
 * `update_session_meta` here yet — see notes in
 * MetaAgentService.invokeMetaAgentTool. Adding more tools is purely
 * additive: extend this array AND the switch in MetaAgentService.
 */
const META_AGENT_TOOL_DESCRIPTORS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__list_worktrees',
      description:
        'List the available git worktrees for this workspace so you can attach a child session to an existing branch or decide whether to create a fresh worktree.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__create_session',
      description:
        'Spawn a new child session for a focused task. Can optionally create a dedicated worktree or attach the session to an existing worktree, then seed it with an initial prompt.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional title for the child session.' },
          provider: {
            type: 'string',
            enum: ['claude-code', 'openai-codex'],
            description: 'Provider to use for the child session.',
          },
          model: { type: 'string', description: 'Optional explicit model identifier.' },
          prompt: {
            type: 'string',
            description:
              'Optional initial prompt to queue for the child session immediately after creation.',
          },
          useWorktree: {
            type: 'boolean',
            description: 'Whether to create the child session inside a fresh git worktree.',
          },
          worktreeId: {
            type: 'string',
            description:
              'Optional existing worktree ID to attach this child session to. Do not combine with useWorktree.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__list_spawned_sessions',
      description:
        'List all child sessions created by this meta-agent session, including current status and a short summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__get_session_status',
      description:
        'Get the current status of a child session including last activity time and whether it is waiting for input.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to inspect.' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__get_session_result',
      description:
        'Get the current or final result of a session including prompts, recent responses, edited files, and pending interactive prompts.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to inspect.' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__send_prompt',
      description:
        'Queue a follow-up prompt for a child session. If the session is idle, prompt processing starts immediately.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The target child session ID.' },
          prompt: { type: 'string', description: 'The follow-up prompt to send.' },
        },
        required: ['sessionId', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__nimbalyst-meta-agent__respond_to_prompt',
      description:
        "Answer a child session's interactive prompt such as AskUserQuestion, ExitPlanMode, or ToolPermission.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The child session waiting for input.' },
          promptId: { type: 'string', description: 'The interactive prompt ID.' },
          promptType: {
            type: 'string',
            enum: ['permission_request', 'ask_user_question_request', 'exit_plan_mode_request'],
            description: 'The kind of prompt being answered.',
          },
          response: { type: 'object', description: 'Prompt-specific response payload.' },
        },
        required: ['sessionId', 'promptId', 'promptType', 'response'],
      },
    },
  },
];

/**
 * Default prompt for non-meta-agent sessions. Kept small so the chat-style
 * tool loop still works even without injected tools.
 */
const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful AI coding assistant. When tools are available, you can call them via the JSON tool_call envelope. Respond with plain text when you are done.';

interface MetaAgentSessionInfo {
  isMetaAgent: boolean;
  provider?: string;
  model?: string;
  workspacePath?: string;
}

/**
 * Cache of session lookups for the agent tool-loop hot path. A session's
 * agentRole / provider / model are set at creation and do not change for the
 * lifetime of the session, so we can safely memoize the lookup. Cap the cache
 * to avoid unbounded growth in long-running sessions; LRU-ish eviction by
 * insertion order via Map iteration.
 *
 * Without this, every tool call inside a meta-agent loop hits PGLite for the
 * same row -- a multi-step meta-agent turn was doing dozens of identical
 * `ai_sessions` reads per second.
 */
const META_AGENT_CACHE_MAX = 64;
const metaAgentSessionCache = new Map<string, MetaAgentSessionInfo>();

function cacheMetaAgentSession(sessionId: string, info: MetaAgentSessionInfo): void {
  if (metaAgentSessionCache.has(sessionId)) {
    metaAgentSessionCache.delete(sessionId);
  } else if (metaAgentSessionCache.size >= META_AGENT_CACHE_MAX) {
    const oldestKey = metaAgentSessionCache.keys().next().value;
    if (oldestKey !== undefined) {
      metaAgentSessionCache.delete(oldestKey);
    }
  }
  metaAgentSessionCache.set(sessionId, info);
}

/**
 * Test-only escape hatch: clear the cache so unit tests don't see stale rows.
 * Exported as a named symbol so production code never imports it accidentally.
 */
export function __resetMetaAgentSessionCache(): void {
  metaAgentSessionCache.clear();
}

async function isMetaAgentSession(sessionId?: string): Promise<MetaAgentSessionInfo> {
  if (!sessionId) {
    return { isMetaAgent: false };
  }
  const cached = metaAgentSessionCache.get(sessionId);
  if (cached) {
    return cached;
  }
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      // Negative cache too -- avoids hammering the DB if the model emits a
      // tool call with a bogus sessionId. Bounded by the same cap.
      const negative: MetaAgentSessionInfo = { isMetaAgent: false };
      cacheMetaAgentSession(sessionId, negative);
      return negative;
    }
    const info: MetaAgentSessionInfo = {
      isMetaAgent: session.agentRole === 'meta-agent',
      provider: typeof session.provider === 'string' ? session.provider : undefined,
      model: session.model ?? undefined,
      workspacePath: session.workspacePath ?? undefined,
    };
    cacheMetaAgentSession(sessionId, info);
    return info;
  } catch {
    return { isMetaAgent: false };
  }
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
  // Standard sessions get a minimal chat prompt and no tools (the agent-tool
  // bridge for the full Nimbalyst registry remains task #73). Meta-agent
  // sessions get the canonical meta-agent prompt + tool schema so the
  // antigravity tool loop can spawn and coordinate child sessions exactly
  // like Claude Code and Codex providers do via the MCP SSE transport.

  safeHandle('antigravity:agent:get-system-prompt', async (_e, payload: { sessionId?: string }): Promise<Result<string>> => {
    try {
      const { isMetaAgent, provider, model } = await isMetaAgentSession(payload?.sessionId);
      if (isMetaAgent) {
        // 'claude' style means tool references are rendered as `mcp__server__tool`
        // which matches the names we register in META_AGENT_TOOL_DESCRIPTORS.
        const promptText = buildMetaAgentSystemPrompt('claude', 'default', {
          provider: provider ?? 'antigravity-gemini-agent',
          model: model ?? 'gemini-3-flash-agent',
        });
        return ok(promptText);
      }
      return ok(DEFAULT_AGENT_SYSTEM_PROMPT);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:agent:get-tools', async (_e, payload: { sessionId?: string; workspacePath?: string }): Promise<Result<OpenAITool[]>> => {
    try {
      const { isMetaAgent } = await isMetaAgentSession(payload?.sessionId);
      if (isMetaAgent) {
        // Return a fresh array each call so a downstream caller can safely
        // mutate (e.g. append per-session tools later) without poisoning
        // the shared module-level constant.
        return ok(META_AGENT_TOOL_DESCRIPTORS.map((t) => ({ ...t, function: { ...t.function } })));
      }
      // Standard sessions: no tools yet. The agent loop falls back to plain
      // chat — see comment block above for why this is intentional.
      return ok([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  safeHandle('antigravity:agent:execute-tool', async (_e, payload: {
    sessionId?: string;
    workspacePath?: string;
    name?: string;
    args?: Record<string, unknown>;
  }): Promise<Result<unknown>> => {
    try {
      const toolName = payload?.name;
      const sessionId = payload?.sessionId;
      const workspacePath = payload?.workspacePath;
      const args = (payload?.args ?? {}) as Record<string, unknown>;

      if (!toolName) {
        return err('antigravity:agent:execute-tool requires { name }');
      }
      if (!sessionId) {
        return err(`antigravity:agent:execute-tool requires sessionId (tool: ${toolName})`);
      }
      if (!workspacePath) {
        return err(`antigravity:agent:execute-tool requires workspacePath (tool: ${toolName})`);
      }

      if (toolName.startsWith('mcp__nimbalyst-meta-agent__')) {
        try {
          const text = await MetaAgentService.getInstance().invokeMetaAgentTool(
            sessionId,
            workspacePath,
            toolName,
            args,
          );
          return ok(text);
        } catch (e) {
          // Surface tool-side errors as a tool result the model can read,
          // not as an IPC-level err (so the tool loop continues instead of
          // aborting the whole turn). This mirrors how the MCP SSE path
          // returns `isError: true` content rather than throwing.
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.main.error(`[AntigravityRpc] meta-agent tool '${toolName}' failed:`, errMsg);
          return ok(`Error: ${errMsg}`);
        }
      }

      return err(`antigravity:agent:execute-tool: unknown tool '${toolName}'`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  logger.main.info('[AntigravityRpc] handlers registered');
}
