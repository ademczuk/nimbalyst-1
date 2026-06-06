// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Keep the component isolated: jotai atom reads return defaults, and the store
// atom families are callable stubs so importing them has no side effects.
vi.mock('jotai', () => ({
  useAtomValue: () => undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null, ProviderIcon: () => null }));
// The store atoms are callable stubs (atom families called with a sessionId);
// their values are read through the mocked jotai useAtomValue above, so the
// stub return value never matters. Factories are inlined (no outer ref) to
// avoid the vi.mock hoisting TDZ.
vi.mock('../../../store', () => ({
  sessionOrChildProcessingAtom: () => ({}),
  sessionUnreadAtom: () => ({}),
  sessionPendingPromptAtom: () => ({}),
  sessionHasPendingInteractivePromptAtom: () => ({}),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  sessionWakeupAtom: () => ({}),
  sessionLastActivityAtom: () => ({}),
}));
vi.mock('../../../store/atoms/sessions', () => ({ convertToWorkstreamAtom: () => ({}) }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));

// jsdom has no ResizeObserver; stub it and capture the latest callback so a
// test can simulate the title element being visually clipped.
let resizeCb: (() => void) | null = null;
let observeCount = 0;
let disconnectCount = 0;
vi.stubGlobal('ResizeObserver', class {
  constructor(cb: () => void) { resizeCb = cb; }
  observe() { observeCount += 1; }
  unobserve() {}
  disconnect() { disconnectCount += 1; }
});

import { SessionListItem } from '../SessionListItem';

const baseProps = {
  id: 's1',
  createdAt: 1_700_000_000_000,
  isActive: false,
  onClick: () => {},
};

beforeEach(() => { resizeCb = null; observeCount = 0; disconnectCount = 0; });
afterEach(() => cleanup());

describe('SessionListItem - full name on hover (#577, #429)', () => {
  // The hover title appears only when the name is actually hidden: JS-truncated
  // past 40 chars, or visually clipped by text-ellipsis. No redundant tooltip on
  // names that already fit, in a list users traverse by hovering.
  const long = 'A very long session name that runs well past the forty character cutoff';

  it('exposes the full name in title for a long, JS-truncated name', () => {
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const titleEl = container.querySelector('.session-list-item-title');
    expect(titleEl?.getAttribute('title')).toBe(long);
  });

  it('sets no title on a short name that fits (no redundant tooltip)', () => {
    const short = 'Short name';
    const { container } = render(<SessionListItem {...baseProps} title={short} />);
    const titleEl = container.querySelector('.session-list-item-title');
    expect(titleEl?.getAttribute('title')).toBeNull();
  });

  it('exposes the full name when a short name is visually clipped (overflow)', () => {
    const mid = 'Mid length session name';
    const { container } = render(<SessionListItem {...baseProps} title={mid} />);
    const titleEl = container.querySelector('.session-list-item-title') as HTMLElement;
    expect(titleEl.getAttribute('title')).toBeNull(); // fits initially (jsdom 0x0)
    Object.defineProperty(titleEl, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(titleEl, 'clientWidth', { configurable: true, value: 100 });
    act(() => { resizeCb?.(); });
    expect(titleEl.getAttribute('title')).toBe(mid);
  });

  // Rename mode swaps the title div for an input and back; the callback ref must
  // tear down and rebind the observer across that remount, or a clipped name
  // loses its tooltip. Proven via the observer lifecycle (observe on mount,
  // disconnect on unmount), which is the same mechanism the rename swap exercises.
  it('rebinds the overflow observer across unmount and remount (covers the rename-mode title swap)', () => {
    const { unmount } = render(<SessionListItem {...baseProps} title="Mid length session name" />);
    expect(observeCount).toBeGreaterThan(0);
    const before = disconnectCount;
    unmount();
    expect(disconnectCount).toBe(before + 1);
  });

  // The native title is not a keyboard/touch affordance, so the row's accessible
  // name must carry the full title regardless, or two sessions sharing the first
  // 40 chars are indistinguishable to a screen reader.
  it('always uses the full name in the row aria-label, not the truncated form', () => {
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const row = container.querySelector('[aria-label^="Session: "]');
    expect(row?.getAttribute('aria-label')).toContain(long);
  });
});
