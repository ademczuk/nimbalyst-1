/**
 * KimiClaw Provider
 *
 * HTTP+SSE provider for KimiClawSwarm (KCS) — local Flask server at 127.0.0.1:9643.
 * Follows the same pattern as OpenCodeProvider.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { KimiClawProtocol } from '../protocols/KimiClawProtocol';
import { ProviderSessionManager } from './ProviderSessionManager';
import { McpConfigService } from '../services/McpConfigService';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { safeJSONSerialize } from '../../../utils/serialization';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface KimiClawProviderDeps {
  protocol?: KimiClawProtocol;
}

export class KimiClawProvider extends BaseAgentProvider {
  private readonly protocol: KimiClawProtocol;
  private readonly mcpConfigService: McpConfigService;

  constructor(deps?: KimiClawProviderDeps) {
    super();
    this.protocol = deps?.protocol || new KimiClawProtocol();
    this.mcpConfigService = new McpConfigService();
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'kimiclaw';
  }

  getDisplayName(): string {
    return 'KimiClaw';
  }

  getDescription(): string {
    return 'KimiClawSwarm local multi-agent orchestration';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: false,
      supportsFileTools: false,
    };
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'kimi-code/kimi-for-coding',
        name: 'Kimi K2 Coding',
        provider: 'kimiclaw' as AIProviderType,
      },
    ];
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      swarmId: providerSessionId,
    };
  }

  /**
   * Stub: will be filled in Slice 2.
   */
  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    yield { type: 'error', error: '[KimiClawProvider] sendMessage not yet implemented' };
  }

  async checkInstallation(): Promise<{ installed: boolean; details?: string }> {
    return { installed: false, details: 'KimiClaw provider not yet implemented' };
  }
}
