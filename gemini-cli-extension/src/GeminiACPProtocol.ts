/**
 * Google Gemini CLI ACP Protocol Adapter (standalone, host.spawn transport)
 *
 * Ported from packages/runtime/src/ai/server/protocols/GeminiACPProtocol.ts.
 * The ACP logic (initialize handshake, session/new, session/load,
 * session/prompt, session/update -> event mapping, session/request_permission
 * auto-response, usage extraction from _meta.quota) is byte-for-byte identical
 * to the original. ONLY the I/O changed:
 *
 *   - No `import { spawn } from 'child_process'`.
 *   - The process is spawned in the MAIN process via the host-provided
 *     `host.spawn(command, args, { env })`, which returns an
 *     ExtensionSpawnHandle (write / kill / onStdout / onStderr / onExit).
 *   - stdout is accumulated and split on newlines here (no node 'readline').
 *   - The Windows .cmd CVE shell logic is DROPPED - the main-side spawn bridge
 *     already runs a .cmd/.bat shim through a shell on Windows.
 *
 * The transport split: this protocol object runs in the RENDERER, but the
 * gemini --acp child process lives in MAIN behind the spawn handle.
 */

import type { ExtensionSpawnHandle } from '@nimbalyst/extension-sdk';
import type {
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './protocolTypes';

/** Spawn capability handed in by the host (bound to this extension's id). */
export type HostSpawn = (
  command: string,
  args?: string[],
  options?: { cwd?: string; env?: Record<string, string> }
) => Promise<ExtensionSpawnHandle>;

interface ACPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface ACPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface ACPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class GeminiACPProtocol {
  readonly platform = 'gemini-acp';

  private readonly hostSpawn: HostSpawn;
  private handle: ExtensionSpawnHandle | null = null;
  private spawnPromise: Promise<ExtensionSpawnHandle> | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(notification: ACPNotification) => void> = [];
  private command: string;
  private baseArgs: string[];
  private processEnv: Record<string, string> | undefined;
  private initialized = false;

  constructor(hostSpawn: HostSpawn, geminiPath?: string) {
    this.hostSpawn = hostSpawn;
    this.command = geminiPath || 'gemini';
    this.baseArgs = ['--acp'];
  }

  setGeminiPath(path: string): void {
    this.command = path;
    this.baseArgs = ['--acp'];
  }

  setCommand(command: string, args: string[]): void {
    this.command = command;
    this.baseArgs = args;
  }

  setProcessEnv(env: Record<string, string> | undefined): void {
    this.processEnv = env;
  }

  /**
   * Acquire (or reuse) the spawned gemini --acp process. The main-side spawn
   * bridge handles the Windows .cmd shell case, so we just hand it the bare
   * command + args. Idempotent: concurrent callers share one spawn.
   */
  private async ensureProcess(): Promise<ExtensionSpawnHandle> {
    if (this.handle) {
      return this.handle;
    }
    if (this.spawnPromise) {
      return this.spawnPromise;
    }

    this.spawnPromise = (async () => {
      const handle = await this.hostSpawn(this.command, this.baseArgs, {
        env: this.processEnv,
      });
      this.handle = handle;

      handle.onStdout((chunk: string) => {
        this.onStdoutChunk(chunk);
      });

      handle.onStderr((chunk: string) => {
        console.warn('[GEMINI-ACP] stderr:', chunk);
      });

      handle.onExit((info: { code: number | null; signal: string | null }) => {
        console.log(`[GEMINI-ACP] Process exited: code=${info.code}, signal=${info.signal}`);
        this.rejectAllPending(new Error(`Gemini process exited (code=${info.code})`));
        this.handle = null;
        this.spawnPromise = null;
        this.initialized = false;
        this.stdoutBuffer = '';
      });

      return handle;
    })();

    try {
      return await this.spawnPromise;
    } catch (error) {
      this.spawnPromise = null;
      throw error;
    }
  }

  /** Buffer stdout and emit one handleLine() per complete newline-terminated line. */
  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: ACPResponse | ACPNotification;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[GEMINI-ACP] Unparseable line:', line.slice(0, 200));
      return;
    }

    const hasId = 'id' in parsed && typeof (parsed as ACPResponse).id === 'number';
    const hasMethod = 'method' in parsed && typeof (parsed as ACPRequest).method === 'string';

    // Server -> client request (e.g. session/request_permission). It carries both
    // an id and a method and REQUIRES a JSON-RPC response, otherwise the agent
    // stalls waiting on the result (this is how tool-call approvals are gated).
    if (hasId && hasMethod) {
      this.handleServerRequest(parsed as ACPRequest);
      return;
    }

    if (hasId) {
      const response = parsed as ACPResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          const detail = response.error.data ? ` (${JSON.stringify(response.error.data)})` : '';
          pending.reject(new Error(`${response.error.message}${detail}`));
        } else {
          pending.resolve(response.result);
        }
      }
    } else if (hasMethod) {
      for (const handler of this.notificationHandlers) {
        handler(parsed as ACPNotification);
      }
    }
  }

  private handleServerRequest(request: ACPRequest): void {
    const handle = this.handle;
    if (!handle) return;

    let result: unknown = {};

    if (/request_permission/i.test(request.method)) {
      // The Nimbalyst turn-level gate already approved this turn (allow-all /
      // bypass-all is required before any turn runs), so auto-approve the
      // per-tool ACP permission prompts instead of stalling. Prefer a one-shot
      // "allow" from whatever options the agent offered.
      const options = (request.params?.options as Array<{ optionId?: string; kind?: string }> | undefined) || [];
      const pick =
        options.find((o) => o.kind === 'allow_once') ||
        options.find((o) => typeof o.kind === 'string' && o.kind.startsWith('allow')) ||
        options.find((o) => !/reject|cancel|deny/i.test(`${o.kind ?? ''} ${o.optionId ?? ''}`)) ||
        options[0];
      result = { outcome: { outcome: 'selected', optionId: pick?.optionId ?? 'proceed_once' } };
    }

    void handle
      .write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
      .catch((error: unknown) => {
        console.warn('[GEMINI-ACP] Failed to answer server request:', error);
      });
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const handle = await this.ensureProcess();
    const id = this.nextRequestId++;
    const request: ACPRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      handle.write(JSON.stringify(request) + '\n').catch((error: unknown) => {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const handle = await this.ensureProcess();
    const notification: ACPNotification = { jsonrpc: '2.0', method, params };
    await handle.write(JSON.stringify(notification) + '\n');
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.ensureProcess();

    try {
      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'nimbalyst', version: '1.0.0' },
        capabilities: {},
      });
      this.initialized = true;
      console.log('[GEMINI-ACP] Protocol initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/auth|login|token|unauthorized|forbidden|credentials/i.test(msg)) {
        throw new Error(
          'Google Gemini CLI is not logged in. Run `gemini` in your terminal and complete the OAuth flow to authenticate.'
        );
      }
      throw error;
    }
  }

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    await this.ensureInitialized();

    const params: Record<string, unknown> = {
      cwd: options.workspacePath || '.',
      mcpServers: options.mcpServers ? this.formatMcpServers(options.mcpServers) : [],
    };

    try {
      const result = await this.sendRequest('session/new', params) as Record<string, unknown>;
      const sessionId = (result?.sessionId as string) || `gemini-${Date.now()}`;
      console.log('[GEMINI-ACP] Session created:', sessionId);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/auth|login|token|unauthorized|forbidden|credentials/i.test(msg)) {
        throw new Error(
          'Google Gemini CLI is not logged in. Run `gemini` in your terminal and complete the OAuth flow to authenticate.'
        );
      }
      throw error;
    }
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    await this.ensureInitialized();

    try {
      const result = await this.sendRequest('session/load', {
        sessionId,
        cwd: options.workspacePath || '.',
        mcpServers: options.mcpServers ? this.formatMcpServers(options.mcpServers) : [],
      }) as Record<string, unknown>;
      console.log('[GEMINI-ACP] Session resumed:', sessionId);

      return {
        id: sessionId,
        platform: this.platform,
        raw: { result },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (/already loaded/i.test(msg)) {
        console.log('[GEMINI-ACP] Session already loaded, reusing:', sessionId);
        return {
          id: sessionId,
          platform: this.platform,
          raw: { alreadyLoaded: true },
        };
      }

      console.warn('[GEMINI-ACP] Resume failed, creating new session:', error);
      return this.createSession(options);
    }
  }

  async forkSession(_sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    console.warn('[GEMINI-ACP] ACP does not support session forking. Creating new session.');
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    await this.ensureProcess();

    let fullText = '';
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;

    const notificationQueue: ACPNotification[] = [];
    let notificationResolve: (() => void) | null = null;
    let streamComplete = false;

    const onNotification = (notification: ACPNotification) => {
      notificationQueue.push(notification);
      if (notificationResolve) {
        notificationResolve();
        notificationResolve = null;
      }
    };

    this.notificationHandlers.push(onNotification);

    try {
      let sendError: Error | null = null;

      let promptResult: unknown = null;
      const sendPromise = this.sendRequest('session/prompt', {
        sessionId: session.id,
        prompt: [
          { type: 'text', text: message.content },
        ],
      });

      sendPromise.then((res) => {
        promptResult = res;
        streamComplete = true;
        if (notificationResolve) {
          notificationResolve();
          notificationResolve = null;
        }
      }).catch((err) => {
        sendError = err instanceof Error ? err : new Error(String(err));
        streamComplete = true;
        if (notificationResolve) {
          notificationResolve();
          notificationResolve = null;
        }
      });

      while (true) {
        while (notificationQueue.length > 0) {
          const notification = notificationQueue.shift()!;

          yield {
            type: 'raw_event',
            metadata: { rawEvent: notification },
          };

          const events = this.parseNotification(notification);
          for (const event of events) {
            if (event.type === 'text' && event.content) {
              fullText += event.content;
            }
            if (event.usage) {
              usage = event.usage;
            }
            yield event;
          }
        }

        if (streamComplete && notificationQueue.length === 0) {
          break;
        }

        await new Promise<void>((resolve) => {
          notificationResolve = resolve;
        });
      }

      if (sendError && !fullText) {
        yield { type: 'error', error: (sendError as Error).message };
      } else {
        yield {
          type: 'complete',
          content: fullText,
          usage: usage ?? this.extractUsage(promptResult) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield {
        type: 'error',
        error: errorMessage,
      };
    } finally {
      const idx = this.notificationHandlers.indexOf(onNotification);
      if (idx >= 0) {
        this.notificationHandlers.splice(idx, 1);
      }
    }
  }

  abortSession(_session: ProtocolSession): void {
    void this.sendNotification('session/cancel', { sessionId: _session.id }).catch(() => {
      // process may already be gone
    });
  }

  cleanupSession(_session: ProtocolSession): void {
    // No-op; ACP process stays alive for reuse
  }

  destroy(): void {
    if (this.handle) {
      void this.handle.kill().catch(() => {
        // already dead
      });
    }
    this.handle = null;
    this.spawnPromise = null;
    this.initialized = false;
    this.stdoutBuffer = '';
    this.rejectAllPending(new Error('Protocol destroyed'));
    this.notificationHandlers = [];
  }

  private formatMcpServers(mcpServers: Record<string, unknown>): unknown[] {
    const servers: unknown[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      if (!config || typeof config !== 'object') continue;
      const sc = config as Record<string, unknown>;
      const converted = this.convertToACPMcpServer(name, sc);
      if (converted) servers.push(converted);
    }
    return servers;
  }

  private convertToACPMcpServer(name: string, sc: Record<string, unknown>): Record<string, unknown> | null {
    const type = typeof sc.type === 'string' ? sc.type : (typeof sc.url === 'string' ? 'sse' : 'stdio');

    if (type === 'http' || type === 'sse') {
      if (typeof sc.url !== 'string') return null;
      return {
        name,
        type,
        url: sc.url,
        headers: this.toKeyValueArray(sc.headers ?? sc.http_headers),
      };
    }

    if (typeof sc.command !== 'string') return null;
    return {
      name,
      type: 'stdio',
      command: sc.command,
      args: Array.isArray(sc.args) ? sc.args : [],
      env: this.toKeyValueArray(sc.env),
    };
  }

  private toKeyValueArray(obj: unknown): Array<{ name: string; value: string }> {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ name: k, value: v as string }));
  }

  private firstString(...vals: unknown[]): string | undefined {
    for (const v of vals) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  }

  private extractToolContentText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const inner = rec.content as Record<string, unknown> | undefined;
      if (inner && typeof inner.text === 'string') parts.push(inner.text);
      else if (typeof rec.text === 'string') parts.push(rec.text);
    }
    const joined = parts.join('');
    return joined.length > 0 ? joined : undefined;
  }

  private extractUsage(promptResult: unknown): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined {
    if (!promptResult || typeof promptResult !== 'object') return undefined;
    const meta = (promptResult as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
    const quota = meta?.quota as Record<string, unknown> | undefined;
    const tc = quota?.token_count as Record<string, unknown> | undefined;
    if (!tc) return undefined;
    const input = typeof tc.input_tokens === 'number' ? tc.input_tokens : 0;
    const output = typeof tc.output_tokens === 'number' ? tc.output_tokens : 0;
    return { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }

  private parseNotification(notification: ACPNotification): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    const method = notification.method;
    const params = notification.params || {};

    switch (method) {
      case 'session/update': {
        const update = params.update as Record<string, unknown> | undefined;
        if (!update) break;

        const updateType = update.sessionUpdate as string | undefined;
        const content = update.content as Record<string, unknown> | undefined;

        if (updateType === 'agent_message_chunk' && content) {
          const contentType = content.type as string | undefined;
          switch (contentType) {
            case 'text': {
              const text = typeof content.text === 'string' ? content.text : '';
              if (text) events.push({ type: 'text', content: text });
              break;
            }
            case 'thinking':
            case 'reasoning': {
              const text = typeof content.text === 'string' ? content.text : '';
              if (text) events.push({ type: 'reasoning', content: text });
              break;
            }
            default:
              break;
          }
        } else if (updateType === 'agent_thought_chunk' && content) {
          // Gemini streams reasoning as a distinct update type.
          const text = typeof content.text === 'string' ? content.text : '';
          if (text) events.push({ type: 'reasoning', content: text });
        } else if (updateType === 'tool_call' || updateType === 'tool_use') {
          events.push({
            type: 'tool_call',
            toolCall: {
              id: this.firstString(update.toolCallId, update.id, content?.id),
              name: this.firstString(update.title, update.name, update.kind, content?.name) ?? 'unknown',
              arguments: (update.arguments ?? update.input ?? update.rawInput ?? content?.arguments ?? content?.input) as Record<string, unknown> | undefined,
            },
          });
        } else if (updateType === 'tool_call_update') {
          // Gemini reports status transitions (in_progress -> completed/failed)
          // as tool_call_update; surface terminal states as a tool result.
          const status = typeof update.status === 'string' ? update.status : '';
          if (status === 'completed' || status === 'failed') {
            events.push({
              type: 'tool_result',
              toolResult: {
                id: this.firstString(update.toolCallId, update.id),
                name: this.firstString(update.title, update.name) ?? 'unknown',
                result: (this.extractToolContentText(update.content) ?? update.output ?? content?.output) as ToolResult | string | undefined,
              },
            });
          }
        } else if (updateType === 'tool_result') {
          events.push({
            type: 'tool_result',
            toolResult: {
              id: this.firstString(update.toolCallId, update.id, content?.id),
              name: this.firstString(update.title, update.name, content?.name) ?? 'unknown',
              result: (this.extractToolContentText(update.content) ?? update.output ?? content?.output) as ToolResult | string | undefined,
            },
          });
        } else if (updateType === 'error') {
          const errorMsg = typeof update.message === 'string' ? update.message :
                           typeof content?.message === 'string' ? content.message : 'Unknown error';
          events.push({ type: 'error', error: errorMsg });
        }
        break;
      }

      case 'stream/text':
      case 'message/text': {
        const content = typeof params.content === 'string' ? params.content : '';
        if (content) events.push({ type: 'text', content });
        break;
      }

      case 'stream/reasoning':
      case 'message/reasoning': {
        const content = typeof params.content === 'string' ? params.content : '';
        if (content) events.push({ type: 'reasoning', content });
        break;
      }

      case 'tool/call':
      case 'stream/toolCall': {
        events.push({
          type: 'tool_call',
          toolCall: {
            id: typeof params.id === 'string' ? params.id : undefined,
            name: typeof params.name === 'string' ? params.name : 'unknown',
            arguments: (params.arguments as Record<string, unknown>) ?? undefined,
          },
        });
        break;
      }

      case 'tool/result':
      case 'stream/toolResult': {
        events.push({
          type: 'tool_result',
          toolResult: {
            id: typeof params.id === 'string' ? params.id : undefined,
            name: typeof params.name === 'string' ? params.name : 'unknown',
            result: params.result as ToolResult | string | undefined,
          },
        });
        break;
      }

      case 'stream/error':
      case 'message/error': {
        const errorMsg = typeof params.message === 'string' ? params.message : 'Unknown error';
        events.push({ type: 'error', error: errorMsg });
        break;
      }

      default:
        break;
    }

    return events;
  }
}
