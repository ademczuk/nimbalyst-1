/**
 * Renderer half of the extension-provider turn bridge.
 *
 * The main-process ExtensionProviderProxy delegates each turn here via
 * `ext-provider:turn:start`. This module looks up the extension's provider impl
 * (contributed through `aiProviders`), instantiates it once per session (so a
 * persistent agent session such as gemini --acp survives across turns), gives it
 * a `host.spawn` bound to the spawn bridge, runs `sendMessage`, and streams the
 * StreamChunks / provider events / session data back to the proxy.
 *
 * Transport split: the impl's protocol logic runs here in the renderer, but its
 * child process is spawned in MAIN through `extension:spawn` (so it can run a
 * .cmd shim on Windows and keep node out of the renderer).
 */

import { getExtensionLoader } from '@nimbalyst/runtime';
import type { StreamChunk } from '@nimbalyst/runtime/ai/server/types';
import type { ExtensionSpawnHandle, SpawnOptions } from '@nimbalyst/extension-sdk';

/** Host handed to an extension provider impl so it can spawn its CLI. */
export interface ExtensionProviderHost {
  spawn: (command: string, args?: string[], options?: SpawnOptions) => Promise<ExtensionSpawnHandle>;
}

/** Methods the bridge drives on an extension provider instance. Mirrors the
 * subset of AIProvider the session loop uses; all but sendMessage optional. */
