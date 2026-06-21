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

/**
 * Model keys this agent provider surfaces.
 *
 * Mirrors the three tiers from AntigravityProvider (chat) so the dropdown shows
 * the same High / Medium / Low choices in agent sessions. Prior to 2026-05-26
 * only two keys (gemini-3-flash-agent and gemini-3.5-flash-low) were surfaced,
 * which left users in agent sessions thinking the picker was ignoring their
 * Medium/Low selection because the gap between catalog entries didn't match
 * the chat provider they had used previously.
 */
const SURFACED_MODEL_KEYS = new Set<string>([
  'gemini-3-flash-agent',       // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',       // Gemini 3.5 Flash (Medium)
  'gemini-3.5-flash-extra-low', // Gemini 3.5 Flash (Low)
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
          sawText = true;
          // ALWAYS yield a text chunk so the renderer's stream pipeline registers
          // the assistant's response. Dropping empty text chunks was the root
          // cause of the silent no-response bug: when GetModelResponse returns
          // whitespace or empty (which Gemini 3.5 Flash occasionally does on
          // long meta-agent system prompts with no tool calls available), an
          // `if (finalText)` guard suppressed the chunk entirely and the
          // renderer never received `ai:streamResponse`, leaving the chat input
          // "waiting". Substitute a visible placeholder when empty so the user
          // sees that the turn completed. Mirrors the fix originally landed in
          // commit 9abec8b7d on the runtime-side provider before this code
          // moved into the marketplace extension.
          const renderedText = finalText.trim().length === 0
            ? '(model returned no text)'
            : finalText;
          yield { type: 'text', content: renderedText };
        } else if (step.type === 'complete') {
          // Ensure the complete chunk also carries the rendered placeholder so
          // the host's transcript on reload mirrors what the user saw during
          // the turn. Persistence runs main-side in the host (the extension
          // does not call logAgentMessage directly); the host derives the
          // assistant message from the stream chunks, so the placeholder needs
          // to ride the text/complete chunks.
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
    let catalog: AntigravityModelInfo[];
    try {
      catalog = await AntigravityRpcClient.getAvailableModels();
    } catch (err) {
      // Re-wrap version-gate errors with a user-readable message so settings
      // panels can display actionable guidance instead of a generic failure.
      if (err instanceof Error && (err as Error & { isVersionGate?: boolean }).isVersionGate) {
        const wrapped = new Error(
          'Antigravity needs an update. Open the Antigravity IDE so it can update itself, then test again.',
        );
        (wrapped as Error & { isVersionGate: boolean }).isVersionGate = true;
        throw wrapped;
      }
      throw err;
    }
    const out: Array<{ id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number }> = [];
    for (const info of catalog) {
      if (!SURFACED_MODEL_KEYS.has(info.key)) continue;
      out.push(toAIModel(info));
    }
    const order = ['gemini-3-flash-agent', 'gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low'];
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
