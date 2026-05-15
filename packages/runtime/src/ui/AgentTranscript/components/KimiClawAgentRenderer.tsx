/**
 * KimiClaw Agent Card -- Per-agent visual rendering (Fix C)
 *
 * KCS produces concurrent agent streams that mix chaotically in a flat
 * transcript. This component groups events by agentId and renders each
 * agent as a colour-coded collapsible card with phase badges and tier
 * indicators.
 *
 * Used by MessageSegment when provider === 'kimiclaw' and metadata
 * contains agent-scoped events.
 */

import React, { useState, useMemo } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

// ---------------------------------------------------------------------------
// Agent colour palette -- deterministic per-agent-id
// ---------------------------------------------------------------------------

const AGENT_COLORS = [
  { bg: 'rgba(59,130,246,0.08)',  border: '#3b82f6', badge: '#2563eb' },   // blue
  { bg: 'rgba(16,185,129,0.08)',  border: '#10b981', badge: '#059669' },   // green
  { bg: 'rgba(245,158,11,0.08)',  border: '#f59e0b', badge: '#d97706' },   // amber
  { bg: 'rgba(236,72,153,0.08)',  border: '#ec4899', badge: '#db2777' },   // pink
  { bg: 'rgba(139,92,246,0.08)',  border: '#8b5cf6', badge: '#7c3aed' },   // violet
  { bg: 'rgba(14,165,233,0.08)',  border: '#0ea5e9', badge: '#0284c7' },   // sky
  { bg: 'rgba(249,115,22,0.08)',  border: '#f97316', badge: '#ea580c' },   // orange
  { bg: 'rgba(20,184,166,0.08)',  border: '#14b8a6', badge: '#0d9488' },   // teal
];

function getAgentColor(agentId: string): typeof AGENT_COLORS[0] {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  const idx = Math.abs(hash) % AGENT_COLORS.length;
  return AGENT_COLORS[idx];
}

// ---------------------------------------------------------------------------
// Tier badge mapping
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Kimi',    color: '#3b82f6' },
  2: { label: 'Codex',   color: '#10b981' },
  3: { label: 'Claude',  color: '#f59e0b' },
  4: { label: 'QWQ',     color: '#8b5cf6' },
  5: { label: 'SYNTH',   color: '#ef4444' },
};

function TierBadge({ tier }: { tier?: number }) {
  if (!tier) return null;
  const t = TIER_LABELS[tier] || { label: `T${tier}`, color: '#6b7280' };
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ml-1.5"
      style={{ backgroundColor: t.color + '18', color: t.color }}
    >
      {t.label}
    </span>
  );
}

