import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { snapshotParentConversation } from '../../src/core/context/parent-snapshot.js';
import { buildDelegateSeed } from '../../src/core/delegate/seed.js';
import { buildFusionCanonicalInput } from '../../src/core/fusion/context.js';
import { projectVisibleConversationV2 } from '../../src/core/context/visible-conversation-v2.js';
import { assistantMessage, userMessage } from '../helpers/fusion-canonical.js';

function parent() {
  const sessionManager = SessionManager.inMemory('/tmp/project');
  // The locked 0.84 declarations predate system messages. The 0.86 packed-host
  // fixture below exercises the same records through the actual newer SDK.
  const initial: unknown = {
    role: 'system',
    content: 'HISTORICAL_SYSTEM',
    timestamp: 1,
    toolsAdded: [{ name: 'HISTORICAL_TOOL', parameters: { type: 'object' } }],
  };
  sessionManager.appendMessage(initial as Parameters<SessionManager['appendMessage']>[0]);
  sessionManager.appendMessage(userMessage('VISIBLE_USER'));
  const later: unknown = {
    role: 'system',
    content: '',
    sections: { policy: 'HISTORICAL_PATCH' },
    timestamp: 2,
  };
  sessionManager.appendMessage(later as Parameters<SessionManager['appendMessage']>[0]);
  const leaf = sessionManager.appendMessage(
    assistantMessage([
      {
        type: 'toolCall',
        id: 'active',
        name: 'bg_delegate',
        arguments: { prompt: 'ACTIVE_ARGUMENT' },
      },
      {
        type: 'toolCall',
        id: 'sibling',
        name: 'fusion_reason',
        arguments: { prompt: 'SIBLING_ARGUMENT' },
      },
    ]),
  );
  let reads = 0;
  return {
    ctx: {
      cwd: '/tmp/project',
      sessionManager,
      getSystemPrompt() {
        reads += 1;
        return `CURRENT_PROMPT_${reads}`;
      },
    },
    reads: () => reads,
    leaf,
  };
}

void describe('parent transcript prompt-state boundary', () => {
  void it('captures effective prompt once and filters system state before conversation projection', () => {
    const h = parent();
    const snapshot = snapshotParentConversation(h.ctx, {
      toolCallId: 'active',
      toolName: 'bg_delegate',
      excludeActiveToolCallLeaf: true,
    });
    assert.equal(snapshot.systemPrompt, 'CURRENT_PROMPT_1');
    assert.equal(h.reads(), 1);
    assert.equal(snapshot.activeToolCallLeafExcluded, true);
    assert.notEqual(snapshot.leafId, h.leaf);
    assert.deepEqual(
      snapshot.messages.map((message) => message.role),
      ['user'],
    );
    const projection = projectVisibleConversationV2(snapshot.messages);
    assert.equal(projection.accounting.message_count, 1);
    assert.equal(projection.entries[0]?.kind, 'text');
    assert.doesNotMatch(JSON.stringify(projection), /HISTORICAL|ACTIVE_ARGUMENT|SIBLING_ARGUMENT/u);
  });

  void it('keeps the effective prompt in the delegate envelope, never historical tool/prompt state', () => {
    const h = parent();
    const built = buildDelegateSeed(h.ctx, {
      taskId: 'd0123456789abcdef0123456789abcdef',
      launchNonce: 'a'.repeat(32),
      toolCallId: 'active',
      directive: 'inspect',
      capability: 'inspect',
      extensionMode: 'isolated',
      route: {
        provider: 'fixture',
        model: 'fixture',
        qualified_id: 'fixture/fixture',
        context_window_tokens: 200_000,
        thinking_level: 'low',
        origin: 'parent_current',
      },
      limits: {
        max_turns: 24,
        max_tool_calls: 120,
        timeout_seconds: 900,
        max_tool_result_bytes: 65_536,
        max_total_tool_output_bytes: 67_108_864,
        max_answer_bytes: 4_194_304,
        allowed_input_tokens: 171_712,
      },
    });
    assert.equal(h.reads(), 1);
    assert.equal(built.seed.parent_system_prompt, 'CURRENT_PROMPT_1');
    assert.match(built.serialized, /VISIBLE_USER/u);
    assert.doesNotMatch(built.serialized, /HISTORICAL|ACTIVE_ARGUMENT|SIBLING_ARGUMENT/u);
  });

  void it('uses the same frozen effective prompt for both Fusion compatibility envelopes', () => {
    const h = parent();
    const built = buildFusionCanonicalInput(h.ctx, {
      source: 'tool',
      request: 'reason',
      toolCallId: 'active',
    });
    assert.equal(h.reads(), 1);
    assert.equal(built.input.system_prompt, 'CURRENT_PROMPT_1');
    assert.ok(built.input.context);
    assert.equal(built.input.context.system_prompt, 'CURRENT_PROMPT_1');
    assert.match(built.serialized, /VISIBLE_USER/u);
    assert.doesNotMatch(built.serialized, /HISTORICAL|ACTIVE_ARGUMENT|SIBLING_ARGUMENT/u);
  });

  void it('rejects unknown host roles before Pi can silently discard them during conversion', () => {
    const h = parent();
    const message: unknown = { role: 'future-role', content: 'must not disappear', timestamp: 3 };
    h.ctx.sessionManager.appendMessage(message as Parameters<SessionManager['appendMessage']>[0]);
    assert.throws(
      () =>
        snapshotParentConversation(h.ctx, {
          toolName: 'bg_delegate',
          excludeActiveToolCallLeaf: false,
        }),
      /unsupported conversation block: message role future-role/u,
    );
  });

  void it('does not weaken the frozen transform to silently drop system or unknown roles', () => {
    for (const role of ['system', 'future-role']) {
      const messages: unknown = [{ role, content: 'not conversation' }];
      assert.throws(
        () =>
          projectVisibleConversationV2(
            messages as Parameters<typeof projectVisibleConversationV2>[0],
          ),
        /unsupported conversation block/u,
      );
    }
  });
});
