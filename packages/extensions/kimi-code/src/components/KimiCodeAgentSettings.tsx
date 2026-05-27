/**
 * Settings panel for the Kimi Code AGENT provider.
 *
 * Mirrors KimiCodeSettings (chat panel) and gemini's AntigravityAgentSettings.
 * The Moonshot API key field writes to the same `kimi-code` slot the chat
 * panel uses - one key, two providers.
 */

import React from 'react';
import { KimiCodeAgentProvider } from '../KimiCodeAgentProvider';

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

export interface KimiCodeAgentSettingsProps {
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

/** Shared with the chat panel. See KimiCodeSettings for rationale. */
const API_KEY_SLOT = 'moonshot';

export function KimiCodeAgentSettings({
  config,
  apiKeys,
  availableModels,
  loading,
  onToggle,
  onApiKeyChange,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
}: KimiCodeAgentSettingsProps): React.ReactElement {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  const currentApiKey = apiKeys?.[API_KEY_SLOT] ?? '';
  const hasApiKey = currentApiKey.length > 0;

  const [modelsError, setModelsError] = React.useState<string | null>(null);

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
    KimiCodeAgentProvider.getModels()
      .then(() => setModelsError(null))
      .catch((err: unknown) => {
        setModelsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <div className="provider-panel kimi-code-agent-panel flex flex-col" data-testid="kimi-code-agent-settings">
      <div className="kimi-code-main-column flex-1 flex flex-col">
        <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
            Kimi K2.6 (Agent)
          </h3>
          <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Agent provider that runs a Nimbalyst-orchestrated tool loop over
            Moonshot Kimi K2.6. Supports meta-agent mode: a Kimi agent can
            spawn Claude or Codex child sessions mid-loop via the meta-agent
            tool surface. Auth uses the same Moonshot API key as the chat
            provider.
          </p>
        </div>

        {/* API KEY (shared slot with chat panel) */}
        <div
          className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]"
          data-testid="kimi-code-agent-api-key-section"
        >
          <label htmlFor="kimi-code-agent-api-key" className="block text-base font-semibold text-[var(--nim-text)] mb-2">
            Moonshot API key
          </label>
          <input
            id="kimi-code-agent-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={currentApiKey}
            onChange={(e) => onApiKeyChange?.(API_KEY_SLOT, e.target.value)}
            placeholder="sk-..."
            className="w-full text-sm bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded-md px-3 py-2 text-[var(--nim-text)] placeholder:text-[var(--nim-text-muted)] focus:outline-none focus:border-[var(--nim-primary)]"
            data-testid="kimi-code-agent-api-key-input"
          />
          <p className="text-[12px] text-[var(--nim-text-muted)] mt-2 leading-relaxed">
            Shared with the Kimi Code Chat provider - one key, both providers.
          </p>
        </div>

        <div
          className="provider-panel-section kimi-code-test-row py-3 mb-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] px-4"
          data-testid="kimi-code-agent-connection-test"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <h4 className="text-base font-semibold text-[var(--nim-text)] mb-1">
                Connection
              </h4>
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Test the Moonshot API. The agent reuses the chat provider's
                key + endpoint.
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
              data-testid="kimi-code-agent-test-button"
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
              Enter a Moonshot API key above to enable testing.
            </div>
          )}
        </div>

        <div className="provider-panel-section py-3 mb-4 border-b border-[var(--nim-border)] flex items-center justify-between">
          <label htmlFor="kc-agent-enable" className="text-sm font-medium text-[var(--nim-text)]">
            Enable Kimi K2.6 (Agent)
          </label>
          <input
            id="kc-agent-enable"
            type="checkbox"
            checked={config.enabled || false}
            onChange={(e) => onToggle(e.target.checked)}
            className="cursor-pointer"
          />
        </div>

        {config.enabled && (
          <>
            <div
              className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
              data-testid="kimi-code-agent-models-list"
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
                        id={`kc-agent-model-${model.id}`}
                        checked={enabledModelIds.includes(model.id)}
                        onChange={(e) => onModelToggle(model.id, e.target.checked)}
                      />
                      <label htmlFor={`kc-agent-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
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
                Meta-agent mode is enabled when a session has agentRole = meta-agent;
                the Kimi agent can then spawn Claude or Codex child sessions.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
