/**
 * MeridianProvider — single-brain chat with Meridian (local gpt-5.4 brain
 * on the OpenClaw/Hermes stack). Same FastAPI /api/chat contract as
 * Anismin, served on the adjacent port. One prompt -> one reply, no swarm.
 *
 * Endpoint: http://127.0.0.1:18890/api/chat. Override via the provider
 * config `endpoint` field in settings. (The legacy WebSocket gateway on
 * :18789 is not used — meridian-chat.js itself falls back to this HTTP
 * brain at :18890.)
 */

import { OpenClawBrainProvider } from './OpenClawBrainProvider';
import { AIModel } from '../types';

export class MeridianProvider extends OpenClawBrainProvider {
  static readonly DEFAULT_MODEL = 'meridian:gpt-5.4';

  static getDefaultModel(): string {
    return MeridianProvider.DEFAULT_MODEL;
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: MeridianProvider.DEFAULT_MODEL,
        name: 'Meridian (gpt-5.4)',
        provider: 'meridian',
        contextWindow: 200000,
      },
    ];
  }

  getProviderName(): string {
    return 'meridian';
  }

  protected defaultEndpoint(): string {
    return 'http://127.0.0.1:18890/api/chat';
  }

  protected brainLabel(): string {
    return 'Meridian';
  }
}
