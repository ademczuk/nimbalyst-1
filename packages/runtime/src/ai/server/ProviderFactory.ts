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
import { ExtensionAgentProvider } from './providers/ExtensionAgentProvider';

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
   * Create a new extension-contributed agent provider.
   *
   * This is the 'extension-agent' branch of the factory: instead of a
   * built-in provider class, the implementation lives in a privileged
   * backend module spawned by `PrivilegedExtensionHost`. The returned
   * `ExtensionAgentProvider` is a thin wrapper that delegates every call
   * across the host-installed `ExtensionAgentBridge`.
   *
   * The wrapper does NOT eagerly start the backend module. The first
   * `initialize` call routes through the bridge, which looks up the
   * AgentProviderRegistry entry: if status is `registered`, the bridge
   * raises the first-use consent prompt and then calls
   * `PrivilegedExtensionHost.startModule(...)`; once `active`, the bridge
   * dispatches subsequent calls through the broker. This matches the
   * Phase 4 design's "lazy spawn on first use" requirement.
   *
   * Cache key is namespaced by `extension-agent:${extensionId}/${contributionId}-${sessionId}`
   * so it never collides with the built-in providers (whose keys start with
   * the AIProviderType string).
   */
  static createExtensionAgentProvider(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
    model?: string;
  }): ExtensionAgentProvider {
    const key = `extension-agent:${args.extensionId}/${args.contributionId}-${args.sessionId}`;
    const provider = new ExtensionAgentProvider({
      extensionId: args.extensionId,
      contributionId: args.contributionId,
      sessionId: args.sessionId,
      model: args.model,
    });
    this.providers.set(key, provider);
    return provider;
  }

  /**
   * Look up a previously created extension-agent provider. Mirrors
   * `getProvider` for the built-in branch so callers can resolve a turn
   * to its provider instance.
   */
  static getExtensionAgentProvider(args: {
    extensionId: string;
    contributionId: string;
    sessionId: string;
  }): ExtensionAgentProvider | null {
    const key = `extension-agent:${args.extensionId}/${args.contributionId}-${args.sessionId}`;
    const provider = this.providers.get(key);
    return (provider as ExtensionAgentProvider | undefined) ?? null;
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
