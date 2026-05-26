/**
 * Settings panel for the Antigravity Gemini AGENT provider.
 *
 * The inline UsageChip that previously occupied the left column has been
 * REMOVED -- account credits and per-model quota now live on the global
 * AntigravityUsageIndicator floating in the bottom-left navigation gutter,
 * matching the Codex Usage chip pattern. This panel is focused on
 * connection / enable / model selection only.
 */

import React from 'react';

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

export interface AntigravityAgentSettingsProps {
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

export function AntigravityAgentSettings({
  config,
  availableModels,
  loading,
  onToggle,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
}: AntigravityAgentSettingsProps): React.ReactElement {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  // CLA-185 DIAGNOSTIC: same render-tracking logging as the chat panel above.
  // Mirrors AntigravitySettings so we can compare what each panel actually
  // received between renders.
  console.log('[AntigravityAgentSettings] render', {
    provider: 'antigravity-gemini-agent',
    isEnabled: config.enabled === true,
    testStatus: config.testStatus,
    modelsCount: availableModels.length,
    enabledModelIdsCount: enabledModelIds.length,
    enabledModelIds,
    isLoadingModels: Boolean(loading),
    allSelected,
  });

  return (
    <div className="provider-panel antigravity-agent-panel flex flex-col" data-testid="antigravity-agent-settings">
      <div className="antigravity-main-column flex-1 flex flex-col">
        <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
            Gemini 3.5 Flash (Agent)
          </h3>
          <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Agent provider that runs a Nimbalyst-orchestrated tool loop over
            Gemini 3.5 Flash. Supports meta-agent mode and the full Nimbalyst
            tool registry. Auth uses your existing ~/.gemini login.
          </p>
        </div>

        <div
          className="provider-panel-section antigravity-test-row py-3 mb-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] px-4"
          data-testid="antigravity-agent-connection-test"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <h4 className="text-base font-semibold text-[var(--nim-text)] mb-1">
                Connection
              </h4>
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Test the local Antigravity server. The agent reuses the same
                server as the chat provider.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                console.log(
                  '[AntigravityAgentSettings] Test connection clicked, calling onTestConnection() for antigravity-gemini-agent',
                  { configEnabled: config.enabled === true, currentTestStatus: config.testStatus },
                );
                const promise = onTestConnection();
                Promise.resolve(promise)
                  .then(() => {
                    console.log(
                      '[AntigravityAgentSettings] Test connection resolved for antigravity-gemini-agent',
                    );
                  })
                  .catch((err) => {
                    console.error(
                      '[AntigravityAgentSettings] Test connection threw for antigravity-gemini-agent:',
                      err,
                    );
                  });
              }}
              disabled={loading || config.testStatus === 'testing'}
              className={`provider-test-button py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-50 ${
                config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''
              } ${
                config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
              }`}
            >
              {config.testStatus === 'testing'
                ? 'Testing...'
                : config.testStatus === 'success'
                ? '✓ Connected'
                : config.testStatus === 'error'
                ? '✗ Failed'
                : 'Test connection'}
            </button>
          </div>
          {config.testMessage && config.testStatus === 'error' && (
            <div className="text-xs mt-2 text-[var(--nim-error)]">
              {config.testMessage}
            </div>
          )}
        </div>

        <div className="provider-panel-section py-3 mb-4 border-b border-[var(--nim-border)] flex items-center justify-between">
          <label htmlFor="agy-agent-enable" className="text-sm font-medium text-[var(--nim-text)]">
            Enable Gemini 3.5 Flash (Agent)
          </label>
          <input
            id="agy-agent-enable"
            type="checkbox"
            checked={config.enabled || false}
            onChange={(e) => {
              console.log(
                '[AntigravityAgentSettings] enable toggle for antigravity-gemini-agent',
                { newState: e.target.checked, currentEnabled: config.enabled === true },
              );
              onToggle(e.target.checked);
            }}
            className="cursor-pointer"
          />
        </div>

        {config.enabled && (
          <>
            <div
              className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
              data-testid="antigravity-agent-models-list"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)]">
                  Models
                </h4>
                {availableModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      console.log(
                        '[AntigravityAgentSettings] Select/Deselect-all clicked for antigravity-gemini-agent',
                        { newState: !allSelected, modelsCount: availableModels.length },
                      );
                      onSelectAllModels(!allSelected);
                    }}
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
                        id={`agy-agent-model-${model.id}`}
                        checked={enabledModelIds.includes(model.id)}
                        onChange={(e) => {
                          console.log(
                            '[AntigravityAgentSettings] model toggle for antigravity-gemini-agent',
                            {
                              modelId: model.id,
                              newState: e.target.checked,
                              previousEnabledIds: enabledModelIds,
                              configEnabled: config.enabled === true,
                            },
                          );
                          onModelToggle(model.id, e.target.checked);
                        }}
                      />
                      <label htmlFor={`agy-agent-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
                        {model.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="provider-panel-section py-3">
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Default model is <strong>Gemini 3.5 Flash (High)</strong>. The
                agent uses the tool-loop protocol over GetModelResponse - no
                native function calling, no MCP passthrough.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
