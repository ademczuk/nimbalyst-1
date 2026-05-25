/**
 * Utility functions for normalizing AI provider model configurations.
 *
 * OpenAI Codex provider uses dynamic model discovery instead of user-configured
 * model selections. This utility removes the `models` field from Codex configs
 * to prevent stale model lists from being persisted or transmitted.
 */

import { ProviderRegistry } from '../ProviderRegistry';

/**
 * Removes the `models` field from an object, returning a new object without it.
 * TypeScript will correctly infer the return type as `Omit<T, 'models'>`.
 */
export function omitModelsField<T extends { models?: any }>(
  config: T
): Omit<T, 'models'> {
  if (!config || typeof config !== 'object') {
    return config as Omit<T, 'models'>;
  }

  const { models: _removed, ...rest } = config;
  return rest;
}

/**
 * Providers that use dynamic model discovery and should not persist a `models` field.
 * Kept as the fallback union for processes where the registry isn't populated yet.
 */
const DYNAMIC_MODEL_PROVIDERS = ['openai-codex', 'copilot-cli', 'gemini-cli'] as const;

/**
 * Resolve the set of dynamic-model provider ids. Reads the registry (which
 * includes extension-contributed providers) and falls back to the hardcoded
 * union when the registry is empty in this process.
 */
function dynamicModelProviderIds(): readonly string[] {
  const fromRegistry = ProviderRegistry.list()
    .filter((d) => d.dynamicModels)
    .map((d) => d.id);
  return fromRegistry.length > 0 ? fromRegistry : DYNAMIC_MODEL_PROVIDERS;
}

/**
 * Normalizes provider configurations by removing the `models` field from
 * providers that use dynamic model discovery.
 */
export function normalizeCodexProviderConfig<T extends Record<string, any>>(
  providers: T
): T {
  if (!providers || typeof providers !== 'object') {
    return providers;
  }

  let result = providers;
  for (const providerId of dynamicModelProviderIds()) {
    const config = result[providerId];
    if (config && typeof config === 'object' && 'models' in config) {
      result = { ...result, [providerId]: omitModelsField(config) } as T;
    }
  }

  return result;
}

/**
 * Remove transient provider status fields that should never be persisted.
 * These fields are UI state for the current renderer session only.
 */
export function stripTransientProviderFields<T extends Record<string, any>>(
  providers: T
): T {
  if (!providers || typeof providers !== 'object') {
    return providers;
  }

  let changed = false;
  const sanitized: Record<string, any> = {};

  for (const [providerId, config] of Object.entries(providers)) {
    if (!config || typeof config !== 'object') {
      sanitized[providerId] = config;
      continue;
    }

    const {
      testStatus: _testStatus,
      testMessage: _testMessage,
      ...rest
    } = config as Record<string, any>;

    if ('testStatus' in config || 'testMessage' in config) {
      changed = true;
    }

    sanitized[providerId] = rest;
  }

  return (changed ? sanitized : providers) as T;
}
