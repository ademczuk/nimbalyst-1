# KimiClaw Provider Integration

KimiClawSwarm (KCS) is a local multi-agent orchestration engine. This fork adds
KCS as a first-class agent provider in Nimbalyst via HTTP+SSE on `127.0.0.1:9643`.

## What works (v1)

- **HTTP+SSE transport** -- Cookie or Bearer auth against local Flask server
- **Conversational continuity** (Fix A) -- prior swarm deliverables auto-stitched
  into new task descriptions via `[Prior context]\n\n---\n\nNew task: ...`
- **Agent progress placeholders** (Fix B) -- `agent.started`, `phase_changed`, and
  `completed` events render as visible lifecycle placeholders so the UI isn't a
  blank spinner while agents work
- **Per-agent visual rendering** (Fix C) -- `KimiClawAgentRenderer` groups
  events by `agentId` into colour-coded collapsible cards with tier badges,
  phase indicators, and `[SYNTH]` warnings for tier-5 fallback agents
- **Cancel UX gate** -- post-cancel stragglers are dropped; user sees
  "[Swarm cancelled by user]" cleanly
- **MCP passthrough scaffold** (Fix D) -- `McpConfigService` collects the user's
  MCP servers and injects them into the swarm dispatch body. **Requires KCS-side
  support** for `mcp_servers` field in `POST /api/v2/swarm`.

## Known limitations (honest)

1. **Streaming is event-driven, not token-driven.** KCS emits full agent output
   blobs on `agent.completed` -- you see progress placeholders then a wall of
   text, not smooth token-by-token streaming like Claude/Codex. This is an
   architectural constraint of KCS, not fixable on the nimbalyst side alone.

2. **MCP passthrough needs KCS-side work.** The nimbalyst side sends
   `mcp_servers` in the swarm body, but KCS must be updated to read and merge
   them into per-agent MCP config. Without this, KCS sub-agents run in their
   own MCP walled garden.

3. **Step budget ≠ token budget.** KCS uses step-based budgeting. Nimbalyst's
   token telemetry widgets show step counts aliased to token slots. A step-budget
   widget is planned but not yet built.

4. **SSE in Electron.** Uses `fetch` with `getReader()` in the main process.
   `node-fetch` would be more battle-tested but `fetch` is adequate for local
   loopback. If you see SSE streams dying after ~60s during long agent calls,
   switch to `node-fetch` + `tough-cookie`.

5. **Engine restart = in-flight swarm loss.** `docker compose restart kimiclaw-web`
   kills all running threads. Postgres-persisted swarm records survive but show
   as orphaned `running` state until the reaper job lands (KCS-side fix needed).

6. **No `api/v2/models` endpoint.** `getModels()` returns a static preset.
   When KCS adds model discovery, swap to fetch-and-cache.

## 30-min hello-world (actually ~2 hours)

```bash
# 1. Start KCS
cd /your/kimiclaw/repo && docker compose up -d

# 2. Verify it's alive
curl -s http://127.0.0.1:9643/api/auth-check  # should return 401 (alive, unauthenticated)

# 3. Open Nimbalyst Settings → Agent Providers → KimiClaw
#    Set endpoint: http://127.0.0.1:9643
#    Auth: Cookie, username: admin, password: admin
#    Click Health Check → should show green

# 4. Create a session with KimiClaw provider
# 5. Send: "Say hello in one word"
# 6. Watch agent cards appear in the Agent Activity section
```

## Files added/modified

| File | Action |
|---|---|
| `types.ts` | Add `'kimiclaw'` to types |
| `ProviderFactory.ts` | Add `case 'kimiclaw'` |
| `protocols/index.ts` | Export `KimiClawProtocol` |
| `server/index.ts` | Export `KimiClawProvider` |
| `protocols/KimiClawProtocol.ts` | **NEW** -- Transport, SSE parser, event mapping, context stitch, cancel gate, MCP passthrough |
| `providers/KimiClawProvider.ts` | **NEW** -- Provider, session management, MCP collection |
| `ui/icons/ProviderIcons.tsx` | Add `'kimiclaw': 'hive'` |
| `ui/AgentTranscript/components/KimiClawAgentRenderer.tsx` | **NEW** -- Per-agent visual cards (Fix C) |
| `ui/AgentTranscript/components/RichTranscriptView.tsx` | Integrate agent renderer |
| `ui/AgentTranscript/components/index.ts` | Export agent renderer |
| `SettingsSidebar.tsx` | Add `'kimiclaw'` category |
| `SettingsView.tsx` | Import + render `KimiClawPanel` |
| `appSettings.ts` | Add `kimiclaw` defaults |
| `panels/KimiClawPanel.tsx` | **NEW** -- Settings panel |

## Architecture

```
User Message
  → KimiClawProvider.sendMessage()
    → KimiClawProtocol.createSession() [with prior deliverable for continuity]
      → KimiClawHttpTransport.dispatchSwarm() [POST /api/v2/swarm + MCP servers]
        → KCS engine runs swarm
      → KimiClawHttpTransport.streamEvents() [SSE]
        → parseSwarmEvent() [~30 event types → canonical ProtocolEvents]
        → AgentProtocolTranscriptAdapter.processEvent() → StreamChunks
      → RichTranscriptView renders both flat + agent-grouped views
    → KimiClawProtocol stores deliverable for next turn's context stitch
```
