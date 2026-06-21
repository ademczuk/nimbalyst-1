/**
 * OpenClawBrainProvider — shared base for single-brain chat providers that
 * talk to a local OpenClaw-style FastAPI brain over HTTP /api/chat.
 *
 * 2026-05-21: built so nimbalyst can task Anismin (Opus 4.7 brain) and
 * Meridian (gpt-5.4 brain) the same way the KimiClawProvider tasks KCS —
 * but WITHOUT the swarm. These are single-turn request/response chats: one
 * prompt in, one synthesized reply out. No decomposition, no personas, no
 * cascade.
 *
 * Both brains are served by the same FastAPI process on adjacent ports
 * with an identical contract:
 *   POST <endpoint>  {"sender","conv_id","content"}
 *   ->   {"ok": true, "reply": "...", "model": "...", "intent": "...",
 *         "elapsed_ms": N, "task_id": null, "error": null}
 *
 * Subclasses (AnisminProvider, MeridianProvider) only differ in the
 * default endpoint, the model id namespace, and the persona label.
 *
 * Note on the brain's intent classifier: messages starting with an action
 * verb (build/fix/add/create/...) are classified TASK_REQUEST and the
 * brain auto-creates a dispatch task (returning a task_id) rather than a
 * plain chat reply. We surface the reply either way; if a task_id comes
 * back we note it so the operator knows a dispatch was spawned.
 */

import { BaseAIProvider } from '../AIProvider';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
} from '../types';
import { buildUserMessageAddition } from './documentContextUtils';

export interface OpenClawBrainConfig extends ProviderConfig {
  // Full URL of the brain's chat endpoint, e.g. http://127.0.0.1:18889/api/chat
  endpoint?: string;
}

export abstract class OpenClawBrainProvider extends BaseAIProvider {
  protected abortController: AbortController | null = null;

  /** Default chat endpoint for this brain (subclass overrides). */
  protected abstract defaultEndpoint(): string;
  /** Short label used in logs + the `sender` field sent to the brain. */
  protected abstract brainLabel(): string;

  private endpoint(): string {
    return (this.config as OpenClawBrainConfig)?.endpoint || this.defaultEndpoint();
  }

  async initialize(config: OpenClawBrainConfig): Promise<void> {
    this.config = config;
    // Cheap liveness probe so a misconfigured endpoint fails clearly at
    // session start rather than mid-stream. The brain has no GET health
    // route, so we just open a TCP connection via a HEAD-ish fetch and
    // tolerate any HTTP status (even 405) as "reachable".
    const url = this.endpoint();
    try {
      await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(4000) });
    } catch (err: any) {
      // OPTIONS may not be allowed; only a connection refusal is fatal.
      const msg = String(err?.cause?.code || err?.message || err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new Error(
          `Cannot reach ${this.brainLabel()} brain at ${url}. ` +
          `Ensure the brain process is running (the FastAPI service that ` +
          `serves /api/chat).`,
        );
      }
      // Any other error (timeout on OPTIONS, 405, etc.) is non-fatal.
    }
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    _workspacePath?: string,
    _attachments?: any[],
  ): AsyncIterableIterator<StreamChunk> {
    const { userMessageAddition, messageWithContext } =
      buildUserMessageAddition(message, documentContext);
    const content = messageWithContext;

    if (sessionId && userMessageAddition) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    if (!content || content.trim() === '') {
      yield { type: 'error', content: `Cannot send empty message to ${this.brainLabel()}` };
      yield { type: 'complete', isComplete: true };
      return;
    }

    // Persist the user input before dispatch (matches other providers).
    if (sessionId) {
      await this.logAgentMessage(sessionId, this.brainLabel().toLowerCase(), 'input', message);
    }

    this.abortController = new AbortController();
    const url = this.endpoint();
    const payload = {
      sender: 'nimbalyst',
      conv_id: sessionId || 'nimbalyst',
      content,
    };

    const t0 = Date.now();
    let body: any;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
        // Opus/codex brains can take 15-60s; allow a generous deadline.
        // The brain's own timeout governs the upper bound.
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        yield { type: 'error', content: `${this.brainLabel()} HTTP ${resp.status}: ${text.slice(0, 300)}` };
        yield { type: 'complete', isComplete: true };
        return;
      }
      body = await resp.json();
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        yield { type: 'error', content: `${this.brainLabel()} request aborted` };
      } else {
        yield { type: 'error', content: `${this.brainLabel()} request failed: ${String(err?.message || err)}` };
      }
      yield { type: 'complete', isComplete: true };
      return;
    }

    // Contract: {ok, reply, model, intent, task_id, error}
    if (!body?.ok) {
      const errMsg = body?.error || 'brain returned ok=false';
      yield { type: 'error', content: `${this.brainLabel()}: ${errMsg}` };
      yield { type: 'complete', isComplete: true };
      return;
    }

    let reply = String(body.reply ?? '');
    // If the brain's intent classifier spawned a dispatch task, annotate so
    // the operator knows a TASK_REQUEST was created rather than a plain chat.
    if (body.intent && body.intent !== 'SIMPLE_CHAT' && body.task_id) {
      reply += `\n\n_(${this.brainLabel()} classified this as ${body.intent} and spawned dispatch task ${body.task_id}.)_`;
    }

    if (sessionId) {
      await this.logAgentMessage(sessionId, this.brainLabel().toLowerCase(), 'output', reply);
    }

    yield { type: 'text', content: reply };
    yield { type: 'complete', isComplete: true };
    void t0;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  getCapabilities(): ProviderCapabilities {
    // Single-brain chat: one prompt in, one reply out. No tools, no MCP,
    // no streaming edits, no resumable agent session, and files are
    // attached as context (supportsFileTools=false) since the brain has
    // no file-read tools of its own over this transport.
    return {
      streaming: false,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: false,
      supportsFileTools: false,
    };
  }
}
