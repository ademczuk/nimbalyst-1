/**
 * Panel Host Implementation
 *
 * Creates PanelHost instances for extension panels.
 * Handles communication between panels and the host application.
 */

import type { PanelHost, PanelAIContext, ExtensionStorage, ExtensionFileStorage, ExecOptions, ExecResult } from '@nimbalyst/runtime';
// SpawnOptions / ExtensionSpawnHandle are imported straight from the SDK: the
// runtime barrel (runtime/src/extensions/index.ts) re-exports panel types via an
// explicit named list owned by the extension-api workstream, so we avoid editing
// that guarded file. Both types reach the package root via `export *` in
// extension-sdk/src/types/index.ts.
import type { SpawnOptions, ExtensionSpawnHandle } from '@nimbalyst/extension-sdk';
import { ExtensionFileStorageImpl } from './ExtensionFileStorageImpl';

// ============================================================================
// Types
// ============================================================================

export interface PanelHostOptions {
  panelId: string;
  extensionId: string;
  theme: string;
  workspacePath: string;
  aiSupported: boolean;
  storage: ExtensionStorage;

  // Callbacks
  onOpenFile: (path: string) => void;
  onOpenPanel: (panelId: string) => void;
  onClose: () => void;
  onThemeChange: (callback: (theme: string) => void) => () => void;
}

// ============================================================================
// AI Context Implementation
// ============================================================================

class PanelAIContextImpl implements PanelAIContext {
  private context: Record<string, unknown> = {};
  private listeners = new Set<(context: Record<string, unknown>) => void>();

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
    this.notifyListeners();
  }

  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  clearContext(): void {
    this.context = {};
    this.notifyListeners();
  }

  notifyChange(event: string, data?: unknown): void {
    // Could be used for proactive AI suggestions in the future
    console.log(`[PanelAIContext] Event: ${event}`, data);
  }

  onContextChanged(callback: (context: Record<string, unknown>) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getContext());
      } catch (error) {
        console.error('[PanelAIContext] Error in listener:', error);
      }
    }
  }
}

// ============================================================================
// Panel Host Implementation
// ============================================================================

class PanelHostImpl implements PanelHost {
  readonly panelId: string;
  readonly extensionId: string;
  readonly workspacePath: string;
  readonly ai?: PanelAIContext;
  readonly storage: ExtensionStorage;
  readonly files: ExtensionFileStorage;

  private _theme: string;
  private _isSettingsOpen = false;
  private themeListeners = new Set<(theme: string) => void>();
  private eventCleanups: (() => void)[] = [];

  private onOpenFile: (path: string) => void;
  private onOpenPanel: (panelId: string) => void;
  private onClosePanel: () => void;
  private unsubscribeTheme: () => void;

  constructor(options: PanelHostOptions) {
    this.panelId = options.panelId;
    this.extensionId = options.extensionId;
    this._theme = options.theme;
    this.workspacePath = options.workspacePath;
    this.storage = options.storage;
    this.files = new ExtensionFileStorageImpl(options.extensionId, options.workspacePath);

    this.onOpenFile = options.onOpenFile;
    this.onOpenPanel = options.onOpenPanel;
    this.onClosePanel = options.onClose;

    // Subscribe to theme changes
    this.unsubscribeTheme = options.onThemeChange((theme) => {
      this._theme = theme;
      this.notifyThemeChange(theme);
    });

    // Create AI context if supported
    if (options.aiSupported) {
      this.ai = new PanelAIContextImpl();
    }
  }

  get theme(): string {
    return this._theme;
  }

  get isSettingsOpen(): boolean {
    return this._isSettingsOpen;
  }

  onThemeChanged(callback: (theme: string) => void): () => void {
    this.themeListeners.add(callback);
    return () => {
      this.themeListeners.delete(callback);
    };
  }

  openFile(path: string): void {
    this.onOpenFile(path);
  }

  openPanel(panelId: string): void {
    this.onOpenPanel(panelId);
  }

