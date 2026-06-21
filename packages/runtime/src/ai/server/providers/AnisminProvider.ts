/**
 * AnisminProvider — single-brain chat with Anismin (local Claude Opus 4.7
 * brain on the OpenClaw stack). Tasks her the same way the KimiClawProvider
 * tasks KCS, but without the swarm: one prompt -> one reply.
 *
 * Endpoint: http://127.0.0.1:18889/api/chat (FastAPI brain). Override via
 * the provider config `endpoint` field in settings.
 */

import { OpenClawBrainProvider } from './OpenClawBrainProvider';
import { AIModel } from '../types';

export class AnisminProvider extends OpenClawBrainProvider {
  static readonly DEFAULT_MODEL = 'anismin:opus-4-7';

  static getDefaultModel(): string {
    return AnisminProvider.DEFAULT_MODEL;
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: AnisminProvider.DEFAULT_MODEL,
        name: 'Anismin (Opus 4.7)',
        provider: 'anismin',
        contextWindow: 200000,
      },
    ];
  }

  getProviderName(): string {
    return 'anismin';
  }

  protected defaultEndpoint(): string {
    return 'http://127.0.0.1:18889/api/chat';
  }

  protected brainLabel(): string {
    return 'Anismin';
  }
}
