import React from 'react';
import { ProviderConfig, Model } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';

interface AntigravityPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
}

/**
 * Settings panel for the Antigravity-backed Gemini chat provider.
 *
 * Unlike LM Studio there is no API key or base URL to configure: auth rides the
 * user's existing Antigravity / Gemini login in ~/.gemini, and nimbalyst manages
 * the language-server lifecycle itself (attaching to a running Antigravity IDE
 * when present, otherwise spawning a headless standalone server).
 */
export function AntigravityPanel({
  config,
  availableModels,
  loading,
  onToggle,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
}: AntigravityPanelProps) {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  return (
    <div className="provider-panel antigravity-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          Gemini (Antigravity)
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Use Google's Gemini models (default: Gemini 3.5 Flash High) through the
          Antigravity language server. No API key required - this rides your
          existing Antigravity / Gemini sign-in. Requires Antigravity installed and
          signed in at least once. Nimbalyst manages the server for you.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable Gemini (Antigravity)"
        checked={config.enabled}
        onChange={onToggle}
      />

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
              Connection
            </h4>
            <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
              Authentication uses your Antigravity / Gemini login (no key stored in
              Nimbalyst). If the connection test fails, sign in via the Antigravity
              IDE once, then test again.
            </p>
            <button
              type="button"
              onClick={() => { void onTestConnection(); }}
              disabled={loading}
              className="provider-test-button py-2 px-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:border-[var(--nim-primary)] disabled:opacity-50"
            >
              {loading ? 'Testing...' : 'Test connection'}
            </button>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <div className="flex items-center justify-between mb-3">
              <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)]">
                Models
              </h4>
              {availableModels.length > 0 && (
                <button
                  type="button"
                  onClick={() => onSelectAllModels(!allSelected)}
                  className="text-[13px] text-[var(--nim-primary)] hover:underline"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>

            {availableModels.length === 0 ? (
              <p className="text-[13px] text-[var(--nim-text-muted)]">
                {loading
                  ? 'Loading models...'
                  : 'No models found. Make sure Antigravity is installed and you are signed in, then test the connection.'}
              </p>
            ) : (
              <ul className="provider-model-list flex flex-col gap-1">
                {availableModels.map((model) => (
                  <li key={model.id} className="provider-model-row flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      id={`agy-model-${model.id}`}
                      checked={enabledModelIds.includes(model.id)}
                      onChange={(e) => onModelToggle(model.id, e.target.checked)}
                    />
                    <label htmlFor={`agy-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
                      {model.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="provider-panel-section py-4">
            <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
              Usage and quota for these models come from your Antigravity plan.
              Nimbalyst surfaces the remaining quota and reset time so you can avoid
              rate limits.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
