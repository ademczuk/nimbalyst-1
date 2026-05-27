/**
 * Moonshot Kimi K2 platform HTTP client (main-process only).
 *
 * Wraps the OpenAI-compatible API at https://api.moonshot.ai/v1 with two
 * endpoints used by the kimi-code extension:
 *
 *   - GET  /v1/models             -> list available models (auth probe + catalog)
 *   - POST /v1/chat/completions   -> non-streaming chat completion
 *
 * API key resolution follows the repo's "Never Use Environment Variables as
 * Implicit API Key Sources" rule (packages/electron/CLAUDE.md): the key comes
 * ONLY from the user's electron-store ai-settings.apiKeys['kimi-code'] slot,
 * never process.env.MOONSHOT_API_KEY (or any other env fallback).
 *
 * Uses Electron's net.fetch so we ride the system proxy + cert store and
 * don't add a Node-fetch / undici dependency.
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK contract
 * lands, this client moves INSIDE the kimi-code extension's backend-module
 * (utility-process runtime). The HTTP surface stays identical; only the
 * caller (IPC bridge -> backend-module RPC bridge) changes.
 */

import { net } from 'electron';
import Store from 'electron-store';

const MOONSHOT_API_BASE = 'https://api.moonshot.ai/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const TEST_CONNECTION_TIMEOUT_MS = 15_000;

let aiSettingsStore: Store<Record<string, unknown>> | null = null;
function getAiSettingsStore(): Store<Record<string, unknown>> {
  if (!aiSettingsStore) {
    // Lazy init per the CLAUDE.md Lazy Initialization Pattern - the store must
    // not be constructed before app.setPath('userData') has run in bootstrap.ts.
    aiSettingsStore = new Store<Record<string, unknown>>({ name: 'ai-settings' });
  }
  return aiSettingsStore;
}

/**
 * Read the Moonshot API key from electron-store. NEVER falls back to env.
 * Returns null if the user hasn't entered a key yet so callers can surface
 * an actionable error instead of sending an unauthenticated request.
 *
 * Slot name is "moonshot" (vendor-level), not "kimi-code" (provider-level),
 * because one Moonshot account funds both the kimi-code chat and kimi-code-
 * agent providers. Naming by vendor avoids ambiguity if the provider id
 * surface ever changes.
 */
export function getMoonshotApiKey(): string | null {
  const apiKeys = (getAiSettingsStore().get('apiKeys', {}) as Record<string, string>) || {};
  const key = apiKeys['moonshot'];
  if (typeof key !== 'string' || key.trim() === '') return null;
  return key.trim();
}

export class MissingMoonshotApiKeyError extends Error {
  constructor() {
    super(
      'Moonshot API key not set. Open Global Settings -> Kimi Code and paste a key from platform.moonshot.ai.',
    );
    this.name = 'MissingMoonshotApiKeyError';
  }
}

export class MoonshotApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MoonshotApiError';
    this.status = status;
  }
}

export interface MoonshotChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface MoonshotCompletionRequest {
  messages: MoonshotChatMessage[];
  model: string;
  maxTokens?: number;
  /**
   * NOTE: temperature is DROPPED from the outbound request body.
   *
   * Kimi K2.6 fixes temperature internally (1.0 in thinking mode, 0.6 in non-
   * thinking) and returns HTTP 400 on ANY caller-supplied temperature value
   * (verified against Moonshot's K2.6 quickstart docs). The field stays here
   * for API parity with the rest of the codebase but is intentionally not
   * forwarded.
   */
  temperature?: number;
}

export interface MoonshotModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
}

/** Pretty display name + context window hint for surfaced K2 ids. */
function annotate(id: string): { displayName: string; contextWindow?: number } {
  switch (id) {
    case 'kimi-k2.6': return { displayName: 'Kimi K2.6', contextWindow: 256_000 };
    case 'kimi-k2.5': return { displayName: 'Kimi K2.5', contextWindow: 128_000 };
    case 'kimi-k2-thinking': return { displayName: 'Kimi K2 Thinking', contextWindow: 128_000 };
    default: {
      if (id.startsWith('kimi-k2')) return { displayName: id };
      return { displayName: id };
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Probe GET /v1/models. Throws MissingMoonshotApiKeyError or MoonshotApiError on failure. */
export async function testConnection(): Promise<void> {
  const key = getMoonshotApiKey();
  if (!key) throw new MissingMoonshotApiKeyError();

  const res = await fetchWithTimeout(
    `${MOONSHOT_API_BASE}/models`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    },
    TEST_CONNECTION_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await safeReadBody(res);
    throw new MoonshotApiError(
      res.status,
      humanizeError(res.status, body, 'GET /v1/models'),
    );
  }
}

/** GET /v1/models, scoped to the K2 family ids the picker surfaces. */
export async function getAvailableModels(): Promise<MoonshotModelInfo[]> {
  const key = getMoonshotApiKey();
  if (!key) throw new MissingMoonshotApiKeyError();

  const res = await fetchWithTimeout(
    `${MOONSHOT_API_BASE}/models`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    },
    TEST_CONNECTION_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await safeReadBody(res);
    throw new MoonshotApiError(
      res.status,
      humanizeError(res.status, body, 'GET /v1/models'),
    );
  }

  const parsed = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (parsed.data ?? [])
    .map(m => (typeof m.id === 'string' ? m.id : ''))
    .filter(id => id.length > 0);

  // Scope to K2 ids. Anything else (legacy moonshot-v1-*, vision-only ids, etc)
  // is hidden from the picker so users don't try to pick something the extension
  // hasn't validated.
  return ids
    .filter(id => id.startsWith('kimi-k2'))
    .map(id => ({ id, ...annotate(id) }));
}

/** POST /v1/chat/completions. Returns the assistant content string. */
export async function complete(req: MoonshotCompletionRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const key = getMoonshotApiKey();
  if (!key) throw new MissingMoonshotApiKeyError();

  const payload: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: false,
  };
  if (typeof req.maxTokens === 'number') payload.max_tokens = req.maxTokens;
  // temperature is intentionally NOT forwarded - see MoonshotCompletionRequest
  // for the K2.6 internal-temperature constraint.

  const res = await fetchWithTimeout(
    `${MOONSHOT_API_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  if (!res.ok) {
    const body = await safeReadBody(res);
    throw new MoonshotApiError(
      res.status,
      humanizeError(res.status, body, 'POST /v1/chat/completions'),
    );
  }

  const parsed = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = parsed.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new MoonshotApiError(200, 'Moonshot returned an empty response body (no choices[0].message.content).');
  }
  return text;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1_000);
  } catch {
    return '';
  }
}

function humanizeError(status: number, body: string, endpoint: string): string {
  if (status === 401 || status === 403) {
    return `Moonshot rejected the API key (${status} on ${endpoint}). Check the key under Global Settings -> Kimi Code.`;
  }
  if (status === 404) {
    return `Moonshot returned 404 on ${endpoint}. The endpoint may have moved or the model id may not exist on the platform.`;
  }
  if (status === 429) {
    return `Moonshot rate-limited the request (${status} on ${endpoint}). Slow down or check your platform quota.`;
  }
  const bodyTail = body ? ` Body: ${body}` : '';
  return `Moonshot ${endpoint} failed: HTTP ${status}.${bodyTail}`;
}