  close(): void {
    this.onClosePanel();
  }

  openSettings(): void {
    this._isSettingsOpen = true;
  }

  closeSettings(): void {
    this._isSettingsOpen = false;
  }

  onWorkspaceEvent(event: string, callback: (data: unknown) => void): () => void {
    const workspacePath = this.workspacePath;
    const unsub = window.electronAPI.on(event, (data: unknown) => {
      // Filter to events for this workspace
      const d = data as Record<string, unknown> | undefined;
      if (d?.workspacePath && d.workspacePath !== workspacePath) return;
      callback(data);
    });
    this.eventCleanups.push(unsub);
    return () => {
      unsub();
      this.eventCleanups = this.eventCleanups.filter(c => c !== unsub);
    };
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    try {
      const result = await window.electronAPI.invoke('extension:exec', {
        extensionId: this.extensionId,
        command,
        cwd: options?.cwd || this.workspacePath,
        timeout: options?.timeout || 60000,
        env: options?.env,
        maxBuffer: options?.maxBuffer || 10 * 1024 * 1024,
      });
      return result as ExecResult;
    } catch (error) {
      return {
        success: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
      };
    }
  }

  async spawn(command: string, args?: string[], options?: SpawnOptions): Promise<ExtensionSpawnHandle> {
    const result = await window.electronAPI.invoke('extension:spawn', {
      extensionId: this.extensionId,
      command,
      args: args ?? [],
      options: { cwd: options?.cwd ?? this.workspacePath, env: options?.env },
    }) as { success: boolean; handleId?: string; error?: string };

    if (!result?.success || !result.handleId) {
      throw new Error(result?.error || `Failed to spawn ${command}`);
    }

    const handleId = result.handleId;
    const localCleanups: Array<() => void> = [];

    // Subscribe to a spawn event, filtering by this handle's id. The generic
    // electronAPI.on passthrough forwards the payload and returns an unsubscribe.
    const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
      const unsub = window.electronAPI.on(channel, (payload: { handleId?: string } & T) => {
        if (!payload || payload.handleId !== handleId) return;
        cb(payload);
      });
      localCleanups.push(unsub);
      // Track on the host so dispose() tears down stragglers if the panel closes
      // without the extension unsubscribing.
      this.eventCleanups.push(unsub);
      return () => {
        unsub();
        this.eventCleanups = this.eventCleanups.filter((c) => c !== unsub);
        const i = localCleanups.indexOf(unsub);
        if (i >= 0) localCleanups.splice(i, 1);
      };
    };

    const handle: ExtensionSpawnHandle = {
      handleId,
      write: async (data: string) => {
        await window.electronAPI.invoke('extension:spawn:write', { handleId, data });
      },
      kill: async () => {
        await window.electronAPI.invoke('extension:spawn:kill', { handleId });
      },
      onStdout: (callback: (data: string) => void) =>
        subscribe<{ data: string }>('extension:spawn:stdout', (p) => callback(p.data)),
      onStderr: (callback: (data: string) => void) =>
        subscribe<{ data: string }>('extension:spawn:stderr', (p) => callback(p.data)),
      onExit: (callback: (info: { code: number | null; signal: string | null }) => void) =>
        subscribe<{ code: number | null; signal: string | null }>('extension:spawn:exit', (p) => {
          callback({ code: p.code ?? null, signal: p.signal ?? null });
          // Process is gone; drop this handle's listeners.
          for (const c of [...localCleanups]) c();
        }),
    };

    return handle;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.unsubscribeTheme();
    this.themeListeners.clear();
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];
  }

  private notifyThemeChange(theme: string): void {
    for (const listener of this.themeListeners) {
      try {
        listener(theme);
      } catch (error) {
        console.error('[PanelHost] Error in theme listener:', error);
      }
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a PanelHost instance for a panel.
 */
export function createPanelHost(options: PanelHostOptions): PanelHost {
  return new PanelHostImpl(options);
}
