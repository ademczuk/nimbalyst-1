import React from 'react';
import { MaterialSymbol } from './MaterialSymbol';
import { ProviderRegistry } from '../../ai/server/ProviderRegistry';

interface IconProps {
  size?: number;
  className?: string;
}

const PROVIDER_ICON_MAP: Record<string, string> = {
  'copilot-cli': 'terminal',
  // ACP transport reuses the OpenAI Codex icon (same underlying agent).
  'openai-codex-acp': 'openai-codex',
  'gemini-cli': 'smart_toy',
};

export function resolveProviderIcon(provider: string): string {
  // Registry first so extension-contributed providers can declare an icon;
  // falls back to the built-in map, then the provider id itself.
  return ProviderRegistry.get(provider)?.icon ?? PROVIDER_ICON_MAP[provider] ?? provider;
}

/**
 * Convenience component for rendering provider icons.
 * Uses MaterialSymbol under the hood - just pass the provider name.
 */
export const ProviderIcon: React.FC<{ provider: string } & IconProps> = ({
  provider,
  size = 20,
  className = ''
}) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={size} className={className} />;
};

/**
 * Convenience function for getting a provider icon element.
 * Uses MaterialSymbol under the hood.
 */
export const getProviderIcon = (provider: string, props?: IconProps) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={props?.size} className={props?.className} />;
};
