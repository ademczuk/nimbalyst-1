import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { createPortal } from 'react-dom';
import { MaterialSymbol, getProviderIcon, getExtensionLoader } from '@nimbalyst/runtime';
import { useAlphaFeatures } from '../../hooks/useAlphaFeature';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { developerModeAtom } from '../../store/atoms/appSettings';

export type SettingsCategory =
  | 'agent-permissions'
  | 'claude-code'
  | 'claude'
  | 'openai'
  | 'openai-codex'
  | 'opencode'
  | 'copilot-cli'
  | 'gemini-cli'
  | 'lmstudio'
  // antigravity-gemini and antigravity-gemini-agent now ship as a marketplace
  // extension (`gemini-antigravity`). Their sidebar entries are contributed
  // dynamically once the extension is installed; the literal IDs are kept here
  // as a type-level allow-list so legacy code paths (SettingsView, urlState)
  // still type-check while routing through the registry.
  | 'antigravity-gemini'
  | 'antigravity-gemini-agent'
  // kimi-code and kimi-code-agent ship as the `kimi-code` marketplace
  // extension (Moonshot Kimi K2.6). Same dynamic-sidebar pattern as the
  // antigravity entries above; IDs listed for the type-level allow-list.
  | 'kimi-code'
  | 'kimi-code-agent'
  | 'notifications'
  | 'voice-mode'
  | 'sync'
  | 'themes'
  | 'advanced'
  | 'database'
  | 'agent-features'
  | 'beta-features'
  | 'mcp-servers'
  | 'installed-extensions'
  | 'privileged-extensions'
  | 'claude-plugins'
  | 'shared-links'
  | 'marketplace'
  | 'installed'
  | 'team'
  | 'org'
  | 'tracker-config'
  | 'github';

interface CategoryGroup {
  title: string;
  items: CategoryItem[];
  infoTooltip?: string;
}

interface CategoryItem {
  // Built-in panels use the strict SettingsCategory union. Extension-contributed
  // agent providers append entries keyed by their contribution id (a free
  // string), so the id is widened to accept those.
  id: SettingsCategory | string;
  name: string;
  icon: React.ReactNode;
  badge?: string | number;
  isAlpha?: boolean;
  statusDot?: 'success' | 'warning' | 'error';
  hidden?: boolean;
}

export type SettingsScope = 'user' | 'organization' | 'project';

interface SettingsSidebarProps {
  selectedCategory: SettingsCategory | string;
  onSelectCategory: (category: SettingsCategory | string) => void;
  providerStatus?: Record<string, { enabled: boolean; testStatus?: string }>;
  scope?: SettingsScope;
  /** Epic H3 P3: org picker for the Organization scope, hosted at the top of the
   *  sidebar so "which org am I editing" sits with the org admin nav. */
  orgChoices?: { orgId: string; name: string }[];
  selectedOrgId?: string | null;
  onSelectOrg?: (orgId: string) => void;
}

/**
 * Extension-contributed provider sidebar entries. Each entry pairs an
 * extension's AI-provider id (used as the sidebar category id and the
 * SettingsView panel switch key) with the metadata needed to render it
 * in the right sidebar group.
 */
interface ExtensionProviderSidebarEntry {
  id: string;
  label: string;
  icon: string | undefined;
  isAgent: boolean;
  isChat: boolean;
}

/**
 * Read extension-contributed AI providers from the extension loader and
 * subscribe to loader changes so the sidebar updates immediately when the
 * user installs, uninstalls, enables, or disables an extension. Returns an
 * empty list when the loader has not been initialized (e.g. on the very
 * first render before the extension system mounts).
 */
