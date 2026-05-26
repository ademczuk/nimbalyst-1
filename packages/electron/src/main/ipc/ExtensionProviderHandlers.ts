/**
 * Main-process registration bridge for extension-contributed AI providers.
 *
 * The renderer loads an extension that contributes an `aiProviders` descriptor
 * and registers it (metadata-only) into the renderer ProviderRegistry. For the
 * session loop in MAIN to construct that provider, main needs a matching
 * descriptor whose `createInstance` returns an ExtensionProviderProxy. The
 * renderer pushes the descriptor metadata here over IPC; we attach the proxy
 * factory and register it into the main-process ProviderRegistry.
 *
 * Model catalog routing: ModelRegistry.getAllModels() iterates registered
 * descriptors and calls `descriptor.getModels()` to populate Settings dropdowns.
 * Extension providers run in the renderer, so we attach a `getModels` shim that
 * sends `ext-provider:get-models` back to the renderer, which calls the
 * extension impl's static getModels() and returns the result over IPC.
 */

import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { ProviderRegistry, type ProviderDescriptor } from '@nimbalyst/runtime/ai/server';
import type { AIModel } from '@nimbalyst/runtime/ai/server/types';
import { ExtensionProviderProxy } from '../services/ai/ExtensionProviderProxy';
import { logger } from '../utils/logger';

/** Metadata the renderer sends (the renderer-safe descriptor fields). */
type ExtensionProviderMetadata = Omit<ProviderDescriptor, 'createInstance' | 'getModels' | 'getDefaultModel' | 'source'>;

interface PendingModelRequest {
  resolve: (models: AIModel[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingModelRequests = new Map<string, PendingModelRequest>();
let modelRequestSeq = 0;
let modelResponseListenerWired = false;

function resolveFirstWebContents(): WebContents | null {
  const windows = BrowserWindow.getAllWindows();
  for (const w of windows) {
    if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
      return w.webContents;
    }
  }
  return null;
}

function wireModelResponseListenerOnce(): void {
  if (modelResponseListenerWired) return;
  modelResponseListenerWired = true;

  ipcMain.on(
    'ext-provider:get-models:response',
    (_e, payload: { requestId: string; models?: AIModel[]; error?: string }) => {
      const pending = pendingModelRequests.get(payload?.requestId);
      if (!pending) return;
      pendingModelRequests.delete(payload.requestId);
      clearTimeout(pending.timer);
      if (payload.error) {
        pending.reject(new Error(payload.error));
      } else {
        pending.resolve(Array.isArray(payload.models) ? payload.models : []);
      }
    },
  );
}

/**
 * Request the renderer to fetch the model catalog for an extension provider.
 * The renderer-side initializeExtensionProviderModelBridge() listener calls
 * the extension impl's static getModels() and replies with the result.
 */
function requestModelsFromRenderer(providerId: string): Promise<AIModel[]> {
  wireModelResponseListenerOnce();

  const wc = resolveFirstWebContents();
  if (!wc) {
    return Promise.resolve([]);
  }

  const requestId = `extmodels-${Date.now()}-${++modelRequestSeq}`;

  return new Promise<AIModel[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingModelRequests.delete(requestId);
      reject(new Error(`ext-provider:get-models timed out for '${providerId}'`));
    }, 15_000);

    pendingModelRequests.set(requestId, { resolve, reject, timer });
    wc.send('ext-provider:get-models', { requestId, providerId });
  });
}

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
      // Model catalog: extension impls expose static getModels() in the renderer.
      // We round-trip through ext-provider:get-models so ModelRegistry's loop in
      // main can populate Settings dropdowns without duplicating the catalog.
      getModels: async () => {
        try {
          return await requestModelsFromRenderer(meta.id);
        } catch (err) {
          logger.main.warn(
            `[ExtensionProvider] getModels('${meta.id}') failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      },
    };
    ProviderRegistry.register(descriptor);
    logger.main.info(`[ExtensionProvider] registered '${meta.id}' (proxy + getModels) into main registry`);
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

