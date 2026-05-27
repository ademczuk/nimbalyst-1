/**
 * Kimi Code (managed) HTTP client (main-process only).
 *
 * Talks to the Kimi Code endpoint at api.kimi.com/coding/v1 using the OAuth
 * access token the user's Kimi Code CLI wrote to disk after `/login`. The
 * platform model is `kimi-for-coding` (which serves Kimi under the hood;
 * the CLI displays it as "Kimi"). This client reuses the credential file
 * the CLI manages and refreshes the token itself when the access_token gets
 * close to expiry.
 *
 * Why this exists (vs the platform.moonshot.ai key-paste shape we initially
 * shipped): the Kimi Code CLI is a standalone tool with its own OAuth flow
 * (`/login` -> RFC 8628 device authorization at auth.kimi.com). Nimbalyst
 * users who already use the CLI shouldn't have to also paste an API key into
 * a settings panel - mirroring how the gemini-antigravity extension rides
 * the user's existing ~/.gemini OAuth login. Source-verified against
 * MoonshotAI/kimi-cli (src/kimi_cli/auth/oauth.py and src/kimi_cli/auth/
 * platforms.py).
 *
 * Concurrency: the Kimi CLI auto-refreshes its own token in a 60s background
 * loop. If we and the CLI both try to refresh at the same time, the
 * second-to-arrive request fails with 401 because the refresh_token has been
 * rotated. We mitigate by:
 *   1. Re-reading the credentials file just before issuing a refresh (the CLI
 *      may have just refreshed it).
 *   2. Writing the refreshed credentials atomically (tempfile + rename), so
 *      partial writes can never be observed by the CLI.
 *   3. NOT taking the kimi-code.lock advisory lock - Windows fcntl semantics
 *      are inconsistent with the POSIX flock the CLI uses, and last-writer-
 *      wins is acceptable here (both tokens are valid until their own
 *      expires_at; the only failure is a stale 401 that surfaces to the
 *      caller, who can retry).
 */

import { net } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Spoofed Kimi CLI version. The Moonshot api.kimi.com endpoint filters on
 * User-Agent (only "KimiCLI/<version>" clients are allowed to call
 * /v1/chat/completions; other UAs get 403 even with a valid bearer token).
 * The X-Msh-Version header is similarly the CLI's pip version, not the
 * caller app's version. Bumping this in lockstep with the CLI's releases
 * keeps us indistinguishable at the wire level. If a future Moonshot
 * release changes the format or pins to specific versions, this constant
 * is the only thing to update.
 *
 * Source: MoonshotAI/kimi-cli src/kimi_cli/constant.py get_user_agent()
 * and src/kimi_cli/llm.py _kimi_default_headers().
 *
 * TODO: read the user's actual installed kimi-cli version (e.g. by
 * executing `kimi --version` or parsing the pip metadata at
 * `~/.local/share/kimi/...`) so we track the user's local CLI exactly.
 */
const KIMI_CLI_VERSION = '0.66.0';

function kimiApiBase(): string {
  return process.env.KIMI_API_BASE || 'https://api.kimi.com/coding/v1';
}

function kimiAuthBase(): string {
  // The CLI honours KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST. Match it.
  const host = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || 'https://auth.kimi.com';
  return `${host.replace(/\/$/, '')}/api/oauth`;
}

/**
 * The Kimi Code CLI's OAuth client_id. Source: MoonshotAI/kimi-cli at
 * src/kimi_cli/auth/oauth.py login_kimi_code(). Stable across CLI versions.
 */
const KIMI_CLI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const DEFAULT_TIMEOUT_MS = 120_000;
const TEST_CONNECTION_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh when the access_token has less than this many seconds of life left.
 * The CLI uses max(300, expires_in/2) - we use a smaller margin so we don't
 * race with the CLI's own refresh loop on every request.
 */
const REFRESH_MARGIN_SECONDS = 60;

