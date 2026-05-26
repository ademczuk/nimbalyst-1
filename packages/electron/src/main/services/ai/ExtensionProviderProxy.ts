/**
 * Main-process stand-in for an AI provider whose real implementation ships in a
 * marketplace extension and runs in the RENDERER.
 *
 * Extensions load in the renderer (nodeIntegration:false), but the session loop
 * (MessageStreamingHandler) constructs and drives providers in MAIN. This proxy
 * bridges the gap: it implements the AIProvider contract in main and delegates
 * each turn to the renderer-resident extension over IPC, yielding the
 * StreamChunks streamed back. The extension's transport spawns its CLI through
 * the streaming-spawn bridge (extension:spawn), so the child process still lives
 * in main while its protocol logic stays in the extension.
 *
 * One proxy instance per `${providerId}-${sessionId}` (ProviderFactory cache).
 * The renderer keeps a matching impl instance per sessionId, so a persistent
 * agent session (e.g. gemini --acp) survives across turns.
 */

import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import {
  BaseAIProvider,
  type ProviderConfig,
  type ProviderCapabilities,
  type StreamChunk,
} from '@nimbalyst/runtime/ai/server';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { logger } from '../../utils/logger';

/** Preview helper for ai-debug logging. */
function preview(value: string | undefined, max = 100): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Provider EventEmitter events the streaming handler subscribes to. The
 * renderer forwards these from the extension impl so the proxy can re-emit
 * them and the handler's listeners fire exactly as they do for built-ins. */
const FORWARDED_PROVIDER_EVENTS = [
  'message:logged',
  'session:title-updated',
  'session:metadata-updated',
  'exitPlanMode:confirm',
  'exitPlanMode:resolved',
  'askUserQuestion:pending',
  'askUserQuestion:answered',
  'toolPermission:pending',
  'toolPermission:resolved',
  'promptAdditions',
  'session:providerSessionExpired',
  'session:providerSessionReceived',
  'teammate:messageWhileIdle',
  'teammates:allCompleted',
] as const;

interface TurnSink {
  proxy: ExtensionProviderProxy;
  push: (chunk: StreamChunk) => void;
  end: (error?: string) => void;
  setSessionData: (sessionId: string, data: unknown) => void;
}

// turnId -> active sink. Module-global so a single set of ipcMain listeners
// routes renderer events to the right in-flight turn regardless of which
// proxy/session produced it.
const activeSinks = new Map<string, TurnSink>();
let ipcWired = false;

function wireIpcOnce(): void {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.on('ext-provider:turn:chunk', (_e, payload: { turnId: string; chunk: StreamChunk }) => {
    activeSinks.get(payload?.turnId)?.push(payload.chunk);
  });
  ipcMain.on('ext-provider:turn:event', (_e, payload: { turnId: string; event: string; args: unknown[] }) => {
    const sink = activeSinks.get(payload?.turnId);
    if (!sink) return;
    try {
      sink.proxy.emit(payload.event, ...(Array.isArray(payload.args) ? payload.args : []));
    } catch (err) {
      logger.main.warn(`[ExtensionProviderProxy] re-emit '${payload.event}' failed: ${String(err)}`);
    }
  });
  ipcMain.on('ext-provider:turn:sessionData', (_e, payload: { turnId: string; sessionId: string; data: unknown }) => {
    activeSinks.get(payload?.turnId)?.setSessionData(payload.sessionId, payload.data);
  });
  ipcMain.on('ext-provider:turn:end', (_e, payload: { turnId: string; error?: string }) => {
    activeSinks.get(payload?.turnId)?.end(payload?.error);
  });
}

/** Minimal push/pull async queue of StreamChunks fed by renderer IPC. */
class ChunkQueue {
  private readonly buffer: StreamChunk[] = [];
  private resolveNext: ((r: IteratorResult<StreamChunk>) => void) | null = null;
  private rejectNext: ((e: unknown) => void) | null = null;
  private finished = false;
  private failure: Error | null = null;

  push(chunk: StreamChunk): void {
    if (this.finished) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      this.rejectNext = null;
      r({ value: chunk, done: false });
    } else {
      this.buffer.push(chunk);
    }
  }

  end(error?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = error ? new Error(error) : null;
    if (this.failure && this.rejectNext) {
      const rej = this.rejectNext;
      this.resolveNext = null;
      this.rejectNext = null;
      rej(this.failure);
    } else if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      this.rejectNext = null;
      r({ value: undefined as unknown as StreamChunk, done: true });
    }
  }

  next(): Promise<IteratorResult<StreamChunk>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift() as StreamChunk, done: false });
    }
    if (this.finished) {
      return this.failure
        ? Promise.reject(this.failure)
        : Promise.resolve({ value: undefined as unknown as StreamChunk, done: true });
    }
    return new Promise((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }
}

let turnSeq = 0;

export class ExtensionProviderProxy extends BaseAIProvider {
  private readonly providerId: string;
  private readonly sessionData = new Map<string, unknown>();
  private readonly activeTurnIds = new Set<string>();

  constructor(providerId: string) {
    super();
    this.providerId = providerId;
    wireIpcOnce();
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  setProviderSessionData(sessionId: string, data: unknown): void {
    const existing = (this.sessionData.get(sessionId) as Record<string, unknown>) || {};
    this.sessionData.set(sessionId, { ...existing, ...(data as Record<string, unknown>) });
  }

  getProviderSessionData(sessionId: string): unknown {
    return this.sessionData.get(sessionId);
  }

  getCapabilities(): ProviderCapabilities {
    // Extension agent providers are assumed full-capability (the gemini-cli
    // reference impl is an MCP-capable, resumable ACP agent with file tools).
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,
      edits: true,
      resumeSession: true,
      supportsFileTools: true,
    };
  }

