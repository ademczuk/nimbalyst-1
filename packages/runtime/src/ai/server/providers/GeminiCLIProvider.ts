/**
 * Google Gemini CLI OAuth Agent Provider
 *
 * Integrates Google Gemini's ACP (Agent Communication Protocol) server mode
 * into Nimbalyst. Gemini runs as `gemini --acp` and communicates
 * via JSON-RPC over stdin/stdout.
 *
 * Key features:
 * - ACP protocol transport
 * - Session create/resume via protocol session IDs
 * - MCP server passthrough to Gemini's ACP session
 * - Nimbalyst permission prompts for tool/file actions
 * - Canonical transcript storage via raw event logging
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { GeminiACPProtocol } from '../protocols/GeminiACPProtocol';
import { ProtocolEvent, ProtocolSession } from '../protocols/ProtocolInterface';
import { McpConfigService } from '../services/McpConfigService';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TrustChecker, PermissionMode } from './ProviderPermissionMixin';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface GeminiCLIProviderDeps {
  protocol?: GeminiACPProtocol;
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function findExecutableInPathEntries(
  executableNames: string[],
  pathValue: string | undefined
): string | undefined {
  for (const entry of splitPathEntries(pathValue)) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function getSystemGeminiExecutableCandidates(pathValue?: string): string[] {
  const platform = process.platform;
  const homeDir = os.homedir();
  const pathModule = platform === 'win32' ? path.win32 : path;
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    const normalized = pathModule.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(candidate);
  };

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
    addCandidate(path.win32.join(appData, 'npm', 'gemini.cmd'));
    addCandidate(path.win32.join(homeDir, 'AppData', 'Roaming', 'npm', 'gemini.cmd'));
    addCandidate(findExecutableInPathEntries(['gemini.cmd', 'gemini.exe'], pathValue ?? process.env.PATH));
    addCandidate('gemini');
    return candidates;
  }

  addCandidate(path.join(homeDir, '.local', 'bin', 'gemini'));
  addCandidate(path.join(homeDir, '.npm-global', 'bin', 'gemini'));
  addCandidate('/usr/local/bin/gemini');
  addCandidate('/opt/homebrew/bin/gemini');
  addCandidate(findExecutableInPathEntries(['gemini'], pathValue ?? process.env.PATH));
  addCandidate('gemini');
  return candidates;
}

export class GeminiCLIProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['gemini-cli'] || 'gemini-cli:default';

  private readonly protocol: GeminiACPProtocol;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  private static mcpServerPort: number | null = null;
  private static sessionNamingServerPort: number | null = null;
  private static extensionDevServerPort: number | null = null;
  private static sessionContextServerPort: number | null = null;
  private static metaAgentServerPort: number | null = null;
  private static mcpAuthToken: string | null = null;

  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static geminiPathLoader: (() => string | null) | null = null;

  constructor(deps?: GeminiCLIProviderDeps) {
    super();

    this.protocol = deps?.protocol || new GeminiACPProtocol();

    this.mcpConfigService = new McpConfigService({
      mcpServerPort: GeminiCLIProvider.mcpServerPort,
      sessionNamingServerPort: GeminiCLIProvider.sessionNamingServerPort,
      extensionDevServerPort: GeminiCLIProvider.extensionDevServerPort,
      superLoopProgressServerPort: null,
      sessionContextServerPort: GeminiCLIProvider.sessionContextServerPort,
      metaAgentServerPort: GeminiCLIProvider.metaAgentServerPort,
      mcpAuthToken: GeminiCLIProvider.mcpAuthToken,
      mcpConfigLoader: GeminiCLIProvider.mcpConfigLoader,
      extensionPluginsLoader: null,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: GeminiCLIProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'gemini-cli';
  }

  // --- Static injection setters ---

  public static setMcpServerPort(port: number | null): void {
    GeminiCLIProvider.mcpServerPort = port;
  }

  public static setSessionNamingServerPort(port: number | null): void {
    GeminiCLIProvider.sessionNamingServerPort = port;
  }

  public static setExtensionDevServerPort(port: number | null): void {
    GeminiCLIProvider.extensionDevServerPort = port;
  }

  public static setSessionContextServerPort(port: number | null): void {
    GeminiCLIProvider.sessionContextServerPort = port;
  }

  public static setMetaAgentServerPort(port: number | null): void {
    GeminiCLIProvider.metaAgentServerPort = port;
  }

  public static setMcpAuthToken(token: string | null): void {
    GeminiCLIProvider.mcpAuthToken = token;
  }

  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    GeminiCLIProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    GeminiCLIProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    GeminiCLIProvider.enhancedPathLoader = loader;
  }

  public static setGeminiPathLoader(loader: (() => string | null) | null): void {
    GeminiCLIProvider.geminiPathLoader = loader;
  }

  public static resolveGeminiExecutableForRuntime(pathValue?: string): string | undefined {
    if (GeminiCLIProvider.geminiPathLoader) {
      const customPath = GeminiCLIProvider.geminiPathLoader();
      if (customPath) {
        return customPath;
      }
    }

    for (const candidate of getSystemGeminiExecutableCandidates(pathValue)) {
      if (candidate === 'gemini' || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  // --- Model discovery ---

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'gemini-cli:default',
        name: 'Gemini CLI (default)',
        provider: 'gemini-cli' as AIProviderType,
      },
    ];
  }

  static getDefaultModel(): string {
    return DEFAULT_MODELS['gemini-cli'] || 'gemini-cli:default';
  }

  getName(): string {
    return 'gemini-cli';
  }

  getDisplayName(): string {
    return 'Google Gemini';
  }

  getDescription(): string {
    return 'Google Gemini CLI agent provider via ACP protocol';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return { providerSessionId };
  }

  getInitData(): {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null {
    return this._initData;
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
    // Internal: set on the self-retry after Gemini rejects the request for
    // exceeding its 512 function-declaration limit. Drops MCP tools for the retry.
    forceNoMcp: boolean = false
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[GeminiCLIProvider] workspacePath is required but was not provided' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    if (sessionId && (systemPrompt || userMessageAddition) && !forceNoMcp) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    const prompt = messageWithContext;

    if (sessionId && !forceNoMcp) {
      const metadataToLog: Record<string, unknown> = {};
      if (documentContext?.mode) {
        metadataToLog.mode = documentContext.mode;
      }
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        prompt,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined
      );
    }

    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      const permissionResult = await this.requestGeminiTurnPermission(workspacePath, documentContext?.permissionsPath);
      if (permissionResult.decision !== 'allow') {
        yield { type: 'error', error: permissionResult.reason || 'Gemini turn denied' };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');

      const mcpServers = forceNoMcp
        ? {}
        : await this.mcpConfigService.getMcpServersConfig({
            sessionId,
            workspacePath: mcpConfigWorkspacePath,
            profile: 'standard',
          });

      this.configureProtocol();

      const geminiAvailable = GeminiCLIProvider.isGeminiInstalled();
      if (!geminiAvailable) {
        yield {
          type: 'error',
          error: 'Google Gemini CLI is not installed. Install it globally with npm:\n\n' +
            '  npm install -g @google/gemini-cli\n\n' +
            'Then run `gemini` in your terminal and complete the OAuth login flow.',
        };
        return;
      }

      const resolvedModel = this.config?.model || GeminiCLIProvider.DEFAULT_MODEL;
      // On the no-MCP retry, force a fresh session so the resumed session's
      // already-registered tools don't re-trigger the 512 limit.
      const isResumedSession = !forceNoMcp && !!existingSessionId;

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        systemPrompt,
        mcpServers,
      };

      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      this._initData = {
        model: resolvedModel,
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedSession,
      };

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      if (!forceNoMcp) {
        transcriptAdapter.userMessage(
          prompt,
          documentContext?.mode === 'planning' ? 'planning' : 'agent',
          attachments as any,
        );
      }

      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB not available
          }
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;
            case 'raw_event':
            case 'reasoning':
            case 'unknown':
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;
            case 'complete':
              if (sessionId && fullText) {
                await this.storeAssistantResponse(sessionId, fullText);
                await this.processTranscriptMessages(sessionId);
              }
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
              };
              break;
            case 'error':
              if (!forceNoMcp && !fullText && /At most 512 function declarations/i.test(item.message)) {
                console.warn('[GeminiCLIProvider] Gemini rejected the request: MCP tools exceed the 512 function-declaration limit. Retrying this turn without MCP tools.');
                yield* this.sendMessage(message, documentContext, sessionId, messages, workspacePath, attachments, true);
                return;
              }
              yield { type: 'error', error: item.message };
              break;
            default:
              break;
          }
        }
      }

      if (sessionId && session.id && session.id !== existingSessionId) {
        this.sessions.captureSessionId(sessionId, session.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        if (/process exited|ENOENT|spawn.*gemini/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Google Gemini CLI is not installed or failed to start. Install it globally with:\n\n' +
              '  npm install -g @google/gemini-cli\n\n' +
              'Then run `gemini` in your terminal and complete the OAuth login flow.',
          };
        } else if (/auth|login|token|unauthorized|forbidden|credentials/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Google Gemini CLI is not logged in. Run `gemini` in your terminal and complete the OAuth login flow.',
            isAuthError: true,
          };
        } else if (!forceNoMcp && !fullText && /At most 512 function declarations/i.test(errorMessage)) {
          console.warn('[GeminiCLIProvider] Gemini rejected the request: MCP tools exceed the 512 function-declaration limit. Retrying this turn without MCP tools.');
          yield* this.sendMessage(message, documentContext, sessionId, messages, workspacePath, attachments, true);
          return;
        } else {
          yield { type: 'error', error: errorMessage };
        }
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  destroy(): void {
    if ((this.protocol as any).destroy) {
      (this.protocol as any).destroy();
    }
    super.destroy();
  }

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    const hasSessionNaming = GeminiCLIProvider.sessionNamingServerPort !== null;
    const worktreePath = documentContext?.worktreePath;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode: false,
      enableAgentTeams: false,
    });
  }

  public static isGeminiInstalled(): boolean {
    const resolved = GeminiCLIProvider.resolveGeminiExecutableForRuntime(
      GeminiCLIProvider.enhancedPathLoader?.() || process.env.PATH
    ) || 'gemini';

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (GeminiCLIProvider.enhancedPathLoader) {
      try {
        env.PATH = GeminiCLIProvider.enhancedPathLoader();
      } catch {
        // keep inherited PATH
      }
    }

    // On Windows, npm shims resolve to a .cmd; Node refuses to execFile a
    // .cmd/.bat without a shell (CVE-2024-27980 mitigation), which would make
    // this check falsely report "not installed". Run the basename under a shell
    // with the resolved dir prepended to PATH (mirrors GeminiACPProtocol).
    const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    let command = resolved;
    if (isWinScript) {
      const dir = path.dirname(resolved);
      env.PATH = dir + path.delimiter + (env.PATH ?? env.Path ?? '');
      command = path.basename(resolved);
    }
    try {
      execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5000, env, shell: isWinScript, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  private configureProtocol(): void {
    const resolvedPath = GeminiCLIProvider.resolveGeminiExecutableForRuntime(
      GeminiCLIProvider.enhancedPathLoader?.() || process.env.PATH
    );
    if (resolvedPath) {
      this.protocol.setGeminiPath(resolvedPath);
    }

    const env = GeminiCLIProvider.buildGeminiEnvironment();
    if (env) {
      this.protocol.setProcessEnv(env);
    }
  }

  private static buildGeminiEnvironment(): Record<string, string> | null {
    let shellEnv: Record<string, string> | null = null;
    let enhancedPath: string | null = null;

    if (GeminiCLIProvider.shellEnvironmentLoader) {
      try {
        shellEnv = GeminiCLIProvider.shellEnvironmentLoader();
      } catch {
        // continue
      }
    }

    if (GeminiCLIProvider.enhancedPathLoader) {
      try {
        enhancedPath = GeminiCLIProvider.enhancedPathLoader();
      } catch {
        // continue
      }
    }

    if (!shellEnv && !enhancedPath) {
      return null;
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (shellEnv) {
      Object.assign(env, shellEnv);
    }
    if (enhancedPath) {
      env.PATH = enhancedPath;
    }

    // Scrub other API keys
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    return env;
  }

  private async requestGeminiTurnPermission(
    workspacePath: string,
    permissionsPath?: string
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use Google Gemini.',
        };
      }

      if (trustStatus.mode === 'bypass-all' || trustStatus.mode === 'allow-all') {
        return { decision: 'allow', permissionMode: trustStatus.mode };
      }

      return {
        decision: 'deny',
        reason: 'Google Gemini requires "Allow Edits" permission mode. Please change the permission mode in workspace settings.',
      };
    }

    return { decision: 'allow' };
  }

  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          this.getProviderName(),
        );
      }
    } catch {
      // Best effort
    }
  }

  private async storeAssistantResponse(sessionId: string, text: string): Promise<void> {
    const codexCompatibleEvent = {
      type: 'item.completed',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    };
    try {
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        'output',
        JSON.stringify(codexCompatibleEvent),
        { eventType: 'item.completed', geminiProvider: true },
        false,
        undefined,
        true
      );
    } catch {
      // Best effort
    }
  }

  private async storeRawEventIfPresent(event: ProtocolEvent, sessionId: string): Promise<void> {
    if (event.type !== 'raw_event' || !event.metadata?.rawEvent) {
      return;
    }

    const { content, usedFallback } = safeJSONSerialize(event.metadata.rawEvent);
    const rawEventType = this.getRawEventType(event.metadata.rawEvent);

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      usedFallback
        ? JSON.stringify({ type: rawEventType, valueType: typeof event.metadata.rawEvent, fallback: true })
        : content,
      {
        eventType: rawEventType,
        geminiProvider: true,
        rawEventSerializationFallback: usedFallback,
      },
      false,
      undefined,
      false
    );
  }

  private getRawEventType(rawEvent: unknown): string {
    if (rawEvent && typeof rawEvent === 'object') {
      const method = (rawEvent as Record<string, unknown>).method;
      if (typeof method === 'string' && method.trim().length > 0) {
        return method;
      }
      const type = (rawEvent as Record<string, unknown>).type;
      if (typeof type === 'string' && type.trim().length > 0) {
        return type;
      }
    }
    return 'unknown';
  }
}
