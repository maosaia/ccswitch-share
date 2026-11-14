'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { meterFromText, readUsage } = require('./usage');

test('anthropic non-stream usage', () => {
  const body = JSON.stringify({
    id: 'msg_1',
    usage: { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 40 },
  });
  assert.deepEqual(meterFromText(body), { input: 20, output: 40 });
});

test('anthropic stream usage keeps max across events', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":57}}',
    '',
  ].join('\n');
  assert.deepEqual(meterFromText(sse), { input: 11, output: 57 });
});

test('openai chat non-stream usage', () => {
  const body = JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 21, total_tokens: 30 } });
  assert.deepEqual(meterFromText(body), { input: 9, output: 21 });
});

test('openai chat stream final chunk usage', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepEqual(meterFromText(sse), { input: 7, output: 3 });
});

test('openai responses completed event', () => {
  const sse = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":250}}}',
    '',
  ].join('\n');
  assert.deepEqual(meterFromText(sse), { input: 100, output: 250 });
});

test('unknown shapes return null', () => {
  assert.equal(readUsage({ choices: [] }), null);
  assert.equal(meterFromText('not json'), null);
});
