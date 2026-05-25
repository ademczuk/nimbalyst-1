/**
 * Main-process registration bridge for extension-contributed AI providers.
 *
 * The renderer loads an extension that contributes an `aiProviders` descriptor
 * and registers it (metadata-only) into the renderer ProviderRegistry. For the
 * session loop in MAIN to construct that provider, main needs a matching
 * descriptor whose `createInstance` returns an ExtensionProviderProxy. The
 * renderer pushes the descriptor metadata here over IPC; we attach the proxy
 * factory and register it into the main-process ProviderRegistry.
 */

import { ipcMain } from 'electron';
import { ProviderRegistry, type ProviderDescriptor } from '@nimbalyst/runtime/ai/server';
import { ExtensionProviderProxy } from '../services/ai/ExtensionProviderProxy';
import { logger } from '../utils/logger';

/** Metadata the renderer sends (the renderer-safe descriptor fields). */
type ExtensionProviderMetadata = Omit<ProviderDescriptor, 'createInstance' | 'getModels' | 'getDefaultModel' | 'source'>;

export function registerExtensionProviderHandlers(): void {
  ipcMain.handle('ext-provider:register', (_e, meta: ExtensionProviderMetadata) => {
    if (!meta?.id) {
      return { success: false, error: 'ext-provider:register requires a descriptor with an id' };
    }
    const descriptor: ProviderDescriptor = {
      ...meta,
      source: 'extension',
      // The heavy factory lives only in main: build a proxy that delegates the
      // turn back to the renderer-resident extension impl.
      createInstance: () => new ExtensionProviderProxy(meta.id),
    };
    ProviderRegistry.register(descriptor);
    logger.main.info(`[ExtensionProvider] registered '${meta.id}' (proxy) into main registry`);
    return { success: true };
  });

  ipcMain.handle('ext-provider:unregister', (_e, id: string) => {
    if (id) {
      ProviderRegistry.unregister(id);
      logger.main.info(`[ExtensionProvider] unregistered '${id}' from main registry`);
    }
    return { success: true };
  });
}
