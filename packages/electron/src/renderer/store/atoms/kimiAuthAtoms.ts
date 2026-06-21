/**
 * Atoms for the Kimi (Kimi Code) auth-status chip.
 *
 * Mirrors antigravityUsageAtoms in shape but carries less data: the Kimi
 * Code endpoint does not expose account credits or per-model quotas, so we
 * surface the local OAuth state instead (valid / expired / not-logged-in).
 *
 * The chip in the navigation gutter polls `kimi-code:auth:status` on a
 * 15-second interval - that IPC reads only the local ~/.kimi/credentials/
 * kimi-code.json file (no network), so the polling is cheap.
 */

import { atom } from 'jotai';
import { providersAtom } from './appSettings';
import { extensionProviderRegistryVersionAtom } from './extensionProviderRegistry';
import { ProviderRegistry } from '@nimbalyst/runtime/ai/server/ProviderRegistry';

export type KimiAuthState = 'valid' | 'expired' | 'not-logged-in';

export interface KimiAuthSnapshot {
  state: KimiAuthState;
  /** Unix-seconds expiry timestamp; absent when state === 'not-logged-in'. */
  expiresAt?: number;
  /** OAuth scope from the credentials file; useful for debug surfacing. */
  scope?: string;
}

/** Mutable atom holding the last successful auth-status snapshot. */
export const kimiAuthSnapshotAtom = atom<KimiAuthSnapshot | null>(null);

/**
 * Visible only when at least one of the two kimi-code providers is BOTH
 * enabled in providerSettings AND registered in the renderer ProviderRegistry.
 * Same dual-gate as antigravityIndicatorVisibleAtom - the second gate hides
 * the chip after the extension is uninstalled even if the providerSettings
 * entry persists.
 */
export const kimiIndicatorVisibleAtom = atom((get) => {
  const providers = get(providersAtom);
  const registryVersion = get(extensionProviderRegistryVersionAtom);
  void registryVersion;
  const chatEnabled = providers['kimi-code']?.enabled === true;
  const agentEnabled = providers['kimi-code-agent']?.enabled === true;
  const chatInstalled = ProviderRegistry.has('kimi-code');
  const agentInstalled = ProviderRegistry.has('kimi-code-agent');
  return (chatEnabled && chatInstalled) || (agentEnabled && agentInstalled);
});

/**
 * Traffic-light color for the chip's status dot.
 *   valid          -> green
 *   expired        -> yellow (the client will try to refresh in the background)
 *   not-logged-in  -> muted (user needs to /login in the CLI)
 */
export const kimiStatusColorAtom = atom((get) => {
  const snap = get(kimiAuthSnapshotAtom);
  if (!snap) return 'muted';
  if (snap.state === 'valid') return 'green';
  if (snap.state === 'expired') return 'yellow';
  return 'muted';
});

/** Format a remaining-lifetime string from a unix-seconds expiry timestamp. */
export function formatExpiresIn(expiresAt: number | undefined): string {
  if (typeof expiresAt !== 'number') return '';
  const remaining = expiresAt - Date.now() / 1000;
  if (remaining <= 0) return 'expired';
  if (remaining < 60) return `${Math.floor(remaining)}s`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)} min`;
  return `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`;
}
