/**
 * Main-side IPC bridge for the kimi-code marketplace extension.
 *
 * The renderer-resident kimi-code provider (packages/extensions/kimi-code/)
 * cannot directly talk to api.moonshot.ai (no fs/net stack, no place to
 * stash the API key safely). This bridge owns the HTTP client, API-key
 * resolution, system-prompt selection, and tool-call dispatch.
 *
 * Channels:
 *   kimi-code:chat:test-connection      -> { ok } | { ok:false, error }
 *   kimi-code:chat:get-models           -> { ok, data: KimiCodeModelInfo[] }
 *   kimi-code:chat:complete             -> { ok, data: text }
 *   kimi-code:agent:get-system-prompt   -> { ok, data: systemPrompt }
 *   kimi-code:agent:get-tools           -> { ok, data: OpenAITool[] }
 *   kimi-code:agent:execute-tool        -> { ok, data: result }
 *
 * Meta-agent host: when the caller's session has `agentRole === 'meta-agent'`,
 * the agent endpoints swap to the canonical buildMetaAgentSystemPrompt +
 * META_AGENT_ALLOWED_TOOLS surface, and tool calls for
 * mcp__nimbalyst-meta-agent__* dispatch through MetaAgentService. A Kimi
 * agent can therefore spawn Claude or Codex child sessions mid-loop.
 *
 * This module deliberately mirrors the shape of AntigravityRpcHandlers.ts so
 * the diff between the two providers stays mechanical. The meta-agent
 * tool descriptors + session lookup + cache are duplicated rather than
 * imported across extensions; the FUTURE refactor extracts them into a
 * shared module (see TODO(reshape) below).
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK contract
 * lands, this entire file goes away. The HTTP client + meta-agent dispatch
 * move INSIDE the kimi-code extension's backend-module entry, and the
 * gemini side does the same. At that point, the shared meta-agent
 * tool-descriptor catalog should be lifted into a runtime export consumable
 * from any backend module.
 */

import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { buildMetaAgentSystemPrompt } from '@nimbalyst/runtime/ai/server';
import { MetaAgentService } from '../services/MetaAgentService';
import {
  testConnection as kimiCodeTestConnection,
  getAvailableModels as kimiCodeGetModels,
  complete as kimiCodeComplete,
  readAuthStatus as kimiCodeReadAuthStatus,
  type KimiChatMessage,
  type KimiModelInfo,
  type KimiAuthStatus,
  type KimiToolDef,
  type KimiCompletionReply,
} from '../services/KimiCodeClient';

interface Ok<T> { ok: true; data: T }
interface OkVoid { ok: true }
interface Err { ok: false; error: string }
type Result<T> = Ok<T> | OkVoid | Err;

function ok<T>(data: T): Ok<T> { return { ok: true, data }; }
function okVoid(): OkVoid { return { ok: true }; }
function err(message: string): Err { return { ok: false, error: message }; }

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// -- Meta-agent shared surface ------------------------------------------------
//
// The descriptors + session cache below are intentionally a verbatim copy of
// the equivalents in AntigravityRpcHandlers.ts. Duplicating them keeps each
// extension's IPC bridge self-contained for now. The TODO(reshape) at the top
// of this file covers extracting them into a shared module when the
// aiAgentProviders + backendModules SDK lands.

const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful AI coding assistant. When tools are available, you can call them via the JSON tool_call envelope. Respond with plain text when you are done.';

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

interface MetaAgentSessionInfo {
  isMetaAgent: boolean;
  provider?: string;
  model?: string;
  workspacePath?: string;
}

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

/** Test-only escape hatch. */
export function __resetKimiCodeMetaAgentSessionCache(): void {
  metaAgentSessionCache.clear();
}

