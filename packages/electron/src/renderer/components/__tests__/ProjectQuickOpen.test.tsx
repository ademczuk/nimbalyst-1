import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
}));

function setupElectronApiMock() {
  const invoke = vi.fn().mockImplementation(async (channel: string) => {
    if (channel === 'get-recent-workspaces') {
      return [
        {
          path: '/Users/ghinkle/sources/crystal',
          name: 'crystal',
          timestamp: 123,
        },
      ];
    }

    throw new Error(`Unexpected invoke channel: ${channel}`);
  });

  const getRecentWorkspaces = vi.fn().mockResolvedValue([
    {
      path: '/Users/ghinkle/sources/should-not-be-used',
      name: 'heavy-handler',
      lastOpened: 999,
    },
  ]);

  const getOpenWorkspaces = vi.fn().mockResolvedValue(['/Users/ghinkle/sources/crystal']);

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      workspaceManager: {
        getRecentWorkspaces,
        getOpenWorkspaces,
        openWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
    },
  });

  return { invoke, getRecentWorkspaces, getOpenWorkspaces };
}

describe('ProjectQuickOpen', () => {
  beforeEach(() => {
    setupElectronApiMock();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('loads recent projects from the lightweight recent-workspaces IPC', async () => {
    const { ProjectQuickOpen } = await import('../ProjectQuickOpen');
    const onClose = vi.fn();

    render(
      <ProjectQuickOpen
        isOpen={true}
        onClose={onClose}
        currentWorkspacePath={null}
      />
    );

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('get-recent-workspaces');
    });

    expect(window.electronAPI.workspaceManager.getOpenWorkspaces).toHaveBeenCalledOnce();
    expect(window.electronAPI.workspaceManager.getRecentWorkspaces).not.toHaveBeenCalled();
    expect(await screen.findByText('crystal')).toBeTruthy();
  });
});
