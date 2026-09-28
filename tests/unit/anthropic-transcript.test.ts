import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAnthropicRequestParams,
  resolveHostTranscriptHelpers,
  streamAnthropicViaBetaMessages,
  type PiStreamContext,
  type PiSystemMessage,
} from '../../src/core/anthropic-attribution.js';

const model = { provider: 'anthropic', id: 'claude-haiku-4-5', maxTokens: 8192 };
const tool = { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } };
const system: PiSystemMessage = {
  role: 'system',
  content: 'base',
  sections: { policy: 'patched' },
  toolsAdded: [tool],
  timestamp: 1,
};
const user = { role: 'user', content: 'hello' } as const;
const expectedPrompt = 'base\n\npatched';

function dependencies(observe?: (messages: readonly { readonly role: string }[]) => void) {
  return {
    hostTranscriptHelpers: resolveHostTranscriptHelpers({
      getCurrentSystemPrompt(messages: readonly { readonly role: string }[]) {
        observe?.(messages);
        return expectedPrompt;
      },
      getCurrentTools() {
        return [tool];
      },
    }),
  };
}

void describe('Anthropic legacy/transcript boundary (#27)', () => {
  void it('retains legacy Context bytes without requiring newer host helpers', () => {
    assert.equal(resolveHostTranscriptHelpers({}), undefined);
    const context = { systemPrompt: expectedPrompt, tools: [tool], messages: [user] };
    assert.deepEqual(
      buildAnthropicRequestParams(model, context),
      buildAnthropicRequestParams(model, context, undefined, {
        hostTranscriptHelpers: {
          getCurrentSystemPrompt() {
            throw new Error('must not replay legacy input');
          },
          getCurrentTools() {
            throw new Error('must not replay legacy input');
          },
        },
      }),
    );
  });

  void it('uses the host replay and filters only prompt state without mutating its input', () => {
    const context = { messages: [system, user, { ...system, toolsRemoved: [{ name: 'write' }] }] };
    const before = structuredClone(context);
    let calls = 0;
    const actual = buildAnthropicRequestParams(
      model,
      context,
      undefined,
      dependencies((messages) => {
        calls += 1;
        assert.strictEqual(messages, context.messages);
      }),
    );
    assert.deepEqual(
      actual,
      buildAnthropicRequestParams(model, {
        systemPrompt: expectedPrompt,
        tools: [tool],
        messages: [user],
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(context, before);
  });

  void it('replays hybrid legacy bases before transcript deltas, including explicit empty bases', () => {
    for (const base of ['', 'legacy base']) {
      buildAnthropicRequestParams(
        model,
        {
          systemPrompt: base,
          tools: [],
          messages: [system, user],
        },
        undefined,
        dependencies((messages) => {
          assert.deepEqual(messages, [
            { role: 'system', content: base, toolsAdded: [], timestamp: 0 },
            system,
            user,
          ]);
        }),
      );
    }
  });

  void it('refuses system transcripts without helpers instead of silently sending an empty prompt', () => {
    assert.throws(
      () => buildAnthropicRequestParams(model, { messages: [system, user] }),
      /system messages require gateway-injected Pi transcript helpers/u,
    );
    assert.throws(
      () => resolveHostTranscriptHelpers({ getCurrentSystemPrompt: () => '' }),
      /both getCurrentSystemPrompt and getCurrentTools/u,
    );
  });

  void it('rejects malformed helper results rather than defaulting them to empty', () => {
    for (const result of [undefined, null, 42]) {
      const hostTranscriptHelpers = resolveHostTranscriptHelpers({
        getCurrentSystemPrompt: () => result,
        getCurrentTools: () => [],
      });
      assert.throws(
        () =>
          buildAnthropicRequestParams(model, { messages: [system, user] }, undefined, {
            hostTranscriptHelpers,
          }),
        /invalid system prompt/u,
      );
    }
    for (const result of [undefined, {}, [null], [{ name: 1 }], [{ name: 'x', parameters: [] }]]) {
      const hostTranscriptHelpers = resolveHostTranscriptHelpers({
        getCurrentSystemPrompt: () => '',
        getCurrentTools: () => result,
      });
      assert.throws(
        () =>
          buildAnthropicRequestParams(model, { messages: [system, user] }, undefined, {
            hostTranscriptHelpers,
          }),
        /invalid tool declarations/u,
      );
    }
  });

  void it('rejects malformed system content, sections, and tool deltas before invoking helpers', () => {
    for (const patch of [
      { timestamp: undefined },
      { timestamp: NaN },
      { content: null },
      { content: [{ type: 'image', data: 'not-prompt-text' }] },
      { sections: [] },
      { sections: { bad: 2 } },
      { toolsAdded: {} },
      { toolsAdded: [{ name: null }] },
      { toolsRemoved: {} },
      { toolsRemoved: [{ name: '' }] },
    ]) {
      const context: unknown = { messages: [{ ...system, ...patch }, user] };
      assert.throws(
        () =>
          buildAnthropicRequestParams(
            model,
            context as PiStreamContext,
            undefined,
            dependencies(() => assert.fail('malformed system state reached host replay')),
          ),
        /pi_anthropic_attribution_transcript_unsupported/u,
      );
    }
  });

  void it('preserves tool-result grouping across a system update', () => {
    const messages: PiStreamContext['messages'] = [
      user,
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
          { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} },
        ],
      },
      { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'one' }] },
      system,
      { role: 'toolResult', toolCallId: 'call-2', content: [{ type: 'text', text: 'two' }] },
    ];
    assert.deepEqual(
      buildAnthropicRequestParams(model, { messages }, undefined, dependencies()),
      buildAnthropicRequestParams(model, {
        systemPrompt: expectedPrompt,
        tools: [tool],
        messages: messages.filter((message) => message.role !== 'system'),
      }),
    );
  });

  void it('settles malformed transcript transport as an error before network or middleware', async (t) => {
    t.mock.method(globalThis, 'fetch', () =>
      assert.fail('invalid transcript must not reach fetch'),
    );
    const result = await streamAnthropicViaBetaMessages(
      model,
      { messages: [system, user] },
      {
        apiKey: 'sk-ant-oat-offline',
        sessionId: 'transcript-refusal',
        onPayload: () => assert.fail('invalid transcript must not reach middleware'),
      },
      { loadAccount: () => ({ deviceId: 'offline-device', accountUuid: 'offline-account' }) },
    ).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /transcript_unsupported/u);
    assert.equal(
      result.diagnostics?.some((d) => d.type === 'anthropic-cache-lineage') ?? false,
      false,
    );
  });
});
