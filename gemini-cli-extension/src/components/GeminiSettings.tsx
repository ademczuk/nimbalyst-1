/**
 * Gemini settings panel (renderer-safe).
 *
 * Ported from
 * packages/electron/src/renderer/components/GlobalSettings/panels/GeminiPanel.tsx
 * but it MUST NOT call any core-only IPC. The original called:
 *   - window.electronAPI.aiGetGeminiOAuthStatus() / 'ai:getGeminiOAuthStatus'
 *   - window.electronAPI.invoke('cli:checkInstallation' | 'cli:install', ...)
 *   - jotai atoms in the electron renderer store
 * none of which exist for a marketplace extension. They are replaced with a
 * static note. The turn itself does not depend on this panel - auth is handled
 * by the gemini CLI's own OAuth in ~/.gemini.
 */

import React from 'react';

// The host passes settings panels a small props bag. We only need it to be
// permissive; nothing in this static panel reads from it.
export interface GeminiSettingsProps {
  theme?: string;
  storage?: unknown;
}

export function GeminiSettings(_props: GeminiSettingsProps): React.ReactElement {
  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          Google Gemini (CLI)
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Run agent sessions using the official Google Gemini CLI. Authentication
          uses the gemini CLI's own OAuth login, so no API keys are entered here.
        </p>
      </div>

      {/* CLI install instructions (static - no install IPC in a marketplace ext) */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Gemini CLI Tool
        </h4>
        <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
          This provider drives the Google Gemini CLI. If it is not already
          installed, install it globally:
        </p>
        <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded select-text">
          npm install -g @google/gemini-cli
        </code>
      </div>

      {/* Authentication note (static - no OAuth-status IPC) */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Google Authentication
        </h4>
        <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed mb-3">
          Auth uses the gemini CLI OAuth stored in{' '}
          <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">~/.gemini/oauth_creds.json</code>.
          To sign in (or refresh an expired session), run the CLI once in your
          terminal and complete the browser login:
        </p>
        <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded select-text">
          gemini -p "hello"
        </code>
      </div>

      {/* Model note */}
      <div className="provider-panel-section py-4">
        <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
          Models and credentials follow your global gemini CLI configuration. The
          default agent model is{' '}
          <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">gemini-2.5-flash</code>.
        </p>
      </div>
    </div>
  );
}
