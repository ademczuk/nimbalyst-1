/**
 * Extension Provider Registry version atom.
 *
 * The runtime ProviderRegistry (a plain Map) is not Jotai-reactive. When an
 * extension is uninstalled, `ProviderRegistry.unregister(id)` deletes the
 * descriptor synchronously, but any component reading `ProviderRegistry.has(id)`
 * during render won't re-evaluate on subsequent updates.
 *
 * This atom acts as a reactivity tick: it is incremented every time an
 * extension provider is registered or unregistered in the renderer
 * ProviderRegistry (see registerExtensionSystem.ts). Derived atoms that need
 * to react to descriptor changes should depend on this atom and call
 * `ProviderRegistry.has(id)` inside the getter; the getter re-evaluates when
 * the tick increments.
 *
 * This was added to fix Bug L: the AntigravityUsageIndicator chip stayed
 * visible after the gemini-antigravity extension was uninstalled, because its
 * visibility atom only checked `providers[id]?.enabled` from settings (which
 * stays true on uninstall) instead of also checking whether the descriptor is
 * currently registered.
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

/** Tick that increments on every extension provider registry mutation. */
export const extensionProviderRegistryVersionAtom = atom<number>(0);

/**
 * Bump the tick. Call this AFTER ProviderRegistry.register or
 * ProviderRegistry.unregister for an extension-contributed descriptor.
 */
export function bumpExtensionProviderRegistryVersion(): void {
  const current = store.get(extensionProviderRegistryVersionAtom);
  store.set(extensionProviderRegistryVersionAtom, current + 1);
}
