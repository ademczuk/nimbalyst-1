/**
 * AntigravityProvider (extension-side, renderer-safe).
 *
 * Ported from packages/runtime/src/ai/server/providers/antigravity/AntigravityProvider.ts,
 * stripped of heavy main-only dependencies. The server lifecycle and HTTPS RPC
 * live in main behind the `antigravity:*` IPC bridge (see AntigravityRpcHandlers
 * + AntigravityRpcClient).
 *
 * CHAT provider (extends nothing - duck-types AIProvider): a single prompt +
 * attached document context yields a single text response chunk + complete.
 * Auth rides the user's ~/.gemini login; nimbalyst stores no API key.
 */

import type { StreamChunk } from '@nimbalyst/runtime/ai/server';
import { AntigravityRpcClient, type AntigravityModelInfo } from './antigravityRpcClient';
import { buildUserMessageAddition, type MinimalDocumentContext } from './documentContextUtils';
import { TinyEmitter } from './emitter';

const PROVIDER_ID = 'antigravity-gemini';

/** Stable model KEY for "Gemini 3.5 Flash (High)". */
export const ANTIGRAVITY_FLASH35_HIGH_KEY = 'gemini-3-flash-agent';

/** Model keys this provider surfaces to nimbalyst (stable across builds). */
const SURFACED_MODEL_KEYS = new Set<string>([
  'gemini-3-flash-agent',       // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',       // Gemini 3.5 Flash (Medium)
  'gemini-3.5-flash-extra-low', // Gemini 3.5 Flash (Low)
]);

interface AntigravityConfig {
  model?: string;
  [key: string]: unknown;
}

/** Host capability surface handed to the provider by the turn bridge. */
export interface AntigravityProviderHost {
  /** Unused for antigravity - kept for signature compat with extension-provider bridge. */
  spawn?: unknown;
}

export class AntigravityProvider {
  static readonly DEFAULT_MODEL = ANTIGRAVITY_FLASH35_HIGH_KEY;

  private readonly emitter = new TinyEmitter();
  private config: AntigravityConfig = {};
  private modelKey: string = AntigravityProvider.DEFAULT_MODEL;
  private aborted = false;

  /** Read back the last initialize() config (for debugging). */
  getConfig(): Readonly<AntigravityConfig> {
    return this.config;
  }

  // The extension turn bridge constructs with `new Ctor({ spawn })`; we accept
  // and ignore the host - server lifecycle is handled in main behind IPC.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_host?: AntigravityProviderHost) {
    // no-op
  }

  // --- EventEmitter surface ---

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

  // --- Lifecycle ---

  async initialize(rawConfig: unknown): Promise<void> {
    const cfg = (rawConfig as AntigravityConfig) || {};
    this.config = cfg;
    if (cfg.model) {
      // Accept either the provider-prefixed id ('antigravity-gemini:key') or a bare key.
      this.modelKey = cfg.model.includes(':')
        ? cfg.model.split(':').slice(1).join(':')
        : cfg.model;
    }
    // Validate connectivity early so misconfiguration surfaces before first send.
    await AntigravityRpcClient.ensureRunning();
  }

  setProviderSessionData(_sessionId: string, _data: unknown): void {
    // chat provider has no resumable session state
  }

  getProviderSessionData(_sessionId: string): unknown {
    return {};
  }

  abort(): void {
    this.aborted = true;
  }

  destroy(): void {
    this.abort();
    this.emitter.removeAllListeners();
  }

  // --- The turn ---

  async *sendMessage(
    message: string,
    documentContext?: unknown,
    sessionId?: string,
    _messages?: unknown[],
    _workspacePath?: string,
    _attachments?: unknown[],
  ): AsyncIterableIterator<StreamChunk> {
    this.aborted = false;

    const docCtx = (documentContext as MinimalDocumentContext | undefined) || undefined;
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, docCtx);
    const fullMessage = messageWithContext;

    if (!fullMessage || fullMessage.trim() === '') {
      yield { type: 'error', error: 'Cannot send empty message to Antigravity' };
      return;
    }

    // Emit prompt additions for the debugging UI (mirrors LMStudioProvider).
    if (sessionId && userMessageAddition) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    try {
      const text = await AntigravityRpcClient.getModelResponse(fullMessage, this.modelKey);

      if (this.aborted) return;

      if (text) {
        yield { type: 'text', content: text };
      }

      yield { type: 'complete', content: text, isComplete: true };
    } catch (err) {
      if (this.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: message };
    }
  }

  /**
   * Discover the models this provider exposes (stable keys -> {id,name,provider,...}).
   * Surfaces the Gemini 3.5 Flash family by default. Static so the settings UI can
   * call it without an initialized provider.
   */
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
    const order = ['gemini-3-flash-agent', 'gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low'];
    out.sort((a, b) => order.indexOf(stripPrefix(a.id)) - order.indexOf(stripPrefix(b.id)));
    return out;
  }
}

function toAIModel(info: AntigravityModelInfo): { id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number } {
  return {
    id: `${PROVIDER_ID}:${info.key}`,
    name: info.displayName || info.key,
    provider: PROVIDER_ID,
    maxTokens: info.maxTokens,
    contextWindow: info.maxTokens,
  };
}

function stripPrefix(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}
