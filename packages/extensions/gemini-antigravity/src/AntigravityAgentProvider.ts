/**
 * AntigravityAgentProvider (extension-side, renderer-safe).
 *
 * AGENT provider that surfaces Gemini 3.5 Flash with tool-calling. Ported from
 * packages/runtime/.../antigravity/AntigravityAgentProvider.ts.
 *
 * Heavy main-side dependencies that the runtime version uses (BaseAgentProvider,
 * buildClaudeCodeSystemPrompt, ProviderSessionManager, DB logging) live in the
 * main process. The renderer-side stub here defers each of them to main via the
 * `antigravity:agent:*` IPC channels (registered in AntigravityRpcHandlers).
 *
 * Architecture:
 *   - Tool definitions: fetched from main (`antigravity:agent:get-tools`)
 *   - System prompt: built in main (`antigravity:agent:get-system-prompt`)
 *   - Tool execution: dispatched to main (`antigravity:agent:execute-tool`)
 *   - Model RPC: AntigravityRpcClient.getModelResponse (already an IPC bridge)
 */

import type { StreamChunk } from '@nimbalyst/runtime/ai/server';
import { AntigravityRpcClient, type AntigravityModelInfo } from './antigravityRpcClient';
import { buildUserMessageAddition, type MinimalDocumentContext } from './documentContextUtils';
import { AntigravityToolLoopProtocol } from './AntigravityToolLoopProtocol';
import { TinyEmitter } from './emitter';

const PROVIDER_ID = 'antigravity-gemini-agent';

/** Stable model key for Gemini 3.5 Flash High. */
export const ANTIGRAVITY_AGENT_DEFAULT_KEY = 'gemini-3-flash-agent';

/** Model keys this agent provider surfaces. */
const SURFACED_MODEL_KEYS = new Set<string>([
  'gemini-3-flash-agent',
  'gemini-3.5-flash-low',
]);

interface AntigravityAgentConfig {
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

/** Main-side IPC for agent-specific helpers. */
class AgentRpc {
  static async getSystemPrompt(payload: { sessionId?: string; documentContext?: unknown }): Promise<string> {
    const api = window.electronAPI;
    const res = (await api.invoke('antigravity:agent:get-system-prompt', payload)) as { ok: boolean; data?: string; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'antigravity:agent:get-system-prompt failed');
    return res.data ?? '';
  }

  static async getTools(payload: { sessionId?: string; workspacePath?: string }): Promise<OpenAITool[]> {
    const api = window.electronAPI;
    const res = (await api.invoke('antigravity:agent:get-tools', payload)) as { ok: boolean; data?: OpenAITool[]; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'antigravity:agent:get-tools failed');
    return res.data ?? [];
  }

  static async executeTool(payload: { sessionId?: string; workspacePath?: string; name: string; args: Record<string, unknown> }): Promise<unknown> {
    const api = window.electronAPI;
    const res = (await api.invoke('antigravity:agent:execute-tool', payload)) as { ok: boolean; data?: unknown; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'antigravity:agent:execute-tool failed');
    return res.data;
  }
}

export interface AntigravityAgentProviderHost {
  spawn?: unknown;
}

export class AntigravityAgentProvider {
  static readonly DEFAULT_MODEL = ANTIGRAVITY_AGENT_DEFAULT_KEY;

  private readonly emitter = new TinyEmitter();
  private readonly toolLoop: AntigravityToolLoopProtocol;
  private config: AntigravityAgentConfig = {};
  private modelKey: string = AntigravityAgentProvider.DEFAULT_MODEL;
  private abortController: AbortController | null = null;

  /** Read back the last initialize() config (for debugging). */
  getConfig(): Readonly<AntigravityAgentConfig> {
    return this.config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_host?: AntigravityAgentProviderHost) {
    this.toolLoop = new AntigravityToolLoopProtocol({ modelKey: this.modelKey });
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
    const cfg = (rawConfig as AntigravityAgentConfig) || {};
    this.config = cfg;
    if (cfg.model) {
      this.modelKey = cfg.model.includes(':')
        ? cfg.model.split(':').slice(1).join(':')
        : cfg.model;
    }
    this.toolLoop.setModelKey(this.modelKey);
    await AntigravityRpcClient.ensureRunning();
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
      const lastToolResult = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

      for await (const step of this.toolLoop.run(
        userTurn,
        systemPrompt,
        tools,
        async (name, args) => AgentRpc.executeTool({ sessionId, workspacePath, name, args }),
      )) {
        if (ctrl.signal.aborted) break;

        if (step.type === 'tool_call') {
          const id = `agy-${Date.now()}-${toolCallSeq++}`;
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
          if (finalText) {
            yield { type: 'text', content: finalText };
          }
        } else if (step.type === 'complete') {
          yield { type: 'complete', content: finalText, isComplete: true };
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
    const catalog = await AntigravityRpcClient.getAvailableModels();
    const out: Array<{ id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number }> = [];
    for (const info of catalog) {
      if (!SURFACED_MODEL_KEYS.has(info.key)) continue;
      out.push(toAIModel(info));
    }
    const order = ['gemini-3-flash-agent', 'gemini-3.5-flash-low'];
    out.sort((a, b) => order.indexOf(stripPrefix(a.id)) - order.indexOf(stripPrefix(b.id)));
    return out;
  }
}

function toAIModel(info: AntigravityModelInfo): { id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number } {
  return {
    id: `${PROVIDER_ID}:${info.key}`,
    name: info.displayName ? `${info.displayName} (Agent)` : info.key,
    provider: PROVIDER_ID,
    maxTokens: info.maxTokens,
    contextWindow: info.maxTokens,
  };
}

function stripPrefix(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}
