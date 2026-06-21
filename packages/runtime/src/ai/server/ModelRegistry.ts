/**
 * Registry of available AI models with dynamic fetching.
 *
 * Provider dispatch is driven by the runtime ProviderRegistry (descriptors),
 * not a hardcoded switch. Built-ins are registered idempotently on first use.
 */

import { AIModel, ModelIdentifier } from './types';
import { ProviderRegistry } from './ProviderRegistry';
import { registerBuiltinProviders } from './registerBuiltinProviders';

export class ModelRegistry {
  private static cachedModels: Map<string, AIModel[]> = new Map();
  private static lastFetch: Map<string, number> = new Map();
  private static CACHE_DURATION = 60 * 60 * 1000; // 1 hour cache

  /**
   * Get models for a specific provider (always fetches fresh; cache kept for
   * potential reuse but not currently consulted, matching prior behavior).
   */
  static async getModelsForProvider(
    provider: string,
    apiKey?: string,
    baseUrl?: string
  ): Promise<AIModel[]> {
    registerBuiltinProviders();

    let models: AIModel[] = [];
    try {
      const descriptor = ProviderRegistry.get(provider);
      if (!descriptor || !descriptor.getModels) {
        console.error(`Failed to fetch models for ${provider}: no model fetcher registered`);
        return [];
      }

      models = await descriptor.getModels(apiKey, baseUrl);

      // Claude exposes many dated snapshots; keep only the latest per variant.
      if (provider === 'claude') {
        models = this.filterLatestClaudeModels(models);
      }

      this.cachedModels.set(provider, models);
      this.lastFetch.set(provider, Date.now());
    } catch (error) {
      console.error(`Failed to fetch models for ${provider}:`, error);
      models = [];
    }

    return models;
  }

  /**
   * Get all available models across all registered providers.
   * @param apiKeys - API keys and config (keyed by descriptor.apiKeyName / baseUrlName).
   * @param enabledProviders - Optional set of enabled provider ids; if provided, only these are fetched.
   */
  static async getAllModels(apiKeys: Record<string, string>, enabledProviders?: Set<string>): Promise<AIModel[]> {
    registerBuiltinProviders();

    const allModels: AIModel[] = [];
    const promises: Promise<AIModel[]>[] = [];

    for (const descriptor of ProviderRegistry.list()) {
      if (enabledProviders && !enabledProviders.has(descriptor.id)) continue;
      const apiKey = descriptor.apiKeyName ? apiKeys[descriptor.apiKeyName] : undefined;
      const baseUrl = descriptor.baseUrlName ? apiKeys[descriptor.baseUrlName] : undefined;
      promises.push(this.getModelsForProvider(descriptor.id, apiKey, baseUrl));
    }

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allModels.push(...result.value);
      }
    }

    return allModels;
  }

  /**
   * Get the default model for a provider.
   */
  static async getDefaultModel(provider: string): Promise<string> {
    registerBuiltinProviders();
    const descriptor = ProviderRegistry.get(provider);
    if (!descriptor || !descriptor.getDefaultModel) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return await descriptor.getDefaultModel();
  }

  /**
   * Clear the cache to force fresh fetch
   */
  static clearCache(provider?: string): void {
    if (provider) {
      this.cachedModels.delete(provider);
      this.lastFetch.delete(provider);
    } else {
      this.cachedModels.clear();
      this.lastFetch.clear();
    }
  }

  private static filterLatestClaudeModels(models: AIModel[]): AIModel[] {
    const latestByVariant = new Map<string, { model: AIModel; releaseDate: number }>();
    let parseFailed = false;

    for (const model of models) {
      const metadata = this.extractClaudeModelMetadata(model);
      if (!metadata) {
        parseFailed = true;
        break;
      }

      const existing = latestByVariant.get(metadata.variant);
      if (!existing || metadata.releaseDate > existing.releaseDate) {
        latestByVariant.set(metadata.variant, { model, releaseDate: metadata.releaseDate });
      }
    }

    if (parseFailed) {
      console.warn('[ModelRegistry] Failed to parse Claude model metadata - returning full list');
      return models;
    }

    return Array.from(latestByVariant.values()).map(entry => entry.model);
  }

  private static extractClaudeModelMetadata(model: AIModel): { variant: string; releaseDate: number } | null {
    // Extract the model part using ModelIdentifier
    const parsed = ModelIdentifier.tryParse(model.id);
    const idPart = parsed ? parsed.model : model.id;
    const normalized = idPart.toLowerCase();
    const variantMatch = normalized.match(/(opus|sonnet|haiku)/);
    const dateMatch = normalized.match(/(\d{8})$/);

    if (!variantMatch || !dateMatch) {
      return null;
    }

    return {
      variant: variantMatch[1],
      releaseDate: Number.parseInt(dateMatch[1], 10)
    };
  }
}
