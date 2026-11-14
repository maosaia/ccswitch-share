'use strict';

// Reads token usage from Anthropic and OpenAI response shapes.
// Streaming repeats totals across events, so per field we keep the max, not the sum.
function toInt(n) {
  return Number.isFinite(n) ? n : 0;
}

function readUsage(obj) {
  const u = obj && (obj.usage || (obj.response && obj.response.usage) || (obj.message && obj.message.usage));
  if (!u || typeof u !== 'object') return null;
  const input =
    toInt(u.input_tokens ?? u.prompt_tokens) +
    toInt(u.cache_creation_input_tokens) +
    toInt(u.cache_read_input_tokens);
  const output = toInt(u.output_tokens ?? u.completion_tokens);
  return input || output ? { input, output } : null;
}

// Works for a plain JSON body and for an SSE body (Anthropic messages, OpenAI chunks, Responses events).
function meterFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return readUsage(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  let input = 0;
  let output = 0;
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      continue;
    }
    const u = readUsage(obj);
    if (!u) continue;
    input = Math.max(input, u.input);
    output = Math.max(output, u.output);
  }
  return input || output ? { input, output } : null;
}

module.exports = { meterFromText, readUsage };
