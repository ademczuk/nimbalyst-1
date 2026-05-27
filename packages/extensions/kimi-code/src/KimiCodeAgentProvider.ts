/**
 * KimiCodeAgentProvider (extension-side, renderer-safe).
 *
 * AGENT provider that surfaces Moonshot Kimi K2.6 with tool-calling and
 * meta-agent host support. Mirrors packages/extensions/gemini-antigravity/
 * src/AntigravityAgentProvider.ts.
 *
 * Architecture:
 *   - Tool definitions: fetched from main (`kimi-code:agent:get-tools`)
 *   - System prompt:    built in main  (`kimi-code:agent:get-system-prompt`)
 *   - Tool execution:   dispatched to main (`kimi-code:agent:execute-tool`)
 *   - Chat completion:  KimiCodeRpcClient.complete (IPC to main)
 *
 * Meta-agent host: when session.agentRole === 'meta-agent', the main-side
 * `kimi-code:agent:get-system-prompt` handler swaps to buildMetaAgentSystemPrompt
 * and `kimi-code:agent:get-tools` returns META_AGENT_ALLOWED_TOOLS. Tool calls
 * for mcp__nimbalyst-meta-agent__* dispatch through MetaAgentService, which
 * spawns a real Claude Code or Codex child session (optionally in a fresh
 * worktree). This matches the antigravity meta-agent wiring exactly.
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK lands and
 * gemini is reshaped, this provider moves to an aiAgentProviders[] manifest
 * entry that references a backendModules[] id, and the IPC channels collapse
 * into the backend-module RPC bridge. The host contract (get-tools, get-
 * system-prompt, execute-tool, meta-agent dispatch) stays identical.
 *
 * TODO(reshape): K2.6 supports native OpenAI-style tools / tool_choice on
 * /v1/chat/completions. Once gemini is reshaped, swap KimiCodeToolLoopProtocol
 * for a native function-calling loop. This will drop the JSON-envelope parsing
 * layer and remove a class of model-output-formatting brittleness.
 */

import type { StreamChunk } from '@nimbalyst/runtime/ai/server';
import { KimiCodeRpcClient, type KimiCodeModelInfo } from './kimiCodeRpcClient';
import { buildUserMessageAddition, type MinimalDocumentContext } from './documentContextUtils';
import { KimiCodeToolLoopProtocol } from './KimiCodeToolLoopProtocol';
import { TinyEmitter } from './emitter';

const PROVIDER_ID = 'kimi-code-agent';

/**
 * Default model id at api.kimi.com/coding/v1. See KimiCodeProvider for the
 * rationale - the Kimi Code platform exposes a single coding-tuned variant.
 */
export const KIMI_CODE_AGENT_DEFAULT_MODEL = 'kimi-for-coding';

/**
 * Models the agent provider surfaces. Mirrors the chat provider.
 */
const SURFACED_MODEL_IDS = new Set<string>([
  'kimi-for-coding',
]);

interface KimiCodeAgentConfig {
  model?: string;
  [key: string]: unknown;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Main-side IPC for agent-specific helpers. Mirrors antigravity's AgentRpc. */
class AgentRpc {
  static async getSystemPrompt(payload: { sessionId?: string; documentContext?: unknown }): Promise<string> {
    const api = window.electronAPI;
    const res = (await api.invoke('kimi-code:agent:get-system-prompt', payload)) as { ok: boolean; data?: string; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'kimi-code:agent:get-system-prompt failed');
    return res.data ?? '';
  }

  static async getTools(payload: { sessionId?: string; workspacePath?: string }): Promise<OpenAITool[]> {
    const api = window.electronAPI;
    const res = (await api.invoke('kimi-code:agent:get-tools', payload)) as { ok: boolean; data?: OpenAITool[]; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'kimi-code:agent:get-tools failed');
    return res.data ?? [];
  }

  static async executeTool(payload: { sessionId?: string; workspacePath?: string; name: string; args: Record<string, unknown> }): Promise<unknown> {
    const api = window.electronAPI;
    const res = (await api.invoke('kimi-code:agent:execute-tool', payload)) as { ok: boolean; data?: unknown; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'kimi-code:agent:execute-tool failed');
    return res.data;
  }
}

export interface KimiCodeAgentProviderHost {
  spawn?: unknown;
}

export class KimiCodeAgentProvider {
  static readonly DEFAULT_MODEL = KIMI_CODE_AGENT_DEFAULT_MODEL;

  private readonly emitter = new TinyEmitter();
  private readonly toolLoop: KimiCodeToolLoopProtocol;
  private config: KimiCodeAgentConfig = {};
  private modelId: string = KimiCodeAgentProvider.DEFAULT_MODEL;
  private abortController: AbortController | null = null;

