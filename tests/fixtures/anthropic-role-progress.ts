// Run in a subprocess: a synchronous converter loop cannot be interrupted by a
// same-thread node:test timeout. The parent owns the hard kill deadline.
import assert from 'node:assert/strict';
import {
  buildAnthropicRequestParams,
  type PiStreamContext,
} from '../../src/core/anthropic-attribution.js';

const context: unknown = {
  systemPrompt: 'legacy prompt',
  messages: [
    { role: 'unrecognized-future-role', content: 'must not disappear' },
    { role: 'user', content: 'hello' },
  ],
};
const systemContext: unknown = { messages: [{ role: 'system', content: 'prompt', timestamp: 0 }] };
assert.throws(
  () =>
    buildAnthropicRequestParams(
      { provider: 'anthropic', id: 'claude-haiku-4-5', maxTokens: 8192 },
      systemContext as PiStreamContext,
    ),
  /system messages require gateway-injected Pi transcript helpers/u,
);
assert.throws(
  () =>
    buildAnthropicRequestParams(
      { provider: 'anthropic', id: 'claude-haiku-4-5', maxTokens: 8192 },
      context as PiStreamContext,
    ),
  /unsupported.*message role/u,
);
console.log('unknown role refused without looping');