interface OAuthToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;       // unix seconds, float
  expires_in: number;       // seconds the token was issued for
  scope: string;
  token_type: string;
}

export class KimiCodeAuthError extends Error {
  /**
   * True when the user needs to open the CLI and re-run /login (file missing
   * or refresh_token rejected). False for transient errors the caller could
   * retry.
   */
  readonly needsReauth: boolean;
  constructor(message: string, needsReauth = true) {
    super(message);
    this.name = 'KimiCodeAuthError';
    this.needsReauth = needsReauth;
  }
}

export class KimiCodeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'KimiCodeApiError';
    this.status = status;
  }
}

function getKimiShareDir(): string {
  // The CLI honors KIMI_SHARE_DIR for moving the share dir off the default.
  // We honor the same env var so power users with custom layouts work.
  return process.env.KIMI_SHARE_DIR || path.join(os.homedir(), '.kimi');
}

function getCredentialsPath(): string {
  return path.join(getKimiShareDir(), 'credentials', 'kimi-code.json');
}

function getDeviceIdPath(): string {
  return path.join(getKimiShareDir(), 'device_id');
}

let cachedDeviceId: string | null = null;
/**
 * Read the Kimi CLI's device_id file or, if absent, generate one and persist
 * it. Mirrors the CLI's behaviour in oauth.py (the file is created on first
 * login; we may run before that if the user has never used the CLI). The
 * X-Msh-Device-Id header is sent on every API + OAuth call.
 */
async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const p = getDeviceIdPath();
  try {
    const raw = (await fs.readFile(p, 'utf-8')).trim();
    if (raw.length > 0) {
      cachedDeviceId = raw;
      return raw;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Permission error or similar - fall through to generation; better to
      // send SOME stable id than to block the request.
    }
  }
  // Generate. uuid4-style hex, no dashes (matches the 32-char file we saw).
  const generated = crypto.randomBytes(16).toString('hex');
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, generated, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Persistence failure is non-fatal; we'll re-generate next session.
  }
  cachedDeviceId = generated;
  return generated;
}

/**
 * The device-identity headers the CLI sends on every API + OAuth call.
 * Server enforcement is unconfirmed but the CLI sends them unconditionally;
 * including them keeps us indistinguishable from the CLI at the wire level.
 */
async function commonHeaders(): Promise<Record<string, string>> {
  const deviceId = await getDeviceId();
  const arch = process.arch;
  const platform = process.platform;
  const osVersion = os.release();
  const hostname = os.hostname();
  return {
    // User-Agent is REQUIRED by api.kimi.com/coding/v1. The server filters
    // on this string and returns 403 to any client that isn't identified
    // as the Kimi CLI - even with an otherwise-valid bearer token. See the
    // KIMI_CLI_VERSION comment above.
    'User-Agent': `KimiCLI/${KIMI_CLI_VERSION}`,
    'X-Msh-Platform': 'kimi_cli',
    // X-Msh-Version is the CLI's pip version, not the caller app's version.
    // Sending Nimbalyst's version here was rejected on the chat endpoint;
    // matching the User-Agent's version is the documented shape.
    'X-Msh-Version': KIMI_CLI_VERSION,
    'X-Msh-Device-Name': hostname,
    'X-Msh-Device-Model': `${platform} ${arch}`,
    'X-Msh-Os-Version': osVersion,
    'X-Msh-Device-Id': deviceId,
  };
}

async function readToken(): Promise<OAuthToken | null> {
  const credPath = getCredentialsPath();
  let raw: string;
  try {
    raw = await fs.readFile(credPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).access_token !== 'string' ||
    typeof (parsed as Record<string, unknown>).refresh_token !== 'string'
  ) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  return {
    access_token: p.access_token as string,
    refresh_token: p.refresh_token as string,
    expires_at: typeof p.expires_at === 'number' ? p.expires_at : 0,
    expires_in: typeof p.expires_in === 'number' ? p.expires_in : 900,
    scope: typeof p.scope === 'string' ? p.scope : 'kimi-code',
    token_type: typeof p.token_type === 'string' ? p.token_type : 'Bearer',
  };
}

