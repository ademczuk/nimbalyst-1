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
import { windows, windowStates } from '../window/windowState';
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

/**
 * Bridge timeout (ms). Generous on purpose: the renderer's getModels() routes
 * through `antigravity:get-models` which can have to cold-start the local
 * Antigravity language server on first call. That spawn + handshake takes
 * 5-15s in the worst case, so a 15s budget for the WHOLE round trip is too
 * tight and the bridge times out before the renderer has a chance to reply.
 * 30s leaves room for cold start and still bounds the wait if the renderer
 * truly never responds (e.g. window torn down mid-request).
 */
const MODEL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Pick the webContents that should answer an extension-provider IPC.
 *
 * The renderer-side bridge listener (initializeExtensionProviderModelBridge()
 * in registerExtensionSystem.ts) is wired in every renderer that finishes
 * registerExtensionSystem(). That includes the OffscreenEditorManager capture
 * window (`?mode=capture`) which loads the same renderer entry point. A naive
 * `BrowserWindow.getAllWindows()[0]` can therefore pick the capture window or
 * an auxiliary window (About, AIUsageReport, etc.) over the actual workspace
 * window the user is interacting with. To make the routing deterministic we
 * prefer the WindowManager-tracked workspace windows (the `windows` Map only
 * contains windows opened via createWindow(), so capture/About/etc. are
 * excluded by construction). We broadcast to ALL such workspace windows and
 * accept the first response back - if for some reason one window hasn't yet
 * loaded its extensions but another has, the loaded one wins.
 */
function resolveCandidateWebContents(): WebContents[] {
  const out: WebContents[] = [];

  // Prefer WindowManager-tracked workspace/agentic windows. These are the
  // only windows guaranteed to have run registerExtensionSystem() to
  // completion in the normal (non-capture) renderer mode.
  for (const [windowId, win] of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const state = windowStates.get(windowId);
    if (state?.mode === 'workspace' || state?.mode === 'agentic-coding') {
      out.push(win.webContents);
    }
  }

  // Fallback: if no workspace window is tracked yet (very early boot, or all
  // windows are in 'document' mode), include any non-destroyed BrowserWindow
  // webContents. The capture window also wires the bridge listener, so even
  // if we pick it, the listener will respond.
  if (out.length === 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        out.push(win.webContents);
      }
    }
  }

  return out;
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
      const modelCount = Array.isArray(payload.models) ? payload.models.length : 0;
      logger.main.info(
        `[ExtensionProvider] ext-provider:get-models response for ${payload.requestId}: ${
          payload.error ? `error="${payload.error}"` : `${modelCount} model(s)`
        }`,
      );
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
 *
 * Sends the request to every workspace webContents. The first one to reply
 * wins; later replies for the same requestId are ignored by the response
 * listener (the pending entry is deleted on first resolve/reject).
 */
function requestModelsFromRenderer(providerId: string): Promise<AIModel[]> {
  wireModelResponseListenerOnce();

  const candidates = resolveCandidateWebContents();
  if (candidates.length === 0) {
    logger.main.warn(
      `[ExtensionProvider] requestModelsFromRenderer('${providerId}'): no live webContents`,
    );
    return Promise.resolve([]);
  }

  const requestId = `extmodels-${Date.now()}-${++modelRequestSeq}`;
  logger.main.info(
    `[ExtensionProvider] dispatching ext-provider:get-models id=${requestId} provider=${providerId} to ${candidates.length} webContents`,
  );

  return new Promise<AIModel[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingModelRequests.delete(requestId);
      reject(
        new Error(
          `ext-provider:get-models timed out for '${providerId}' after ${MODEL_REQUEST_TIMEOUT_MS}ms (sent to ${candidates.length} webContents)`,
        ),
      );
    }, MODEL_REQUEST_TIMEOUT_MS);

    pendingModelRequests.set(requestId, { resolve, reject, timer });

    for (const wc of candidates) {
      try {
        wc.send('ext-provider:get-models', { requestId, providerId });
      } catch (err) {
        // Send-after-destroyed or similar; don't fail the whole request if
        // ONE webContents is wedged, the others may still respond.
        logger.main.warn(
          `[ExtensionProvider] webContents.send failed for ${providerId} on wc#${wc.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
