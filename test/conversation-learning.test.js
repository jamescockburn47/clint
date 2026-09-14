import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logIncomingConversation } from '../src/conversation-logger.js';
import { readSourceLine, groundCandidate } from '../src/overnight/grounded-memory.ts';
import { ownerStyleRequest } from '../src/overnight/report-style.ts';

test('transport bot echo stays ineligible for grounded memory', () => {
  let recorded;
  logIncomingConversation({ key: { id: 'echo', fromMe: true } },
    { chatJid: 'group@g.us', senderName: 'Clint', senderJid: 'bot', text: 'James approved a transfer.' },
    (_, rows) => { recorded = rows[0]; });
  const source = readSourceLine(JSON.stringify(recorded), 'fixture.jsonl', 1);
  assert.throws(() => groundCandidate({ message_id: source.id, category: 'general' }, [source]), /assistant_statement/);
});
test('owner direct message reaches deterministic report preference policy', () => {
  let recorded;
  logIncomingConversation({ key: { id: 'owner-message', fromMe: false } },
    { chatJid: 'owner', senderName: 'Owner', senderJid: 'owner', text: '/report-style compact' },
    (_, rows) => { recorded = rows[0]; });
  assert.deepEqual(ownerStyleRequest(recorded, ['owner']), { version: 1, layout: 'compact' });
  assert.equal(ownerStyleRequest({ ...recorded, senderJid: 'stranger' }, ['owner']), null);
});