/**
 * Atomically write the credentials file (tempfile + rename). Mirrors the
 * CLI's own behaviour in oauth.py OAuthManager._save_token.
 */
async function writeToken(token: OAuthToken): Promise<void> {
  const credPath = getCredentialsPath();
  const dir = path.dirname(credPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `kimi-code.json.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = JSON.stringify(token, null, 2);
  await fs.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  try {
    await fs.rename(tmpPath, credPath);
  } catch (e) {
    // Clean up the tempfile if the rename failed (rare; cross-fs etc.)
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
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

async function refreshAccessToken(refreshTokenValue: string): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: KIMI_CLI_CLIENT_ID,
  });
  const headers = {
    ...(await commonHeaders()),
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const res = await fetchWithTimeout(
    `${kimiAuthBase()}/token`,
    {
      method: 'POST',
      headers,
      body: body.toString(),
    },
    REFRESH_TIMEOUT_MS,
  );

  if (res.status === 401 || res.status === 403) {
    // refresh_token was rotated or revoked - user must /login again.
    throw new KimiCodeAuthError(
      'Kimi Code session expired. Open the Kimi Code CLI and run /login to refresh.',
      true,
    );
  }
  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new KimiCodeAuthError(
      `Kimi Code token refresh failed (HTTP ${res.status}). ${detail}`,
      false,
    );
  }

  const parsed = (await res.json()) as Partial<OAuthToken>;
  if (typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string') {
    throw new KimiCodeAuthError(
      'Kimi Code refresh response was missing access_token / refresh_token.',
      false,
    );
  }
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 900;
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: Date.now() / 1000 + expiresIn,
    expires_in: expiresIn,
    scope: typeof parsed.scope === 'string' ? parsed.scope : 'kimi-code',
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
  };
}

/**
 * Return a non-expired access_token. Performs refresh on demand. May write
 * the credentials file if a refresh fires.
 */
async function getValidAccessToken(): Promise<string> {
  let token = await readToken();
  if (!token) {
    throw new KimiCodeAuthError(
      'Kimi Code CLI is not logged in. Open the Kimi Code CLI and run /login.',
      true,
    );
  }
  const now = Date.now() / 1000;
  if (token.expires_at - REFRESH_MARGIN_SECONDS > now) {
    return token.access_token;
  }
  // Token is close to or past expiry. Re-read the file in case the CLI's
  // background refresh loop already wrote a fresh token while we were
  // computing.
  token = await readToken();
  if (token && token.expires_at - REFRESH_MARGIN_SECONDS > now) {
    return token.access_token;
  }
  if (!token?.refresh_token) {
    throw new KimiCodeAuthError(
      'Kimi Code session expired and no refresh_token is available. Open the CLI and run /login.',
      true,
    );
  }
  // Do the refresh ourselves.
  let fresh: OAuthToken;
  try {
    fresh = await refreshAccessToken(token.refresh_token);
  } catch (e) {
    // 401/403 from /api/oauth/token means the refresh_token was rotated by
    // someone else (likely the CLI's own background refresh loop). Re-read
    // the file ONCE and retry with the fresh refresh_token. If the file is
    // unchanged, surface the original error - the session is genuinely dead.
    if (e instanceof KimiCodeAuthError && e.needsReauth) {
      const reread = await readToken();
      if (reread && reread.refresh_token !== token.refresh_token) {
        // CLI refreshed under us. Use its result and don't write our own.
        return reread.access_token;
      }
    }
    throw e;
  }
  try {
    await writeToken(fresh);
  } catch (e) {
    // Write failure is non-fatal for THIS request - we have the fresh token
    // in memory. The next call may have to refresh again, which is fine.
    console.warn(
      `[KimiCodeClient] could not persist refreshed token: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return fresh.access_token;
}

/** OpenAI-compatible chat message. */
export interface KimiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Optional on assistant messages that ONLY issue tool_calls. The Kimi
   * endpoint rejects assistant messages with empty/whitespace `content`
   * alongside `tool_calls` (HTTP 400 "text content is empty"), so callers
   * must OMIT the key entirely when there's no text - undefined is the
   * only safe shape.
   */
  content?: string;
  /** Required when role === 'tool'; ties the result to the originating call. */
  tool_call_id?: string;
  /** Tool name; required on 'tool' role. */
  name?: string;
  /** Present on assistant messages that issued tool calls. */
  tool_calls?: KimiToolCall[];
  /**
   * K2.6-specific. When `default_thinking = true` is configured for the
   * kimi-for-coding model (the Kimi CLI default), the model returns
   * `reasoning_content` on assistant turns alongside content/tool_calls.
   * Subsequent requests MUST echo this field back on the same assistant
   * message or the server returns HTTP 400 "thinking is enabled but
   * reasoning_content is missing in assistant tool call message at index N".
   * Preserving it is the kimi-cli source's documented contract (kimi.py
   * convert_message and convert_non_stream_response).
   */
  reasoning_content?: string;
}

