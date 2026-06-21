/**
 * Google Gemini CLI ACP Protocol Adapter
 *
 * Wraps `gemini --acp` to provide a normalized protocol interface
 * for the GeminiCLIProvider.
 *
 * Spawns `gemini --acp` and communicates via JSON-RPC over stdin/stdout.
 * Normalizes ACP events into Nimbalyst ProtocolEvent objects.
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import path from 'path';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ToolResult,
} from './ProtocolInterface';

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

export class GeminiACPProtocol implements AgentProtocol {
  readonly platform = 'gemini-acp';

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(notification: ACPNotification) => void> = [];
  private command: string;
  private baseArgs: string[];
  private processEnv: Record<string, string> | undefined;
  private initialized = false;

  constructor(geminiPath?: string) {
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

  private ensureProcess(): ChildProcess {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    // On Windows, npm-installed CLIs resolve to a .cmd shim. Node 20.12.2+ / 22
    // refuse to spawn .cmd/.bat without a shell (CVE-2024-27980 mitigation), so
    // run the bare command name through a shell with its dir prepended to PATH.
    const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command);
    let command = this.command;
    let spawnEnv: NodeJS.ProcessEnv = this.processEnv ?? process.env;
    if (isWinScript) {
      const dir = path.dirname(this.command);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.processEnv ?? process.env)) {
        if (typeof v === 'string') merged[k] = v;
      }
      merged.PATH = dir + path.delimiter + (merged.PATH ?? merged.Path ?? '');
      spawnEnv = merged;
      command = path.basename(this.command);
    }

    const proc = spawn(command, this.baseArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: isWinScript,
      windowsHide: true,
    });

    this.process = proc;

    const rl = createInterface({ input: proc.stdout! });
    this.readline = rl;

    rl.on('line', (line) => {
      this.handleLine(line);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      console.warn('[GEMINI-ACP] stderr:', data.toString());
    });

    proc.on('exit', (code, signal) => {
      console.log(`[GEMINI-ACP] Process exited: code=${code}, signal=${signal}`);
      this.rejectAllPending(new Error(`Gemini process exited (code=${code})`));
      this.process = null;
      this.readline = null;
    });

    return proc;
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
    const proc = this.process;
    if (!proc || !proc.stdin) return;

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

    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      console.warn('[GEMINI-ACP] Failed to answer server request:', error);
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const proc = this.ensureProcess();
    const id = this.nextRequestId++;
    const request: ACPRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const proc = this.ensureProcess();
    const notification: ACPNotification = { jsonrpc: '2.0', method, params };
    proc.stdin!.write(JSON.stringify(notification) + '\n');
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.ensureProcess();

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
      cwd: options.workspacePath || process.cwd(),
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
        cwd: options.workspacePath || process.cwd(),
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
    this.ensureProcess();

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
    this.sendNotification('session/cancel', { sessionId: _session.id });
  }

  cleanupSession(_session: ProtocolSession): void {
    // No-op; ACP process stays alive for reuse
  }

  destroy(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.readline = null;
    this.initialized = false;
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
