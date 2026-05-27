/**
 * KimiUsageIndicator - status chip for the Kimi (Kimi Code CLI) auth state.
 *
 * Sits in the navigation gutter next to the AntigravityUsageIndicator and
 * CodexUsageIndicator chips. Differs from those two in that the Kimi Code
 * endpoint does not expose credits or per-model quotas, so this chip shows
 * the local OAuth state instead:
 *
 *   green dot   token valid, expires-in shown in tooltip
 *   yellow dot  token expired (background refresh likely in progress)
 *   muted dot   user has not logged in via the Kimi Code CLI yet
 *
 * Click toggles a small popover with the status and an "Open settings"
 * button that jumps to the Kimi (Chat) settings panel.
 *
 * Visibility: only when one of the contributed kimi-code providers is
 * BOTH enabled in providerSettings AND registered in ProviderRegistry
 * (mirrors AntigravityUsageIndicator). Hidden after uninstall.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  kimiAuthSnapshotAtom,
  kimiIndicatorVisibleAtom,
  kimiStatusColorAtom,
  formatExpiresIn,
  type KimiAuthSnapshot,
} from '../../store/atoms/kimiAuthAtoms';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface KimiUsageIndicatorProps {
  className?: string;
  onOpenSettings?: (categoryId: string) => void;
}

const POLL_INTERVAL_MS = 15_000;

export const KimiUsageIndicator: React.FC<KimiUsageIndicatorProps> = ({
  className,
  onOpenSettings,
}) => {
  const visible = useAtomValue(kimiIndicatorVisibleAtom);
  const snap = useAtomValue(kimiAuthSnapshotAtom);
  const color = useAtomValue(kimiStatusColorAtom);
  const setSnap = useSetAtom(kimiAuthSnapshotAtom);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Poll auth status while the chip is visible. The IPC reads only the
  // local credentials file - no network - so 15s is fine.
  useEffect(() => {
    if (!visible) {
      setPopoverOpen(false);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).electronAPI;
        if (!api?.invoke) return;
        const res = (await api.invoke('kimi-code:auth:status')) as {
          ok: boolean;
          data?: KimiAuthSnapshot;
          error?: string;
        };
        if (!cancelled && res?.ok && res.data) {
          setSnap(res.data);
        }
      } catch {
        // Probe failure is non-fatal; the next tick may succeed.
      }
    };
    void probe();
    const id = window.setInterval(probe, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [visible, setSnap]);

  // Force-close the popover on outside click.
  useEffect(() => {
    if (!popoverOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (buttonRef.current && t && !buttonRef.current.parentElement?.contains(t)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [popoverOpen]);

  const handleClick = useCallback(() => {
    setPopoverOpen((p) => !p);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setPopoverOpen(false);
    if (onOpenSettings) {
      onOpenSettings('kimi-code');
    }
  }, [onOpenSettings]);

  if (!visible) return null;

  const stateLabel =
    snap?.state === 'valid'
      ? 'Connected'
      : snap?.state === 'expired'
      ? 'Session expired'
      : snap?.state === 'not-logged-in'
      ? 'Not logged in'
      : 'Checking...';

  const expiresLine =
    snap?.state === 'valid' && typeof snap.expiresAt === 'number'
      ? `Expires in ${formatExpiresIn(snap.expiresAt)}`
      : snap?.state === 'expired'
      ? 'Refreshing in the background'
      : snap?.state === 'not-logged-in'
      ? 'Run /login in the Kimi Code CLI'
      : '';

  const tooltipText = `Kimi: ${stateLabel}${expiresLine ? ` (${expiresLine})` : ''}`;

  // The status dot is positioned over the icon. ring-2 with the gutter bg
  // color punches a visible border so the dot doesn't blend into the icon.
  // kimiStatusColorAtom returns 'green' | 'yellow' | 'muted' only (no 'red');
  // the muted fallback also catches the loading state when snap is null.
  const dotColorClass =
    color === 'green'
      ? 'bg-green-500'
      : color === 'yellow'
      ? 'bg-yellow-500'
      : 'bg-gray-400';

  return (
    <div className={`relative kimi-usage-indicator ${className || ''}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        title={tooltipText}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Kimi (Kimi Code) auth status"
        data-testid="kimi-usage-indicator"
      >
        <MaterialSymbol icon="kimi" size={22} />
        <span
          className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full ${dotColorClass} ring-2 ring-[var(--nim-bg-secondary,var(--nim-bg))]`}
          aria-hidden="true"
        />
      </button>

      {popoverOpen && (
        <div
          className="absolute left-full ml-2 top-0 z-50 min-w-[220px] p-3 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-lg"
          data-testid="kimi-usage-popover"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${dotColorClass} shrink-0`} aria-hidden="true" />
            <p className="text-sm font-semibold text-[var(--nim-text)]">Kimi - {stateLabel}</p>
          </div>
          {expiresLine && (
            <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)] mb-3">{expiresLine}</p>
          )}
          <button
            type="button"
            onClick={handleOpenSettings}
            className="w-full py-1.5 px-3 rounded-md text-[13px] font-medium bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] cursor-pointer"
          >
            Open Kimi settings
          </button>
        </div>
      )}
    </div>
  );
};