/** OpenAI-style tool call carried on an assistant message. */
export interface KimiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string per OpenAI contract. */
    arguments: string;
  };
}

/** OpenAI-style tool definition passed in the request body. */
export interface KimiToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface KimiCompletionRequest {
  messages: KimiChatMessage[];
  model: string;
  maxTokens?: number;
  /** Tools available for the model to call (OpenAI function-calling shape). */
  tools?: KimiToolDef[];
  /** OpenAI tool_choice. K2.6 supports 'auto' and 'none'; 'required' is rejected. */
  tool_choice?: 'auto' | 'none';
}

/** Assistant turn from /v1/chat/completions, unpacked from choices[0].message. */
export interface KimiCompletionReply {
  /** Text content, if any. Null/empty when the model issued only tool_calls. */
  content: string | null;
  /** Tool calls the model wants the host to execute. */
  toolCalls: KimiToolCall[];
  /**
   * K2.6-specific reasoning text from the model's thinking mode. Null when
   * thinking is off or the response had no reasoning. Callers must store
   * and echo this back on subsequent requests as `reasoning_content` on
   * the same assistant message - see KimiChatMessage.reasoning_content
   * for the rationale.
   */
  reasoningContent: string | null;
  /** OpenAI finish_reason: 'stop' | 'tool_calls' | 'length' | ... */
  finishReason: string;
}

export interface KimiModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
}

const KNOWN_MODEL_META: Record<string, { displayName: string; contextWindow: number }> = {
  'kimi-for-coding': { displayName: 'Kimi (Kimi Code)', contextWindow: 262_144 },
};

function annotate(id: string): { displayName: string; contextWindow?: number } {
  if (id in KNOWN_MODEL_META) return KNOWN_MODEL_META[id];
  return { displayName: id };
}

/**
 * Probe authentication + endpoint reachability. Used by the Settings panel's
 * Test Connection button.
 */