function SyntheticBadge({ used }: { used?: boolean }) {
  if (!used) return null;
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ml-1"
      style={{ backgroundColor: '#fee2e2', color: '#dc2626' }}
    >
      <MaterialSymbol icon="warning" size={10} className="mr-0.5" />
      SYNTH
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phase indicator
// ---------------------------------------------------------------------------

const PHASE_ICONS: Record<string, string> = {
  started:   'play_arrow',
  planning:  'psychology',
  executing: 'code',
  reflecting:'replay',
  done:      'check_circle',
};

function PhaseIndicator({ phase }: { phase?: string }) {
  if (!phase) return null;
  const icon = PHASE_ICONS[phase] || 'circle';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--nim-text-muted)] ml-2">
      <MaterialSymbol icon={icon} size={12} />
      {phase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Agent data model (aggregated from messages)
// ---------------------------------------------------------------------------

interface AgentData {
  agentId: string;
  name: string;
  role: string;
  tier?: number;
  phase?: string;
  synthetic?: boolean;
  messages: TranscriptViewMessage[];
  hasOutput: boolean;
}

function extractAgents(messages: TranscriptViewMessage[]): AgentData[] {
  const map = new Map<string, AgentData>();

  for (const msg of messages) {
    const meta = msg.metadata as Record<string, unknown> | undefined;
    const agentId = meta?.agentId as string | undefined;
    if (!agentId) continue;

    let agent = map.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        name: (meta?.agentName as string) || agentId.slice(0, 8),
        role: (meta?.agentRole as string) || '',
        tier: meta?.tier as number | undefined,
        phase: undefined,
        synthetic: false,
        messages: [],
        hasOutput: false,
      };
      map.set(agentId, agent);
    }

    // Update phase tracking
    if (meta?.phase) agent.phase = meta.phase as string;
    if (meta?.kind === 'agent_progress' && meta.phase) agent.phase = meta.phase as string;

    // Update tier
    if (meta?.tier) agent.tier = meta.tier as number;

    // Track synthetic
    if (meta?.synthetic === true || meta?.synthetic === 'true') agent.synthetic = true;

    // Track output
    if (meta?.kind === 'agent_output') agent.hasOutput = true;

    agent.messages.push(msg);
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Single agent card
// ---------------------------------------------------------------------------

function AgentCard({ agent }: { agent: AgentData }) {
  const [expanded, setExpanded] = useState(true);
  const colors = getAgentColor(agent.agentId);

  return (
    <div
      className="rounded-lg border mb-2 overflow-hidden"
      style={{
        backgroundColor: colors.bg,
        borderColor: agent.synthetic ? '#ef4444' : colors.border,
        borderWidth: agent.synthetic ? 2 : 1,
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
        onClick={() => setExpanded(!expanded)}
      >
        <MaterialSymbol
          icon={expanded ? 'expand_more' : 'chevron_right'}
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="font-semibold text-sm text-[var(--nim-text)]">
          {agent.name || `Agent ${agent.agentId.slice(0, 8)}`}
        </span>
        {agent.role && (
          <span className="text-xs text-[var(--nim-text-muted)]">({agent.role})</span>
        )}
        <TierBadge tier={agent.tier} />
        <SyntheticBadge used={agent.synthetic} />
        <PhaseIndicator phase={agent.phase} />
        <span className="ml-auto text-[11px] text-[var(--nim-text-muted)]">
          {agent.messages.length} event{agent.messages.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-3">
          {agent.messages.map((msg, idx) => (
            <div key={idx} className="mt-2">
              <AgentMessageContent message={msg} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent message content (simplified transcript rendering)
// ---------------------------------------------------------------------------

function AgentMessageContent({ message }: { message: TranscriptViewMessage }) {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const kind = meta?.kind as string | undefined;

  // Progress placeholders
  if (kind === 'agent_progress') {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--nim-text-muted)] italic">
        <MaterialSymbol icon="pending" size={12} className="animate-spin" />
        {message.content}
      </div>
    );
  }

  // Agent output (full blob)
  if (kind === 'agent_output') {
    return (
      <div className="rounded bg-[var(--nim-bg-secondary)] p-2 text-sm">
        <MarkdownRenderer content={message.content || ''} />
      </div>
    );
  }

  // Context stitch notification
  if (kind === 'context_stitch') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--nim-text-muted)] italic py-1">
        <MaterialSymbol icon="link" size={12} />
        {message.content}
      </div>
    );
  }

  // Cancel notification
  if (kind === 'cancel') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[#dc2626] py-1">
        <MaterialSymbol icon="stop_circle" size={12} />
        {message.content}
      </div>
    );
  }

  // Default: plain text
  return (
    <div className="text-sm text-[var(--nim-text)] whitespace-pre-wrap">
      {message.content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

interface KimiClawAgentRendererProps {
  messages: TranscriptViewMessage[];
  /** Called when an agent card is expanded/collapsed */
  onAgentToggle?: (agentId: string, expanded: boolean) => void;
}

export const KimiClawAgentRenderer: React.FC<KimiClawAgentRendererProps> = ({
  messages,
}) => {
  const agents = useMemo(() => extractAgents(messages), [messages]);

  if (agents.length === 0) {
    return (
      <div className="text-sm text-[var(--nim-text-muted)] italic">
        No agent events recorded.
      </div>
    );
  }

  return (
    <div className="kimiclaw-agent-renderer">
      {agents.map((agent) => (
        <AgentCard key={agent.agentId} agent={agent} />
      ))}
    </div>
  );
};

export default KimiClawAgentRenderer;
