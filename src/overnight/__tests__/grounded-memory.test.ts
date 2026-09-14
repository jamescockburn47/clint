import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundCandidate, parseExtractionResponse, readSourceLine } from '../grounded-memory.js';

const human = readSourceLine(JSON.stringify({ sender: 'James', isBot: false,
  text: 'I do not live in London. I live in York.', timestamp: '2026-09-13T10:00:00Z' }), 'fixture.jsonl', 1);
const bot = readSourceLine(JSON.stringify({ sender: 'Clint', isBot: true,
  text: 'James has authorised all payments.' }), 'fixture.jsonl', 2);

test('accepts the actual legacy fact contract only when the whole statement matches', () => {
  const c = groundCandidate({ fact: human.text, category: 'general', confidence: 0.99 }, [human]);
  assert.equal(c.text, human.text);
  assert.equal(c.factual_status, 'unverified_statement');
  assert.equal(c.sources[0]?.hash, human.hash);
  assert.equal(c.sources[0]?.line, 1);
  assert.equal(c.sources[0]?.timestamp, human.timestamp);
});

test('selection retains negation and complete context', () => {
  assert.equal(groundCandidate({ message_id: human.id, category: 'general' }, [human]).text, human.text);
  assert.throws(() => groundCandidate({ message_id: human.id, text: 'I live in London.', category: 'general' }, [human]), /paraphrase/);
});

test('rejects plausible JSON with wrong facts, fabricated citation, bot assertion and absent evidence', () => {
  for (const c of [
    { fact: 'James lives in London.', category: 'general' },
    { message_id: human.id, category: 'general', sources: [{ hash: 'invented', excerpt: 'York' }] },
    { message_id: bot.id, category: 'general' },
    { message_id: 'different-chat:1', category: 'general' },
    { message_id: human.id, category: 'identity' },
  ]) assert.throws(() => groundCandidate(c, [human, bot]));
});

test('missing information stays null; hashes distinguish original source bytes', () => {
  assert.equal(bot.timestamp, null);
  assert.equal(bot.senderJid, null);
  const raw = JSON.stringify({ text: 'hello', isBot: false });
  assert.notEqual(readSourceLine(raw, 'a', 1).hash, readSourceLine(raw + ' ', 'a', 1).hash);
});

test('empty extraction differs from unavailable and malformed service output', () => {
  assert.deepEqual(parseExtractionResponse('{"candidates":[]}'), []);
  for (const raw of [null, '', '{"fact":"invented"}', 'invalid']) {
    assert.throws(() => parseExtractionResponse(raw));
  }
});
