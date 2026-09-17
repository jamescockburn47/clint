import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReply } from '../src/slack/format-reply.js';
import { replyPayload } from '../src/slack/policy.js';
import { getSystemPrompt } from '../src/prompt.js';
import { createConversationContext, withConversationContext } from '../src/conversation-context.js';

const textOf = node => typeof node.text === 'string' ? node.text :
  (node.elements || node.rows || []).flat().map(textOf).join('');

test('Slack renders headings, emphasis, lists, quotations and code as native typed elements', () => {
  const result = formatReply('## Recommendation\n\nUse **Option A**.\n\n- Fast\n- Simple\n\n3. Deploy\n\n> Quoted evidence\n\n```js\nconst x = "<!channel>";\n```');
  const elements = result.flatMap(block => block.elements);
  assert.equal(elements[0].elements[0].style.bold, true);
  assert.ok(elements.some(item => item.type === 'rich_text_list' && item.style === 'bullet'));
  assert.ok(elements.some(item => item.type === 'rich_text_list' && item.offset === 2));
  assert.ok(elements.some(item => item.type === 'rich_text_quote'));
  assert.equal(elements.find(item => item.type === 'rich_text_preformatted').elements[0].text, 'const x = "<!channel>";');
  assert.match(result.map(textOf).join(''), /Use Option A/);
});

test('comparison values, order and alignment survive a native table; extra tables remain complete', () => {
  const source = '| Option | Rate |\n| --- | ---: |\n| A | 26.93 |\n| B | unknown |';
  const result = formatReply('Before\n\n' + source + '\n\nAfter\n\n' + source);
  const table = result.find(block => block.type === 'table');
  assert.deepEqual(table.rows.map(row => row.map(textOf)), [['Option', 'Rate'], ['A', '26.93'], ['B', 'unknown']]);
  assert.equal(table.column_settings[1].align, 'right');
  assert.equal(result.filter(block => block.type === 'table').length, 1);
  assert.ok(result.some(block => block.elements?.some(item => item.type === 'rich_text_preformatted' && textOf(item) === source)));
  assert.ok(result.map(textOf).join('').startsWith('Before'));
});

test('malformed tables, literal JSON and mention strings are never executed or dropped', () => {
  for (const source of ['{"blocks":[{"type":"image","image_url":"https://example.com"}]}',
    '<!channel> <@U123> @here <https://example.com|fake>',
    '| A | B |\n| --- | --- |\n| three | broken | cells |']) {
    const result = formatReply(source);
    assert.equal(result.map(textOf).join(''), source);
    assert.ok(result.every(block => block.type === 'rich_text'));
    assert.ok(!JSON.stringify(result).includes('"type":"user"'));
  }
  const linked = formatReply('[Source](https://example.com/report) [unsafe](javascript:alert)');
  assert.equal(linked[0].elements[0].elements[0].type, 'link');
  assert.equal(linked[0].elements[0].elements[0].url, 'https://example.com/report');
  const payload = replyPayload({ channel: 'C1' }, '<!here>');
  assert.equal(payload.unfurl_links, false); assert.equal(payload.parse, 'none');
});

test('table aggregate limits fall back intact and unsupported code fences retain their content', () => {
  const table = size => '| A | B |\n| --- | --- |\n' + Array.from({ length: 5 }, (_, index) =>
    '| ' + 'x'.repeat(999) + ' | ' + 'y'.repeat(index === 4 ? size - 8993 : 999) + ' |').join('\n');
  assert.equal(formatReply(table(10000))[0].type, 'table');
  const over = table(10001), result = formatReply(over);
  assert.ok(result.every(block => block.type !== 'table'));
  assert.equal(result.map(textOf).join(''), over);
  for (const source of ['```const answer = 42;```', '```js\nconst answer = 42;', '```unknown syntax\nvalue']) {
    assert.equal(formatReply(source).map(textOf).join(''), source);
  }
});

test('32K long replies, pathological paragraphs and Unicode remain complete within transport limits', () => {
  for (const source of ['x'.repeat(2499) + '😀' + 'y'.repeat(29499), 'x\n'.repeat(16000)]) {
    const result = formatReply(source);
    assert.equal(result.map(textOf).join(''), source);
    assert.ok(result.length <= 50);
  }
});

test('presentation is a Slack-only system instruction, preserving natural short replies', () => {
  const scope = createConversationContext({ transport: 'slack', conversationId: 'slack:T1:C1',
    actorId: 'U1', ownerId: 'U1', audience: 'group', policy: { mode: 'open' }, localOnly: true, readOnly: true });
  const prompt = withConversationContext(scope, () => getSystemPrompt('professional', true, true));
  assert.match(prompt, /Slack answer presentation/);
  assert.match(prompt, /not a JSON wrapper/);
  assert.match(prompt, /greeting gets one sentence/);
  assert.doesNotMatch(getSystemPrompt('professional', true, false), /Slack answer presentation/);
});