function useExtensionProviderSidebarEntries(): ExtensionProviderSidebarEntry[] {
  const [entries, setEntries] = useState<ExtensionProviderSidebarEntry[]>([]);

  useEffect(() => {
    const compute = () => {
      const loader = getExtensionLoader();
      if (!loader) {
        setEntries([]);
        return;
      }
      const next: ExtensionProviderSidebarEntry[] = loader.getAiProviders().map(({ contribution }) => ({
        id: contribution.id,
        label: contribution.label,
        icon: contribution.icon,
        isAgent: contribution.isAgent ?? false,
        isChat: contribution.isChat ?? false,
      }));
      setEntries(next);
    };

    compute();
    const loader = getExtensionLoader();
    return loader?.subscribe(compute);
  }, []);

  return entries;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  selectedCategory,
  onSelectCategory,
  providerStatus = {},
  scope = 'user',
  orgChoices = [],
  selectedOrgId = null,
  onSelectOrg,
}) => {
  // Database panel exposes the PGLite→SQLite migration. Hidden from non-dev
  // users until we finish internal testing with other devs.
  const developerMode = useAtomValue(developerModeAtom);
  // Alpha feature flags drive Collaboration group visibility only.
  // Per-feature panels (Voice Mode, OpenCode, Copilot, Agent Features) are always visible
  // so users can discover and enable them; the panels themselves gate their controls.
  const alphaFeatures = useAlphaFeatures(['collaboration']);
  const extensionProviders = useExtensionProviderSidebarEntries();
  const getStatusDot = (providerId: string): 'success' | 'warning' | 'error' | undefined => {
    const status = providerStatus[providerId];
    if (!status) return undefined;
    if (status.enabled && status.testStatus === 'success') return 'success';
    if (status.enabled && status.testStatus === 'error') return 'error';
    return undefined;
  };

  // Build dynamic sidebar items from extension-contributed providers, split
  // by whether the provider is an agent or a chat provider. Each item uses
  // the provider's icon when known and falls back to a smart-toy glyph. The
  // renderer extension loader surfaces both the agent (e.g.
  // antigravity-gemini-agent, kimi-code-agent) and chat (antigravity-gemini,
  // kimi-code, gemini-cli) contributions, so this single source covers what
  // the old main-process AgentProviderRegistry IPC list did and more.
  const extensionAgentItems: CategoryItem[] = extensionProviders
    .filter((entry) => entry.isAgent)
    .map((entry) => ({
      id: entry.id as SettingsCategory,
      name: entry.label,
      icon: <MaterialSymbol icon={entry.icon || 'smart_toy'} size={16} />,
      statusDot: getStatusDot(entry.id),
      isAlpha: true,
    }));
  const extensionChatItems: CategoryItem[] = extensionProviders
    .filter((entry) => entry.isChat)
    .map((entry) => ({
      id: entry.id as SettingsCategory,
      name: entry.label,
      icon: <MaterialSymbol icon={entry.icon || 'smart_toy'} size={16} />,
      statusDot: getStatusDot(entry.id),
    }));

  const categoryGroups: CategoryGroup[] = [
    {
      title: 'Application',
      items: [
        {
          id: 'sync',
          name: 'Account & Sync',
          icon: <MaterialSymbol icon="account_circle" size={16} />,
        },
        {
          id: 'shared-links',
          name: 'Shared Links',
          icon: <MaterialSymbol icon="link" size={16} />,
        },
        {
          id: 'notifications',
          name: 'Notifications',
          icon: <MaterialSymbol icon="notifications" size={16} />,
        },
        {
          id: 'themes',
          name: 'Themes',
          icon: <MaterialSymbol icon="palette" size={16} />,
        },
        {
          id: 'advanced',
          name: 'Advanced',
          icon: <MaterialSymbol icon="settings" size={16} />,
        },
        {
          id: 'database',
          name: 'Database',
          icon: <MaterialSymbol icon="database" size={16} />,
          isAlpha: true,
          hidden: !developerMode,
        },
        {
          id: 'voice-mode',
          name: 'Voice Mode',
          icon: <MaterialSymbol icon="mic" size={16} />,
          isAlpha: true,
        },
        {
          id: 'agent-features',
          name: 'Agent Features',
          icon: <MaterialSymbol icon="science" size={16} />,
          isAlpha: true,
        },

        {
          id: 'beta-features',
          name: 'Beta Features',
          icon: <MaterialSymbol icon="biotech" size={16} />,
          hidden: true,
        },
      ],
    },
    {
      title: 'Agent Providers',
      infoTooltip: `Agents run in loops against your files to produce work. 
      
The have full MCP support with file system access, multi-file operations, and session persistence.

Best for complex coding tasks.`,
      items: [
        {
          id: 'claude-code',
          name: 'Claude Agent',
          icon: getProviderIcon('claude-code', { size: 16 }),
          statusDot: getStatusDot('claude-code'),
        },
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: getProviderIcon('openai', { size: 16 }),
          statusDot: getStatusDot('openai-codex'),
        },
        {
          id: 'opencode',
          name: 'OpenCode',
          icon: getProviderIcon('opencode', { size: 16 }),
          statusDot: getStatusDot('opencode'),
          isAlpha: true,
        },
        {
          id: 'copilot-cli',
          name: 'GitHub Copilot',
          icon: <MaterialSymbol icon="terminal" size={16} />,
          statusDot: getStatusDot('copilot-cli'),
          isAlpha: true,
        },
        // Extension-contributed agent providers appear here once the user
        // installs the contributing extension (e.g. gemini-antigravity
        // contributes `antigravity-gemini-agent`). The list is empty by
        // default; the sidebar re-renders when the extension loader fires
        // a change event.
        ...extensionAgentItems,
      ],
    },
    {
      title: 'Chat Providers',
      infoTooltip: `Chat mode is a quicker, more focused tool that is limited to reading and writing your currently open file.

Uses direct API calls with files attached as context. Faster responses, simpler behavior. Includes local model support via LM Studio.

Best for quick edits and tasks that do not require multi-file operations.`,
      items: [
        {
          id: 'claude',
          name: 'Claude Chat',
          icon: getProviderIcon('claude', { size: 16 }),
          statusDot: getStatusDot('claude'),
        },
        {
          id: 'openai',
          name: 'OpenAI',
          icon: getProviderIcon('openai', { size: 16 }),
          statusDot: getStatusDot('openai'),
        },
        {
          id: 'lmstudio',
          name: 'LM Studio',
          icon: getProviderIcon('lmstudio', { size: 16 }),
          statusDot: getStatusDot('lmstudio'),
        },
        // Extension-contributed chat providers appear here once the user
        // installs the contributing extension (e.g. gemini-antigravity
        // contributes `antigravity-gemini`).
        ...extensionChatItems,
      ],
    },
    {
      title: 'Project',
      items: [
        {
          id: 'agent-permissions',
          name: 'Agent Permissions',
          icon: <MaterialSymbol icon="shield" size={16} />,
        },
        // Tracker config stays project-local. The Team panel stays reachable
        // here too because it hosts the workspace-centric setup flows (create
        // team / add this repo to an existing org / "which team does this
        // workspace sync to").
        {
          id: 'team' as SettingsCategory,
          name: 'Team',
          icon: <MaterialSymbol icon="group" size={16} />,
        },
        {
          id: 'tracker-config' as SettingsCategory,
          name: 'Trackers',
          icon: <MaterialSymbol icon="assignment" size={16} />,
        },
      ],
    },
    // Organization scope -- org admin (members, encryption, the project
    // registry, consolidation) lives here, keyed off the OrgSwitcher.
    {
      title: 'Organization',
      items: [
        {
          id: 'org' as SettingsCategory,
          name: 'Members & Roles',
          icon: <MaterialSymbol icon="corporate_fare" size={16} />,
        },
        {
          id: 'team' as SettingsCategory,
          name: 'Security & Projects',
          icon: <MaterialSymbol icon="group" size={16} />,
        },
      ],
    },
    {
      title: 'GitHub',
      items: [
        {
          id: 'github' as SettingsCategory,
          name: 'GitHub Account',
          icon: <MaterialSymbol icon="merge" size={16} />,
          hidden: !developerMode,
        },
      ],
    },
    {
      title: 'Extensions',
      items: [
        {
          id: 'marketplace',
          name: 'Marketplace',
          icon: <MaterialSymbol icon="storefront" size={16} />,
        },
        {
          id: 'installed-extensions',
          name: 'Installed',
          icon: <MaterialSymbol icon="extension" size={16} />,
        },
        {
          id: 'privileged-extensions',
          name: 'Privileged Capabilities',
          icon: <MaterialSymbol icon="shield_lock" size={16} />,
        },
        {
          id: 'claude-plugins',
          name: 'Claude Plugins',
          icon: <MaterialSymbol icon="widgets" size={16} />,
        },
        {
          id: 'mcp-servers',
          name: 'MCP Servers',
          icon: <MaterialSymbol icon="dns" size={16} />,
        },
      ],
    },
  ];

  // Filter groups based on scope (Epic H3 P3)
  // Organization scope: only the Organization group (org admin).
  // Project scope: Project group, Agent/Chat Providers (for overrides), GitHub, Extensions.
  // User scope: Agent/Chat Providers, Application, Extensions (not Project, not Organization).
  const filteredGroups = scope === 'organization'
    ? [categoryGroups.find(g => g.title === 'Organization')].filter((g): g is CategoryGroup => g != null)
    : scope === 'project'
      ? [
          categoryGroups.find(g => g.title === 'Project'),
          categoryGroups.find(g => g.title === 'Agent Providers'),
          categoryGroups.find(g => g.title === 'Chat Providers'),
          categoryGroups.find(g => g.title === 'GitHub'),
          categoryGroups.find(g => g.title === 'Extensions'),
        ].filter((g): g is CategoryGroup => g != null)
      : categoryGroups.filter(g => g.title !== 'Project' && g.title !== 'Organization');

  const [tooltip, setTooltip] = useState<{ text: string; top: number; left: number } | null>(null);

  const handleTooltipEnter = (event: React.MouseEvent<HTMLSpanElement>, text: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      text,
      top: rect.top + rect.height / 2,
      left: rect.right + 12,
    });
  };

  const handleTooltipLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="settings-sidebar w-[240px] shrink-0 border-r border-[var(--nim-border)] bg-[var(--nim-bg)] overflow-y-auto">
      <div className="settings-sidebar-content p-3">
        {/* Epic H3 P3: Organization picker — the org these settings apply to.
            Lives here (not in the global header) so it reads as part of the org
            admin surface, directly above Members & Roles / Security & Projects. */}
        {scope === 'organization' && orgChoices.length > 0 && (
          <div className="settings-sidebar-org-picker mb-4" data-testid="settings-org-picker">
            <label className="block px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-muted)]">
              Organization
            </label>
            <select
              value={selectedOrgId ?? ''}
              onChange={(e) => onSelectOrg?.(e.target.value)}
              className="settings-org-select w-full text-[13px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded-md px-2 py-1.5 text-[var(--nim-text)] cursor-pointer"
              title="Organization these settings apply to"
              data-testid="settings-org-select"
            >
              {orgChoices.map((o) => (
                <option key={o.orgId} value={o.orgId}>{o.name}</option>
              ))}
            </select>
          </div>
        )}
        {filteredGroups.map((group) => (
          <div key={group.title} className="settings-sidebar-group mb-4">
            <div className="settings-sidebar-group-title flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-muted)]">
              {group.title}
              {group.infoTooltip && (
                <span
                  className="settings-sidebar-group-info cursor-help text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)] transition-colors"
                  onMouseEnter={(event) => handleTooltipEnter(event, group.infoTooltip!)}
                  onMouseLeave={handleTooltipLeave}
                >
                  <MaterialSymbol icon="info" size={14} />
                </span>
              )}
            </div>
            {group.items
              .filter((item) => !item.hidden)
              .map((item) => (
                <div
                  key={item.id}
                  className={`settings-sidebar-item flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                    selectedCategory === item.id
                      ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-text)]'
                      : 'text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
                  }`}
                  onClick={() => onSelectCategory(item.id)}
                >
                  <span className="settings-sidebar-item-icon flex items-center justify-center w-5 h-5 shrink-0 text-[var(--nim-text-muted)]">{item.icon}</span>
                  <span className="settings-sidebar-item-name flex-1 truncate">{item.name}</span>
                  {item.isAlpha && <AlphaBadge size="xs" tooltip={SETTINGS_ALPHA_TOOLTIP} />}
                  {item.badge && (
                    <span className="settings-sidebar-item-badge text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
                      {item.badge}
                    </span>
                  )}
                  {item.statusDot && (
                    <span
                      className={`settings-sidebar-item-status w-2 h-2 rounded-full shrink-0 ${
                        item.statusDot === 'success'
                          ? 'bg-[var(--nim-success)]'
                          : item.statusDot === 'error'
                          ? 'bg-[var(--nim-error)]'
                          : 'bg-[var(--nim-warning)]'
                      }`}
                    />
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
      {tooltip &&
        createPortal(
          <div
            className="settings-sidebar-tooltip fixed z-[10000] max-w-[280px] px-3 py-2 bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded-lg shadow-lg text-sm text-[var(--nim-text)] whitespace-pre-wrap pointer-events-none transform -translate-y-1/2"
            style={{ top: `${tooltip.top}px`, left: `${tooltip.left}px` }}
          >
            {tooltip.text}
          </div>,
          document.body
        )}
    </div>
  );
};
