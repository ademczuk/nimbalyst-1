/**
 * Settings panel for the Kimi Code CHAT provider.
 *
 * Mirrors packages/extensions/gemini-antigravity/src/components/AntigravitySettings.tsx
 * with two changes:
 *   1. Adds a Moonshot API key input (masked) that persists via onApiKeyChange.
 *      Both kimi-code (chat) and kimi-code-agent (agent) share the same key
 *      slot - "kimi-code" - because they're the same Moonshot account.
 *   2. Skips the per-mount auto-probe of getModels() that gemini's panel does
 *      on transition-to-enabled. Probing before the user has entered an API
 *      key always fails and would surface a confusing error every time the
 *      user toggles the provider on. The user clicks Test Connection when
 *      they're ready instead.
 */

import React from 'react';
import { KimiCodeProvider } from '../KimiCodeProvider';

interface Model {
  id: string;
  name: string;
  provider: string;
}

interface ProviderConfig {
  enabled?: boolean;
  testStatus?: 'idle' | 'testing' | 'success' | 'error';
  testMessage?: string;
  models?: string[];
}

export interface KimiCodeSettingsProps {
  config: ProviderConfig;
  apiKeys?: Record<string, string>;
  availableModels: Model[];
  loading?: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange?: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange?: (updates: Partial<ProviderConfig>) => void;
}

/**
 * Both kimi-code providers persist the Moonshot API key in ONE shared slot.
 * Slot is named at the VENDOR level ("moonshot") rather than by provider id
 * because the secret it holds is a Moonshot account credential - one
 * account funds both the chat and agent providers. Main reads the same
 * slot in KimiCodeClient.getMoonshotApiKey().
 */
const API_KEY_SLOT = 'moonshot';

export function KimiCodeSettings({
  config,
  apiKeys,
  availableModels,
  loading,
  onToggle,
  onApiKeyChange,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
}: KimiCodeSettingsProps): React.ReactElement {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  const currentApiKey = apiKeys?.[API_KEY_SLOT] ?? '';
  const hasApiKey = currentApiKey.length > 0;

  const [modelsError, setModelsError] = React.useState<string | null>(null);

  // Auto-tick all models on first enable. Mirrors AntigravitySettings. Ref
  // guard prevents StrictMode double-invoke from racing the persist round-trip.
  const autoSelectFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (
      !autoSelectFiredRef.current
      && config.enabled
      && config.models === undefined
      && availableModels.length > 0
    ) {
      autoSelectFiredRef.current = true;
      onSelectAllModels(true);
    }
  }, [config.enabled, config.models, availableModels.length, onSelectAllModels]);

  const handleProbeModels = React.useCallback(() => {
    setModelsError(null);
    KimiCodeProvider.getModels()
      .then(() => setModelsError(null))
      .catch((err: unknown) => {
        setModelsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <div className="provider-panel kimi-code-panel flex flex-col" data-testid="kimi-code-settings">
      <div className="kimi-code-main-column flex-1 flex flex-col">
        {/* HEADER */}
        <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
            Kimi K2.6 (Chat)
          </h3>
          <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Talks to Moonshot's Kimi K2.6 through the OpenAI-compatible
            platform.moonshot.ai API. Requires a Moonshot API key entered below.
            The key is stored in your local Nimbalyst settings and never read
            from environment variables.
          </p>
        </div>

        {/* API KEY */}
        <div
          className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]"
          data-testid="kimi-code-api-key-section"
        >
          <label htmlFor="kimi-code-api-key" className="block text-base font-semibold text-[var(--nim-text)] mb-2">
            Moonshot API key
          </label>
          <input
            id="kimi-code-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={currentApiKey}
            onChange={(e) => onApiKeyChange?.(API_KEY_SLOT, e.target.value)}
            placeholder="sk-..."
            className="w-full text-sm bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded-md px-3 py-2 text-[var(--nim-text)] placeholder:text-[var(--nim-text-muted)] focus:outline-none focus:border-[var(--nim-primary)]"
            data-testid="kimi-code-api-key-input"
          />
          <p className="text-[12px] text-[var(--nim-text-muted)] mt-2 leading-relaxed">
            Get a key at <span className="font-mono">platform.moonshot.ai</span>. The same key is shared with the Kimi Code Agent provider.
          </p>
        </div>

        {/* CONNECTION TEST */}
        <div
          className="provider-panel-section kimi-code-test-row py-3 mb-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] px-4"
          data-testid="kimi-code-connection-test"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <h4 className="text-base font-semibold text-[var(--nim-text)] mb-1">
                Connection
              </h4>
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Calls GET /v1/models with your key. If it fails, the error is
                shown below.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void onTestConnection().then(handleProbeModels); }}
              disabled={loading || config.testStatus === 'testing' || !hasApiKey}
              className={`provider-test-button py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed ${
                config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''
              } ${
                config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
              }`}
              data-testid="kimi-code-test-button"
            >
              {config.testStatus === 'testing'
                ? 'Testing...'
                : config.testStatus === 'success'
                ? 'Connected'
                : config.testStatus === 'error'
                ? 'Failed'
                : 'Test connection'}
            </button>
          </div>
          {config.testMessage && config.testStatus === 'error' && (
            <div className="text-xs mt-2 text-[var(--nim-error)]">
              {config.testMessage}
            </div>
          )}
          {!hasApiKey && (
            <div className="text-xs mt-2 text-[var(--nim-text-muted)]">
              Enter your Moonshot API key above to enable testing.
            </div>
          )}
        </div>

        {/* ENABLE TOGGLE */}
        <div className="provider-panel-section py-3 mb-4 border-b border-[var(--nim-border)] flex items-center justify-between">
          <label htmlFor="kc-enable" className="text-sm font-medium text-[var(--nim-text)]">
            Enable Kimi K2.6 (Chat)
          </label>
          <input
            id="kc-enable"
            type="checkbox"
            checked={config.enabled || false}
            onChange={(e) => onToggle(e.target.checked)}
            className="cursor-pointer"
          />
        </div>

        {config.enabled && (
          <>
            {/* MODELS LIST */}
            <div
              className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
              data-testid="kimi-code-models-list"
            >
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
                <>
                  {modelsError && !loading && (
                    <p className="text-[13px] text-[var(--nim-error)] mb-2">
                      {modelsError}
                    </p>
                  )}
                  <p className="text-[13px] text-[var(--nim-text-muted)]">
                    {loading
                      ? 'Loading models...'
                      : hasApiKey
                        ? 'No models found. Test the connection to fetch the live catalog.'
                        : 'Enter a Moonshot API key to load the model catalog.'}
                  </p>
                </>
              ) : (
                <ul className="provider-model-list flex flex-col gap-1">
                  {availableModels.map((model) => (
                    <li key={model.id} className="provider-model-row flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        id={`kc-model-${model.id}`}
                        checked={enabledModelIds.includes(model.id)}
                        onChange={(e) => onModelToggle(model.id, e.target.checked)}
                      />
                      <label htmlFor={`kc-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
                        {model.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="provider-panel-section py-3">
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Default model is <strong>Kimi K2.6</strong> (256K context).
                Pricing and quota live on your Moonshot dashboard.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
