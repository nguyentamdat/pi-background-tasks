import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveShellPolicy } from '../../src/core/common.js';
import {
  applyShellPolicyGuidance,
  createShellPolicyGuidanceHandler,
  renderShellPolicyGuidanceBlock,
  SHELL_POLICY_SECTION,
  shellPolicyGuidance,
} from '../../src/core/shell-policy.js';

const policy = resolveShellPolicy('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
const changedPolicy = resolveShellPolicy('linux', { SHELL: '/bin/zsh' });
const block = renderShellPolicyGuidanceBlock(policy);
const open = `<${SHELL_POLICY_SECTION}>`;
const close = `</${SHELL_POLICY_SECTION}>`;

// Exercise runtime input validation without pretending OMP's event is a Pi type.
function apply(event: unknown): unknown {
  return Reflect.apply(applyShellPolicyGuidance, undefined, [event, policy]);
}
function resultPrompt(result: unknown): unknown {
  assert.ok(typeof result === 'object' && result !== null);
  return Reflect.get(result, 'systemPrompt');
}

void describe('shell-guidance prompt contracts (#35 OMP follow-up)', () => {
  for (const prompt of ['', 'base, commas\n\nUnicode Ω 😀\r\n', 'prefix\u0000suffix']) {
    for (const options of [
      undefined,
      null,
      {},
      { cwd: '/fixture' },
      { sections: undefined },
      { sections: null },
    ]) {
      void it(`accepts a string prompt without structured state (${JSON.stringify(prompt)}, ${JSON.stringify(options)})`, () => {
        const event = Object.freeze({
          systemPrompt: prompt,
          ...(options === undefined ? {} : { systemPromptOptions: options }),
        });
        const first = resultPrompt(apply(event));
        assert.equal(first, prompt.length ? `${prompt}\n\n${block}` : block);
        assert.equal(resultPrompt(apply({ systemPrompt: first })), first);
      });
    }
  }

  for (const parts of [[], [''], ['', '', ''], ['base, literal', 'peer\r\nΩ 😀', '', 'last\n']]) {
    void it(`preserves array boundaries, empty elements and bytes (${JSON.stringify(parts)})`, () => {
      const input = Object.freeze([...parts]);
      const first = resultPrompt(apply({ systemPrompt: input }));
      assert.deepEqual(first, [...parts, block]);
      assert.notStrictEqual(first, input);
      assert.deepEqual(input, parts, 'caller-owned arrays remain unchanged');
      assert.deepEqual(
        resultPrompt(apply({ systemPrompt: Object.freeze(first as string[]) })),
        first,
      );
    });
  }

  void it('replaces an existing block within its element without moving or joining peer text', () => {
    const old = renderShellPolicyGuidanceBlock(changedPolicy);
    const parts = Object.freeze([
      'before',
      `embedded prefix\n${old}\nembedded suffix`,
      '',
      'after',
    ]);
    const first = resultPrompt(apply({ systemPrompt: parts }));
    assert.deepEqual(first, ['before', `embedded prefix\n${block}\nembedded suffix`, '', 'after']);
    assert.equal(parts[1], `embedded prefix\n${old}\nembedded suffix`);
    assert.deepEqual(resultPrompt(apply({ systemPrompt: first })), first);
  });

  void it('does not synthesize a block by joining fragments across array elements', () => {
    const parts = [open, 'peer content between elements', close];
    const first = resultPrompt(apply({ systemPrompt: parts }));
    assert.deepEqual(first, [...parts, block]);
    assert.deepEqual(resultPrompt(apply({ systemPrompt: first })), first);
  });

  void it('does not discard unmatched marker text from another section', () => {
    const parts = [`peer ${open} no close`, 'other peer'];
    const first = resultPrompt(apply({ systemPrompt: parts }));
    assert.deepEqual(first, [...parts, block]);
    assert.deepEqual(resultPrompt(apply({ systemPrompt: first })), first);
  });

  void it('composes with another array-transforming extension in either order', () => {
    const peer = (parts: readonly string[]) => [...parts, 'PEER_EXTENSION'];
    const input = ['HOST_BASE', 'HOST_TOOLS'];
    const before = resultPrompt(apply({ systemPrompt: peer(input) }));
    assert.deepEqual(before, [...input, 'PEER_EXTENSION', block]);
    const ours = resultPrompt(apply({ systemPrompt: input }));
    assert.ok(Array.isArray(ours));
    const after = peer(ours);
    assert.deepEqual(after, [...input, block, 'PEER_EXTENSION']);
    assert.deepEqual(resultPrompt(apply({ systemPrompt: after })), after);
  });

  void it('uses the array contract even if unrelated options exist, without mutating them', () => {
    const options = Object.freeze({
      sections: Object.freeze({ peer: 'KEEP' }),
      forceSystemPrompt: 'KEEP_FORCED',
    });
    const first = resultPrompt(
      apply({ systemPrompt: ['array authority'], systemPromptOptions: options }),
    );
    assert.deepEqual(first, ['array authority', block]);
    assert.deepEqual(options, { sections: { peer: 'KEEP' }, forceSystemPrompt: 'KEEP_FORCED' });
  });

  void it('keeps modern structured sections and forced text idempotent and preserves peer fields', () => {
    const sections = { peer: 'UNCHANGED\nΩ', [SHELL_POLICY_SECTION]: 'OLD' };
    const options = { cwd: '/fixture', sections, forceSystemPrompt: 'forced peer' };
    const event = { systemPrompt: 'rendered', systemPromptOptions: options };
    assert.equal(apply(event), undefined);
    assert.strictEqual(options.sections, sections);
    assert.equal(sections.peer, 'UNCHANGED\nΩ');
    assert.equal(sections[SHELL_POLICY_SECTION], shellPolicyGuidance(policy));
    assert.equal(options.forceSystemPrompt, `forced peer\n\n${block}`);
    assert.equal(options.cwd, '/fixture');
    const first = structuredClone(options);
    assert.equal(apply(event), undefined);
    assert.deepEqual(options, first);
  });

  void it('supports empty structured sections and an explicitly empty forced prompt', () => {
    const options = {
      sections: Object.create(null) as Record<string, string>,
      forceSystemPrompt: '',
    };
    assert.equal(apply({ systemPrompt: '', systemPromptOptions: options }), undefined);
    assert.equal(options.sections[SHELL_POLICY_SECTION], shellPolicyGuidance(policy));
    assert.equal(options.forceSystemPrompt, block);
  });

  for (const prompt of [undefined, null, 42, {}, [undefined], ['valid', 42], new Array(1)]) {
    void it(`rejects malformed prompt values without coercion (${JSON.stringify(prompt)})`, () => {
      const sections = { peer: 'unchanged' };
      assert.throws(
        () => apply({ systemPrompt: prompt, systemPromptOptions: { sections } }),
        /pi_bg_shell_prompt_unsupported/u,
      );
      assert.deepEqual(sections, { peer: 'unchanged' });
    });
  }

  for (const options of [
    42,
    'invalid',
    [],
    { sections: [] },
    { sections: 'invalid' },
    { sections: false },
  ]) {
    void it(`rejects malformed supplied structured state (${JSON.stringify(options)})`, () => {
      assert.throws(
        () => apply({ systemPrompt: 'base', systemPromptOptions: options }),
        /pi_bg_shell_prompt_unsupported/u,
      );
    });
  }

  for (const forced of [null, 42, []]) {
    void it(`validates a forced prompt before changing sections (${JSON.stringify(forced)})`, () => {
      const sections = { peer: 'unchanged' };
      assert.throws(
        () =>
          apply({
            systemPrompt: 'base',
            systemPromptOptions: { sections, forceSystemPrompt: forced },
          }),
        /pi_bg_shell_prompt_unsupported/u,
      );
      assert.deepEqual(sections, { peer: 'unchanged' });
    });
  }

  void it('the actual handler accepts the OMP 18.3.0 event without requiring UI or context', () => {
    // OMP v18.3.0 extensions/runner.ts emits these fields; there is no options object.
    const handler = createShellPolicyGuidanceHandler(policy);
    const event = {
      type: 'before_agent_start',
      prompt: 'hello',
      images: undefined,
      systemPrompt: ['HOST_BASE', 'HOST_POLICY'],
    };
    const result: unknown = Reflect.apply(handler, undefined, [event]);
    assert.deepEqual(resultPrompt(result), ['HOST_BASE', 'HOST_POLICY', block]);
    assert.deepEqual(event.systemPrompt, ['HOST_BASE', 'HOST_POLICY']);
  });
});