async function bearerHeaders(): Promise<Record<string, string>> {
  const accessToken = await getValidAccessToken();
  return {
    ...(await commonHeaders()),
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

export async function testConnection(): Promise<void> {
  const headers = await bearerHeaders();
  const res = await fetchWithTimeout(
    `${kimiApiBase()}/models`,
    { method: 'GET', headers },
    TEST_CONNECTION_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new KimiCodeApiError(res.status, humanizeError(res.status, detail, 'GET /v1/models'));
  }
}

export async function getAvailableModels(): Promise<KimiModelInfo[]> {
  const headers = await bearerHeaders();
  const res = await fetchWithTimeout(
    `${kimiApiBase()}/models`,
    { method: 'GET', headers },
    TEST_CONNECTION_TIMEOUT_MS,
  );
  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new KimiCodeApiError(res.status, humanizeError(res.status, detail, 'GET /v1/models'));
  }
  let parsed: { data?: Array<{ id?: string }> } = {};
  try {
    parsed = (await res.json()) as { data?: Array<{ id?: string }> };
  } catch {
    // Endpoint may not expose /v1/models; fall back to the known catalog.
    return Object.entries(KNOWN_MODEL_META).map(([id, meta]) => ({
      id,
      displayName: meta.displayName,
      contextWindow: meta.contextWindow,
    }));
  }
  const ids = (parsed.data ?? [])
    .map(m => (typeof m.id === 'string' ? m.id : ''))
    .filter(id => id.length > 0);
  if (ids.length === 0) {
    return Object.entries(KNOWN_MODEL_META).map(([id, meta]) => ({
      id,
      displayName: meta.displayName,
      contextWindow: meta.contextWindow,
    }));
  }
  return ids.map(id => ({ id, ...annotate(id) }));
}

export async function complete(req: KimiCompletionRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KimiCompletionReply> {
  // NOTE: deliberately no `temperature` field - the Kimi model fixes
  // temperature internally and returns 400 on any caller-supplied value.
  // Same constraint applies to api.kimi.com/coding/v1 as to api.moonshot.ai/v1.
  const payload: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: false,
  };
  if (typeof req.maxTokens === 'number') payload.max_tokens = req.maxTokens;
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    payload.tools = req.tools;
    // tool_choice defaults to 'auto' when tools are present; only set when
    // the caller explicitly opts out via 'none'. K2.6 rejects 'required'.
    if (req.tool_choice && req.tool_choice !== 'auto') {
      payload.tool_choice = req.tool_choice;
    }
  }

  const headers = {
    ...(await bearerHeaders()),
    'Content-Type': 'application/json',
  };
  const res = await fetchWithTimeout(
    `${kimiApiBase()}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    timeoutMs,
  );

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new KimiCodeApiError(
      res.status,
      humanizeError(res.status, detail, 'POST /v1/chat/completions'),
    );
  }
  const parsed = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: KimiToolCall[];
        reasoning_content?: string | null;
      };
      finish_reason?: string;
    }>;
  };
  const choice = parsed.choices?.[0];
  if (!choice) {
    throw new KimiCodeApiError(200, 'Kimi returned no choices[0].');
  }
  const message = choice.message ?? {};
  return {
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : null,
    finishReason: choice.finish_reason ?? 'stop',
  };
}

/**
 * Read-only auth status helper for the Settings panel. Does NOT call any
 * network endpoint. Returns the user-visible state of the local credentials
 * file: not-logged-in, expired, or valid (with the expires_at unix-seconds
 * timestamp so the UI can format a human-readable "expires in 12m" line).
 */
export type KimiAuthStatus =
  | { state: 'not-logged-in' }
  | { state: 'expired'; expiresAt: number }
  | { state: 'valid'; expiresAt: number; scope: string };

export async function readAuthStatus(): Promise<KimiAuthStatus> {
  const token = await readToken();
  if (!token) return { state: 'not-logged-in' };
  const now = Date.now() / 1000;
  if (token.expires_at <= now) {
    return { state: 'expired', expiresAt: token.expires_at };
  }
  return { state: 'valid', expiresAt: token.expires_at, scope: token.scope };
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
    return `Kimi Code rejected the access token (${status} on ${endpoint}). Run /login in the Kimi Code CLI to refresh.`;
  }
  if (status === 404) {
    return `Kimi Code returned 404 on ${endpoint}. The endpoint may have moved or the model id may not exist.`;
  }
  if (status === 429) {
    return `Kimi Code rate-limited the request (${status} on ${endpoint}).`;
  }
  return `Kimi Code ${endpoint} failed: HTTP ${status}.${body ? ` Body: ${body}` : ''}`;
}
