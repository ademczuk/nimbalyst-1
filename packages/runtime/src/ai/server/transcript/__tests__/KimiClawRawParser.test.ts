/**
 * Contract tests for KimiClawRawParser.
 *
 * 2026-05-21 regression: the user's prompt (direction='input') is logged
 * as plain text, not a KCS JSON envelope. The parser used to JSON.parse
 * every message and return [] on failure, so the prompt was dropped from
 * the rendered transcript ("should be up top" but vanished). These tests
 * lock in that input direction now produces a user_message descriptor,
 * while KCS event envelopes still parse as before.
 */

import { describe, it, expect } from 'vitest';
import { KimiClawRawParser } from '../parsers/KimiClawRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'kimiclaw',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ParseContext>): ParseContext {
  return {
    sessionId: SESSION_ID,
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
    ...overrides,
  };
}

describe('KimiClawRawParser', () => {
  describe('input messages (regression: prompt was dropped)', () => {
    it('emits a user_message for plain-text input', async () => {
      const parser = new KimiClawRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Evaluate Cloudflare D1 for a B2B CRM.',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Evaluate Cloudflare D1 for a B2B CRM.',
      });
    });

    it('tolerates a JSON-wrapped { prompt } input', async () => {
      const parser = new KimiClawRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: JSON.stringify({ prompt: 'wrapped prompt' }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'wrapped prompt',
      });
    });

    it('drops empty input (no blank user bubble)', async () => {
      const parser = new KimiClawRawParser();
      const msg = makeRawMessage({ direction: 'input', content: '   ' });
      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('output events still parse', () => {
    it('parses a swarm.created envelope (data-wrapped master shape)', async () => {
      const parser = new KimiClawRawParser();
      const msg = makeRawMessage({
        direction: 'output',
        content: JSON.stringify({
          type: 'swarm.created',
          data: {
            type: 'swarm.created',
            swarm_id: 'swarm_abc',
            payload: { swarm_id: 'swarm_abc', task: 'do the thing' },
            seq: 1,
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      // swarm.created produces at least one descriptor (the start banner).
      expect(descriptors.length).toBeGreaterThanOrEqual(1);
    });

    it('returns [] for an unparseable non-input message (raw log preserved)', async () => {
      const parser = new KimiClawRawParser();
      const msg = makeRawMessage({ direction: 'output', content: 'not json' });
      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });
});
