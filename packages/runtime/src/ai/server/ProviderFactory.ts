/**
 * Factory for creating AI provider instances.
 *
 * Construction is driven by the runtime ProviderRegistry (descriptors), not a
 * hardcoded switch. Built-ins register idempotently on first use.
 */

import { AIProvider } from './AIProvider';
import { AIProviderType } from './types';
import { ProviderRegistry } from './ProviderRegistry';
import { registerBuiltinProviders } from './registerBuiltinProviders';

export class ProviderFactory {
  private static providers: Map<string, AIProvider> = new Map();

  /**
   * Get an existing AI provider instance.
   * Returns null if provider doesn't exist.
   */
  static getProvider(
    type: AIProviderType,
    sessionId: string
  ): AIProvider | null {
    const key = `${type}-${sessionId}`;
    return this.providers.get(key) || null;
  }

  /**
   * Create a new AI provider instance.
   * Always creates a new provider, doesn't check cache.
   */
  static createProvider(
    type: AIProviderType,
    sessionId: string
  ): AIProvider {
    registerBuiltinProviders();

    const key = `${type}-${sessionId}`;
    const descriptor = ProviderRegistry.get(type);
    if (!descriptor) {
      throw new Error(`Unknown provider: ${type}`);
    }
    if (!descriptor.createInstance) {
      throw new Error(`Provider ${type} is registered metadata-only (no factory in this process)`);
    }

    const provider = descriptor.createInstance();
    this.providers.set(key, provider);
    return provider;
  }

  /**
   * Clean up a provider instance
   */
  static destroyProvider(sessionId: string, type?: AIProviderType): void {
    if (type) {
      const key = `${type}-${sessionId}`;
      const provider = this.providers.get(key);
      if (provider) {
        provider.destroy();
        this.providers.delete(key);
      }
    } else {
      // Destroy all providers for this session
      for (const [key, provider] of this.providers.entries()) {
        if (key.endsWith(`-${sessionId}`)) {
          provider.destroy();
          this.providers.delete(key);
        }
      }
    }
  }

  /**
   * Clean up all provider instances
   */
  static destroyAll(): void {
    for (const [key, provider] of this.providers.entries()) {
      try {
        provider.destroy();
      } catch (error) {
        console.error(`[ProviderFactory] Error destroying provider ${key}:`, error);
      }
    }

    try {
      this.providers.clear();
    } catch (error) {
      console.error('[ProviderFactory] Error clearing providers map:', error);
    }
  }
}