  private resolveWebContents(workspacePath?: string): WebContents | null {
    if (workspacePath) {
      const win = findWindowByWorkspace(workspacePath);
      if (win && !win.isDestroyed()) return win.webContents;
    }
    const fallback = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    return fallback ? fallback.webContents : null;
  }

  async *sendMessage(
    message: string,
    documentContext?: unknown,
    sessionId?: string,
    messages?: unknown[],
    workspacePath?: string,
    attachments?: unknown[]
  ): AsyncIterableIterator<StreamChunk> {
    const turnId = `extturn-${Date.now()}-${++turnSeq}`;
    const wc = this.resolveWebContents(workspacePath);

    if (!wc) {
      yield {
        type: 'error',
        error: `Extension provider '${this.providerId}' has no renderer to run in (no open window).`,
      };
      return;
    }

    // Persist the user input row up-front so the transcript shows the prompt
    // immediately and the session-completion path has a contiguous history.
    // Built-in providers (e.g. ClaudeProvider) do this themselves; the proxy
    // owes the same contract on behalf of extension impls that run in the
    // renderer (and have no main-side DB access).
    if (sessionId && message) {
      try {
        await this.logAgentMessage(sessionId, this.providerId, 'input', message, undefined, false, undefined, true);
      } catch (err) {
        logger.main.warn(`[ExtensionProviderProxy] failed to log user input for ${sessionId}: ${String(err)}`);
      }
    }

    const queue = new ChunkQueue();
    const sink: TurnSink = {
      proxy: this,
      push: chunk => queue.push(chunk),
      end: error => queue.end(error),
      setSessionData: (sid, data) => this.setProviderSessionData(sid, data),
    };
    activeSinks.set(turnId, sink);
    this.activeTurnIds.add(turnId);

    wc.send('ext-provider:turn:start', {
      providerId: this.providerId,
      turnId,
      sessionId,
      message,
      documentContext,
      messages,
      workspacePath,
      attachments,
      config: this.config,
      providerSessionData: sessionId ? this.sessionData.get(sessionId) : undefined,
    });

    // Buffer assistant text across `text` chunks so we can emit a single
    // canonical output row on `complete`. Most extension impls yield one final
    // text chunk and then a complete chunk carrying the same content; the
    // buffer also tolerates impls that stream multiple text fragments.
    let assistantTextBuffer = '';
    let loggedFinalText = false;

    const logFinalAssistantText = async (textOverride?: string) => {
      if (!sessionId) return;
      const text = textOverride !== undefined ? textOverride : assistantTextBuffer;
      if (!text || loggedFinalText) return;
      try {
        await this.logAgentMessage(
          sessionId,
          this.providerId,
          'output',
          JSON.stringify({ type: 'text', content: text }),
          undefined,
          false,
          undefined,
          true,
        );
        loggedFinalText = true;
        logger.ai.info('[ExtensionProviderProxy] logged final assistant text', {
          providerId: this.providerId,
          sessionId,
          length: text.length,
          preview: preview(text),
        });
      } catch (err) {
        logger.main.warn(
          `[ExtensionProviderProxy] failed to log assistant text for ${sessionId}: ${String(err)}`,
        );
      }
    };

    const logToolCall = async (chunk: StreamChunk) => {
      if (!sessionId || !chunk.toolCall) return;
      try {
        // Tool calls land as two chunks from the agent: first an args-only
        // chunk, then a follow-up with `result` populated. Only persist the
        // resolved row so the transcript shows the executed tool call once.
        if (chunk.toolCall.result === undefined) return;
        await this.logAgentMessage(
          sessionId,
          this.providerId,
          'output',
          JSON.stringify({
            type: 'tool_call',
            toolCall: {
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: chunk.toolCall.arguments,
              result: chunk.toolCall.result,
            },
          }),
        );
      } catch (err) {
        logger.main.warn(
          `[ExtensionProviderProxy] failed to log tool_call for ${sessionId}: ${String(err)}`,
        );
      }
    };

    try {
      while (true) {
        const r = await queue.next();
        if (r.done) break;
        const chunk = r.value;

        // Persist before yielding so the renderer's `ai:messages-logged-batch`
        // event fires (which is how the transcript actually re-renders).
        if (chunk.type === 'text' && typeof chunk.content === 'string') {
          assistantTextBuffer += chunk.content;
        } else if (chunk.type === 'tool_call') {
          await logToolCall(chunk);
        } else if (chunk.type === 'complete') {
          const finalText = typeof chunk.content === 'string' && chunk.content.length > 0
            ? chunk.content
            : assistantTextBuffer;
          await logFinalAssistantText(finalText);
        }

        yield chunk;
      }
      // Stream ended without a `complete` chunk -- some impls just drop the
      // generator after the last text. Flush the buffer so the transcript
      // still gets the assistant row.
      if (!loggedFinalText && assistantTextBuffer.length > 0) {
        await logFinalAssistantText();
      }
    } finally {
      activeSinks.delete(turnId);
      this.activeTurnIds.delete(turnId);
    }
  }

  abort(): void {
    const wc = this.resolveWebContents();
    for (const turnId of this.activeTurnIds) {
      activeSinks.get(turnId)?.end();
      wc?.send('ext-provider:turn:cancel', { turnId });
    }
    this.activeTurnIds.clear();
  }

  destroy(): void {
    this.abort();
    this.sessionData.clear();
    super.destroy();
  }
}
