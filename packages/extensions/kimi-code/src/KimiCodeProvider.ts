/**
 * KimiCodeProvider (extension-side, renderer-safe).
 *
 * CHAT provider that surfaces Moonshot Kimi K2.6 via the OpenAI-compatible
 * platform.moonshot.ai API. A single prompt + attached document context yields
 * a single text response chunk + complete. The Moonshot HTTP client + API key
 * resolution live in the main process behind the `kimi-code:*` IPC bridge
 * (see KimiCodeRpcHandlers); this class is renderer-safe and stores no key.
 *
 * Mirrors packages/extensions/gemini-antigravity/src/AntigravityProvider.ts.
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK contract lands
 * and the gemini extension is reshaped, the chat-only contribution moves to
 * the future aiProviders[] entry (reserved per Greg's reply on #96) and the
 * transport switches from window.electronAPI.invoke to the backend-module RPC
 * bridge. Surface area stays identical.
 */

import type { StreamChunk } from '@nimbalyst/runtime/ai/server';
import { KimiCodeRpcClient, type KimiCodeModelInfo } from './kimiCodeRpcClient';
import { buildUserMessageAddition, type MinimalDocumentContext } from './documentContextUtils';
import { TinyEmitter } from './emitter';

const PROVIDER_ID = 'kimi-code';

/** Default Moonshot model id. Latest stable K2 as of 2026: kimi-k2.6 (256K context). */
export const KIMI_CODE_DEFAULT_MODEL = 'kimi-k2.6';

/**
 * Model ids this provider surfaces by default. The host's getModels() pass
 * lands the live catalog from GET /v1/models, scoped to the K2 family in main.
 * This static set is the fallback when the catalog probe fails (e.g. no API
 * key entered yet) so the picker isn't empty.
 */
const SURFACED_MODEL_IDS = new Set<string>([
  'kimi-k2.6',
  'kimi-k2.5',
  'kimi-k2-thinking',
]);

interface KimiCodeConfig {
  model?: string;
  [key: string]: unknown;
}

/** Host capability surface handed to the provider by the turn bridge. */
export interface KimiCodeProviderHost {
  /** Unused for kimi-code - kept for signature compat with extension-provider bridge. */
  spawn?: unknown;
}

export class KimiCodeProvider {
  static readonly DEFAULT_MODEL = KIMI_CODE_DEFAULT_MODEL;

  private readonly emitter = new TinyEmitter();
  private config: KimiCodeConfig = {};
  private modelId: string = KimiCodeProvider.DEFAULT_MODEL;
  private aborted = false;

  /** Read back the last initialize() config (for debugging). */
  getConfig(): Readonly<KimiCodeConfig> {
    return this.config;
  }

  // The extension turn bridge constructs with `new Ctor({ spawn })`; we accept
  // and ignore the host - all heavy work runs in main behind IPC.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_host?: KimiCodeProviderHost) {
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
    const cfg = (rawConfig as KimiCodeConfig) || {};
    this.config = cfg;
    if (cfg.model) {
      // Accept either the provider-prefixed id ('kimi-code:kimi-k2.6') or a bare id.
      this.modelId = cfg.model.includes(':')
        ? cfg.model.split(':').slice(1).join(':')
        : cfg.model;
    }
    // Validate connectivity early so a missing/invalid API key surfaces before
    // the user fires the first message. testConnection() hits GET /v1/models
    // which is cheap and authenticated.
    await KimiCodeRpcClient.testConnection();
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
      yield { type: 'error', error: 'Cannot send empty message to Kimi Code' };
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
      const text = await KimiCodeRpcClient.complete({
        messages: [{ role: 'user', content: fullMessage }],
        model: this.modelId,
      });

      if (this.aborted) return;

      if (text) {
        yield { type: 'text', content: text };
      }

      yield { type: 'complete', content: text, isComplete: true };
    } catch (err) {
      if (this.aborted) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: errorMessage };
    }
  }

  /**
   * Discover the models this provider exposes. Static so the settings UI can
   * call it without an initialized provider.
   *
   * Tries the live catalog first via KimiCodeRpcClient.getAvailableModels()
   * (which hits GET /v1/models server-side). Falls back to the static list of
   * surfaced ids when the live probe fails (e.g. no API key yet).
   */
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
      // No API key yet, or platform unreachable. Fall back to the static set
      // so the picker isn't blank on first install.
      catalog = Array.from(SURFACED_MODEL_IDS).map(id => ({
        id,
        displayName: prettyName(id),
        contextWindow: contextWindowFor(id),
      }));
    }

    const out: Array<{ id: string; name: string; provider: string; maxTokens?: number; contextWindow?: number }> = [];
    for (const info of catalog) {
      // Only surface K2 family ids the picker knows about. Anything else
      // (e.g. moonshot-v1-* legacy ids) is hidden.
      if (!SURFACED_MODEL_IDS.has(info.id) && !info.id.startsWith('kimi-k2')) continue;
      out.push(toAIModel(info));
    }

    // Stable ordering: latest -> thinking -> compat.
    const order = ['kimi-k2.6', 'kimi-k2-thinking', 'kimi-k2.5'];
    out.sort((a, b) => {
      const ai = order.indexOf(stripPrefix(a.id));
      const bi = order.indexOf(stripPrefix(b.id));
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    });
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
    name: info.displayName || prettyName(info.id),
    provider: PROVIDER_ID,
    maxTokens: info.contextWindow,
    contextWindow: info.contextWindow,
  };
}

function stripPrefix(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}

function prettyName(id: string): string {
  switch (id) {
    case 'kimi-k2.6': return 'Kimi K2.6';
    case 'kimi-k2.5': return 'Kimi K2.5';
    case 'kimi-k2-thinking': return 'Kimi K2 Thinking';
    default: return id;
  }
}

function contextWindowFor(id: string): number | undefined {
  switch (id) {
    case 'kimi-k2.6': return 256_000;
    case 'kimi-k2.5': return 128_000;
    case 'kimi-k2-thinking': return 128_000;
    default: return undefined;
  }
}