  getConfig(): Readonly<KimiCodeAgentConfig> {
    return this.config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_host?: KimiCodeAgentProviderHost) {
    this.toolLoop = new KimiCodeToolLoopProtocol({ modelId: this.modelId });
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  getProviderName(): string {
    return PROVIDER_ID;
  }

  async initialize(rawConfig: unknown): Promise<void> {
    const cfg = (rawConfig as KimiCodeAgentConfig) || {};
    this.config = cfg;
    if (cfg.model) {
      this.modelId = cfg.model.includes(':')
        ? cfg.model.split(':').slice(1).join(':')
        : cfg.model;
    }
    this.toolLoop.setModelId(this.modelId);
    await KimiCodeRpcClient.testConnection();
  }

  setProviderSessionData(_sessionId: string, _data: unknown): void {
    // session history is rebuilt each turn via seedHistory
  }

  getProviderSessionData(_sessionId: string): unknown {
    return {};
  }

  abort(): void {
    this.toolLoop.abort();
    this.abortController?.abort();
  }

  destroy(): void {
    this.abort();
    this.emitter.removeAllListeners();
  }

  async *sendMessage(
    message: string,
    documentContext?: unknown,
    sessionId?: string,
    messages?: unknown[],
    workspacePath?: string,
    _attachments?: unknown[],
  ): AsyncIterableIterator<StreamChunk> {
    this.abortController = new AbortController();
    const ctrl = this.abortController;

    try {
      const [systemPrompt, tools] = await Promise.all([
        AgentRpc.getSystemPrompt({ sessionId, documentContext }),
        AgentRpc.getTools({ sessionId, workspacePath }),
      ]);

      const docCtx = (documentContext as MinimalDocumentContext | undefined) || undefined;
      const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, docCtx);

      if (sessionId && userMessageAddition) {
        this.emit('promptAdditions', {
          sessionId,
          systemPromptAddition: systemPrompt || null,
          userMessageAddition,
          attachments: [],
          timestamp: Date.now(),
        });
      }

      const userTurn = messageWithContext || message;

      const priorMessages = Array.isArray(messages) ? [...messages] : [];
      const lastPrior = priorMessages[priorMessages.length - 1] as { role?: string; content?: string } | undefined;
      if (lastPrior && lastPrior.role === 'user' &&
          typeof lastPrior.content === 'string' &&
          lastPrior.content.trim() === message.trim()) {
        priorMessages.pop();
      }
      if (priorMessages.length > 0) {
        this.toolLoop.seedHistory(priorMessages as Array<{ role?: string; content?: string; toolCall?: { name?: string; result?: unknown } }>);
      } else {
        this.toolLoop.reset();
      }

      let finalText = '';
      let toolCallSeq = 0;
      let sawText = false;
      const lastToolResult = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

      for await (const step of this.toolLoop.run(
        userTurn,
        systemPrompt,
        tools,
        async (name, args) => AgentRpc.executeTool({ sessionId, workspacePath, name, args }),
      )) {
        if (ctrl.signal.aborted) break;

        if (step.type === 'tool_call') {
          const id = `kc-${Date.now()}-${toolCallSeq++}`;
          lastToolResult.set(step.name, { id, name: step.name, args: step.args });
          yield {
            type: 'tool_call',
            toolCall: {
              id,
              name: step.name,
              arguments: step.args,
            },
          };
        } else if (step.type === 'tool_result') {
          const pending = lastToolResult.get(step.name);
          if (pending) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: pending.id,
                name: pending.name,
                arguments: pending.args,
                result: step.result,
              },
            };
            lastToolResult.delete(step.name);
          }
        } else if (step.type === 'text') {
          finalText = step.content;
          sawText = true;
          // ALWAYS yield a text chunk so the renderer's stream pipeline
          // registers the assistant's response. Empty/whitespace responses
          // get a visible placeholder. Pattern adopted from gemini's
          // AntigravityAgentProvider (the same fix originally landed in
          // commit 9abec8b7d on the runtime-side provider).
          const renderedText = finalText.trim().length === 0
            ? '(model returned no text)'
            : finalText;
          yield { type: 'text', content: renderedText };
        } else if (step.type === 'complete') {
          const persistedText = finalText.trim().length === 0
            ? (sawText ? '(model returned no text)' : '(no model response)')
            : finalText;
          yield { type: 'complete', content: persistedText, isComplete: true };
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const errMessage = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: errMessage };
    } finally {
      this.abortController = null;
    }
  }

  // ---- Model discovery ----------------------------------------------------

  static async getModels(): Promise<Array<{
    id: string;
    name: string;
    provider: string;
    maxTokens?: number;
    contextWindow?: number;
  }>> {
    let catalog: KimiCodeModelInfo[];
    try {
      catalog = await KimiCodeRpcClient.getAvailableModels();
    } catch {
      catalog = Array.from(SURFACED_MODEL_IDS).map(id => ({
        id,
        displayName: prettyName(id),
        contextWindow: contextWindowFor(id),
      }));
    }
    const out: Array<{ id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number }> = [];
    for (const info of catalog) {
      if (!SURFACED_MODEL_IDS.has(info.id) && !info.id.startsWith('kimi-')) continue;
      out.push(toAIModel(info));
    }
    return out;
  }
}

function toAIModel(info: KimiCodeModelInfo): {
  id: string;
  name: string;
  provider: string;
  maxTokens?: number;
  contextWindow?: number;
} {
  return {
    id: `${PROVIDER_ID}:${info.id}`,
    name: info.displayName ? `${info.displayName} (Agent)` : `${prettyName(info.id)} (Agent)`,
    provider: PROVIDER_ID,
    maxTokens: info.contextWindow,
    contextWindow: info.contextWindow,
  };
}

function prettyName(id: string): string {
  switch (id) {
    case 'kimi-for-coding': return 'Kimi K2.6 (Kimi Code)';
    default: return id;
  }
}

function contextWindowFor(id: string): number | undefined {
  switch (id) {
    case 'kimi-for-coding': return 262_144;
    default: return undefined;
  }
}