async function isMetaAgentSession(sessionId?: string): Promise<MetaAgentSessionInfo> {
  if (!sessionId) return { isMetaAgent: false };
  const cached = metaAgentSessionCache.get(sessionId);
  if (cached) return cached;
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
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

// -- Handler registration -----------------------------------------------------

export function registerKimiCodeRpcHandlers(): void {
  // ----- Chat / catalog -----

  safeHandle('kimi-code:chat:test-connection', async (): Promise<Result<void>> => {
    try {
      await kimiCodeTestConnection();
      return okVoid();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  safeHandle('kimi-code:chat:get-models', async (): Promise<Result<KimiModelInfo[]>> => {
    try {
      const models = await kimiCodeGetModels();
      return ok(models);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * Read-only auth status for the Settings panel. Touches no network -
   * reports the state of the local ~/.kimi/credentials/kimi-code.json file.
   * The panel uses this to drive the OAuth-status card (mirrors the gemini-
   * antigravity pattern that surfaces ~/.gemini OAuth state).
   */
  safeHandle('kimi-code:auth:status', async (): Promise<Result<KimiAuthStatus>> => {
    try {
      const status = await kimiCodeReadAuthStatus();
      return ok(status);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  safeHandle('kimi-code:chat:complete', async (_e, payload: {
    messages?: KimiChatMessage[];
    model?: string;
    maxTokens?: number;
    tools?: KimiToolDef[];
    tool_choice?: 'auto' | 'none';
    timeoutMs?: number;
  }): Promise<Result<KimiCompletionReply>> => {
    try {
      if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
        return err('kimi-code:chat:complete requires non-empty messages[]');
      }
      if (typeof payload.model !== 'string' || payload.model === '') {
        return err('kimi-code:chat:complete requires a model id');
      }
      const reply = await kimiCodeComplete(
        {
          messages: payload.messages,
          model: payload.model,
          maxTokens: payload.maxTokens,
          tools: payload.tools,
          tool_choice: payload.tool_choice,
        },
        payload.timeoutMs,
      );
      return ok(reply);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  // ----- Agent -----

  safeHandle('kimi-code:agent:get-system-prompt', async (_e, payload: { sessionId?: string }): Promise<Result<string>> => {
    try {
      const { isMetaAgent, provider, model } = await isMetaAgentSession(payload?.sessionId);
      if (isMetaAgent) {
        // 'claude' style renders tool references as `mcp__server__tool` which
        // matches the names we register in META_AGENT_TOOL_DESCRIPTORS.
        const promptText = buildMetaAgentSystemPrompt('claude', 'default', {
          provider: provider ?? 'kimi-code-agent',
          model: model ?? 'kimi-for-coding',
        });
        return ok(promptText);
      }
      return ok(DEFAULT_AGENT_SYSTEM_PROMPT);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  safeHandle('kimi-code:agent:get-tools', async (_e, payload: { sessionId?: string; workspacePath?: string }): Promise<Result<OpenAITool[]>> => {
    try {
      const { isMetaAgent } = await isMetaAgentSession(payload?.sessionId);
      if (isMetaAgent) {
        // Fresh array each call so callers can mutate without poisoning the
        // shared module-level constant.
        return ok(META_AGENT_TOOL_DESCRIPTORS.map((t) => ({ ...t, function: { ...t.function } })));
      }
      // Standard sessions: no tools yet. The renderer-side tool loop falls
      // back to plain chat. Adding the full Nimbalyst tool registry here is a
      // separate task that gemini also defers.
      return ok([]);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  safeHandle('kimi-code:agent:execute-tool', async (_e, payload: {
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
        return err('kimi-code:agent:execute-tool requires { name }');
      }
      if (!sessionId) {
        return err(`kimi-code:agent:execute-tool requires sessionId (tool: ${toolName})`);
      }
      if (!workspacePath) {
        return err(`kimi-code:agent:execute-tool requires workspacePath (tool: ${toolName})`);
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
          // not as an IPC-level err (so the renderer's tool loop continues
          // rather than aborting the whole turn). Mirrors antigravity.
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.main.error(`[KimiCodeRpc] meta-agent tool '${toolName}' failed:`, errMsg);
          return ok(`Error: ${errMsg}`);
        }
      }

      return err(`kimi-code:agent:execute-tool: unknown tool '${toolName}'`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  logger.main.info('[KimiCodeRpc] handlers registered');
}