interface ExtensionProviderInstance {
  initialize?(config: unknown): Promise<void> | void;
  sendMessage(
    message: string,
    documentContext?: unknown,
    sessionId?: string,
    messages?: unknown[],
    workspacePath?: string,
    attachments?: unknown[]
  ): AsyncIterable<StreamChunk>;
  setProviderSessionData?(sessionId: string, data: unknown): void;
  getProviderSessionData?(sessionId: string): unknown;
  abort?(): void;
  destroy?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ExtensionProviderCtor = new (host: ExtensionProviderHost) => ExtensionProviderInstance;

/** Provider EventEmitter events the main streaming handler subscribes to. The
 * impl emits these in the renderer; we forward them so the proxy re-emits. */
const FORWARDED_PROVIDER_EVENTS = [
  'message:logged',
  'session:title-updated',
  'session:metadata-updated',
  'exitPlanMode:confirm',
  'exitPlanMode:resolved',
  'askUserQuestion:pending',
  'askUserQuestion:answered',
  'toolPermission:pending',
  'toolPermission:resolved',
  'promptAdditions',
  'session:providerSessionExpired',
  'session:providerSessionReceived',
  'teammate:messageWhileIdle',
  'teammates:allCompleted',
];

interface InstanceRecord {
  inst: ExtensionProviderInstance;
  currentTurnId: string | null;
}

const instances = new Map<string, InstanceRecord>();

interface TurnStartPayload {
  providerId: string;
  turnId: string;
  sessionId?: string;
  message: string;
  documentContext?: unknown;
  messages?: unknown[];
  workspacePath?: string;
  attachments?: unknown[];
  config?: unknown;
  providerSessionData?: unknown;
}

/** Build a host.spawn bound to a specific extension id (the spawn bridge
 * enforces that extension's `permissions.process`). Mirrors PanelHostImpl. */
function makeSpawn(extensionId: string): ExtensionProviderHost['spawn'] {
  return async (command, args = [], options = {}) => {
    const api = window.electronAPI;
    const res = (await api.invoke('extension:spawn', {
      extensionId,
      command,
      args,
      options,
    })) as { success: boolean; handleId?: string; error?: string };
    if (!res?.success || !res.handleId) {
      throw new Error(res?.error || `extension:spawn failed for ${command}`);
    }
    const handleId = res.handleId;

    const subscribe = (
      channel: string,
      cb: (data: unknown) => void
    ): (() => void) =>
      api.on(channel, (payload: { handleId?: string; data?: unknown; code?: number | null; signal?: string | null }) => {
        if (payload?.handleId === handleId) cb(payload);
      });

    const handle: ExtensionSpawnHandle = {
      handleId,
      write: async (data: string) => {
        await api.invoke('extension:spawn:write', { handleId, data });
      },
      kill: async () => {
        await api.invoke('extension:spawn:kill', { handleId });
      },
      onStdout: (cb: (data: string) => void) =>
        subscribe('extension:spawn:stdout', (p: any) => cb(p.data)),
      onStderr: (cb: (data: string) => void) =>
        subscribe('extension:spawn:stderr', (p: any) => cb(p.data)),
      onExit: (cb: (info: { code: number | null; signal: string | null }) => void) =>
        subscribe('extension:spawn:exit', (p: any) => cb({ code: p.code ?? null, signal: p.signal ?? null })),
    };
    return handle;
  };
}

function resolveImpl(providerId: string): { extensionId: string; impl: unknown } | null {
  for (const entry of getExtensionLoader().getAiProviders()) {
    if (entry.contribution.id === providerId) {
      return { extensionId: entry.extensionId, impl: entry.impl };
    }
  }
  return null;
}

function getOrCreateInstance(payload: TurnStartPayload): InstanceRecord | { error: string } {
  const key = `${payload.providerId}::${payload.sessionId ?? '_'}`;
  const existing = instances.get(key);
  if (existing) return existing;

  const found = resolveImpl(payload.providerId);
  if (!found) {
    return { error: `Extension provider '${payload.providerId}' is not installed/enabled.` };
  }
  if (typeof found.impl !== 'function') {
    return { error: `Extension provider '${payload.providerId}' export is not a constructor.` };
  }

  const Ctor = found.impl as ExtensionProviderCtor;
  const inst = new Ctor({ spawn: makeSpawn(found.extensionId) });
  const record: InstanceRecord = { inst, currentTurnId: null };

  // Subscribe once; route emitted events to whatever turn is active.
  if (typeof inst.on === 'function') {
    for (const ev of FORWARDED_PROVIDER_EVENTS) {
      inst.on(ev, (...args: unknown[]) => {
        if (!record.currentTurnId) return;
        window.electronAPI.send('ext-provider:turn:event', {
          turnId: record.currentTurnId,
          event: ev,
          args,
        });
      });
    }
  }

  instances.set(key, record);
  return record;
}

async function runTurn(payload: TurnStartPayload): Promise<void> {
  const api = window.electronAPI;
  const got = getOrCreateInstance(payload);
  if ('error' in got) {
    api.send('ext-provider:turn:end', { turnId: payload.turnId, error: got.error });
    return;
  }
  const record = got;
  const { inst } = record;
  record.currentTurnId = payload.turnId;

  try {
    if (typeof inst.initialize === 'function') {
      await inst.initialize(payload.config);
    }
    if (payload.providerSessionData !== undefined && typeof inst.setProviderSessionData === 'function' && payload.sessionId) {
      inst.setProviderSessionData(payload.sessionId, payload.providerSessionData);
    }

    for await (const chunk of inst.sendMessage(
      payload.message,
      payload.documentContext,
      payload.sessionId,
      payload.messages,
      payload.workspacePath,
      payload.attachments
    )) {
      api.send('ext-provider:turn:chunk', { turnId: payload.turnId, chunk });
    }

    if (payload.sessionId && typeof inst.getProviderSessionData === 'function') {
      const data = inst.getProviderSessionData(payload.sessionId);
      if (data !== undefined) {
        api.send('ext-provider:turn:sessionData', {
          turnId: payload.turnId,
          sessionId: payload.sessionId,
          data,
        });
      }
    }

    api.send('ext-provider:turn:end', { turnId: payload.turnId });
  } catch (err) {
    api.send('ext-provider:turn:end', {
      turnId: payload.turnId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (record.currentTurnId === payload.turnId) record.currentTurnId = null;
  }
}

let initialized = false;

/** Wire the renderer listeners for delegated turns. Idempotent. */
export function initializeExtensionProviderTurnBridge(): void {
  if (initialized) return;
  initialized = true;

  window.electronAPI.on('ext-provider:turn:start', (payload: TurnStartPayload) => {
    void runTurn(payload);
  });

  window.electronAPI.on('ext-provider:turn:cancel', (payload: { turnId: string }) => {
    for (const record of instances.values()) {
      if (record.currentTurnId === payload.turnId) {
        try {
          record.inst.abort?.();
        } catch {
          // ignore abort errors
        }
      }
    }
  });
}
