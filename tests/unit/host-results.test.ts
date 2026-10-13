import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BgTask, DelegateTaskFacts, FusionTaskFacts, TaskStatus } from '../../src/core/common.js';
import {
  buildDelegateResultPackage,
  serializeDelegateResultPackage,
} from '../../src/core/delegate/result-package.js';
import { readHostTaskResult } from '../../src/core/host-results.js';
import { HostApiError, HOST_MAX_INLINE_RESULT_BYTES } from '../../src/core/host-protocol.js';

const SEED = 'a'.repeat(64);
const DIRECTIVE = 'b'.repeat(64);
const ROUTE = { provider: 'pi-bg-host-unit', model: 'scripted' };

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function baseTask(id: string, status: TaskStatus, root: string): BgTask {
  return {
    id,
    name: id,
    command: 'pi --mode json',
    status,
    outputPath: `.pi/tasks/s/${id}.output`,
    outputAbsPath: join(root, `${id}.output`),
    metadataAbsPath: join(root, `${id}.json`),
    cwd: root,
    startTime: 1,
    bytesWritten: 0,
    isAgent: true,
    surviveReload: false,
    notified: false,
    notifyOnCompletion: false,
    triggerOnCompletion: false,
    terminalPublished: false,
    terminalPublicationState: 'pending',
    terminalPublishAttempts: 0,
    waiters: [],
  };
}

function delegateFacts(taskId: string, artifactDirAbs: string): DelegateTaskFacts {
  // Only the identity, route and artifact coordinates are read by the verifier.
  // Budget telemetry is irrelevant to result integrity and is carried opaquely.
  const facts: DelegateTaskFacts = JSON.parse(
    JSON.stringify({
      taskId,
      launchNonce: `nonce-${taskId}`,
      artifactDir: `.pi/delegate/s/${taskId}`,
      artifactDirAbs,
      seedSha256: SEED,
      childSessionId: `child-${taskId}`,
      route: { ...ROUTE, qualifiedId: `${ROUTE.provider}/${ROUTE.model}` },
      budget: { family: 'unknown', rate_source: { source: 'unit-fixture' } },
      extensionMode: 'isolated',
      autoDeliver: 'never',
    }),
  );
  return facts;
}

async function writeDelegateResult(dir: string, taskId: string, answer: string): Promise<void> {
  const pkg = buildDelegateResultPackage({
    taskId,
    launchNonce: `nonce-${taskId}`,
    seedSha256: SEED,
    directiveSha256: DIRECTIVE,
    route: ROUTE,
    routeAttestations: [{ ...ROUTE, stop_reason: 'stop' }],
    stopReason: 'stop',
    turns: 1,
    toolCalls: 0,
    usage: { status: 'unavailable', reason: 'deterministic unit fixture performs no inference' },
    answerBlocks: [answer],
    spilledArtifacts: [],
  });
  await writeFile(join(dir, 'result.json'), serializeDelegateResultPackage(pkg));
}

async function fingerprint(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    const file = join(dir, entry);
    const info = await stat(file);
    if (!info.isFile()) continue;
    out.push(`${entry}:${String(info.mtimeMs)}:${createHash('sha256').update(await readFile(file)).digest('hex')}`);
  }
  return out;
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HostApiError, String(error));
    return error.code;
  }
  assert.fail('expected rejection');
}

void describe('host verified result reader', { concurrency: false }, () => {
  void it('returns a verified inline delegate answer without writing adjudication files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-results-'));
    try {
      const dir = join(root, 'delegate');
      await mkdir(dir);
      const answer = 'Verified ✓ delegate answer';
      await writeDelegateResult(dir, 'bdel1', answer);
      const task = { ...baseTask('bdel1', 'completed', root), delegate: delegateFacts('bdel1', dir) };
      const before = await fingerprint(dir);
      const view = await readHostTaskResult(task);
      assert.deepEqual(view, {
        taskId: 'bdel1',
        kind: 'delegate',
        state: 'committed',
        delivery: 'inline',
        answerBytes: Buffer.byteLength(answer),
        answerSha256: sha256(answer),
        artifactPath: join('.pi/delegate/s/bdel1', 'result.json'),
        text: answer,
      });
      assert.deepEqual(await fingerprint(dir), before);
      assert.equal(existsSync(join(dir, 'outcome.json')), false, 'reads never write outcome.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('returns an exact artifact reference for oversize answers, never truncated text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-results-'));
    try {
      const dir = join(root, 'delegate');
      await mkdir(dir);
      const answer = 'λ'.repeat(HOST_MAX_INLINE_RESULT_BYTES);
      await writeDelegateResult(dir, 'bdel2', answer);
      const view = await readHostTaskResult({
        ...baseTask('bdel2', 'completed', root),
        delegate: delegateFacts('bdel2', dir),
      });
      assert.equal(view.state, 'committed');
      assert.ok(view.state === 'committed');
      assert.equal(view.delivery, 'artifact');
      assert.equal(view.text, undefined);
      assert.equal(view.answerBytes, Buffer.byteLength(answer));
      assert.equal(view.answerSha256, sha256(answer));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses tampered delegate bytes and reports truthful no-answer states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-results-'));
    try {
      const tampered = join(root, 'tampered');
      await mkdir(tampered);
      await writeFile(join(tampered, 'result.json'), '{}');
      assert.equal(
        await rejectionCode(
          readHostTaskResult({
            ...baseTask('bdel3', 'completed', root),
            delegate: delegateFacts('bdel3', tampered),
          }),
        ),
        'RESULT_INVALID',
      );
      const empty = join(root, 'empty');
      await mkdir(empty);
      const failed = await readHostTaskResult({
        ...baseTask('bdel4', 'failed', root),
        delegate: delegateFacts('bdel4', empty),
      });
      assert.equal(failed.state, 'failed');
      assert.equal(failed.delivery, 'none');
      assert.ok(failed.state === 'failed');
      assert.equal(failed.errorCode, 'child_exited_without_commit');
      assert.equal('text' in failed, false);
      const cancelled = await readHostTaskResult({
        ...baseTask('bdel5', 'killed', root),
        delegate: delegateFacts('bdel5', empty),
      });
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(existsSync(join(empty, 'outcome.json')), false);
      const running = await readHostTaskResult({
        ...baseTask('bdel6', 'running', root),
        delegate: delegateFacts('bdel6', empty),
      });
      assert.deepEqual(running, { taskId: 'bdel6', kind: 'delegate', state: 'running', delivery: 'none' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('verifies Fusion through the manifest-bound readers without a usage claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-results-'));
    try {
      const dir = join(root, 'fusion');
      await mkdir(dir);
      const facts: FusionTaskFacts = {
        runId: 'fusion-run-1',
        workflow: 'reason',
        artifactDir: '.pi/fusion/s/fusion-run-1',
        artifactDirAbs: dir,
        state: 'completed',
        outcome: { status: 'committed' },
        usageDelivered: false,
      };
      const committed = { ...baseTask('bfus1', 'completed', root), fusion: facts };
      assert.equal(await rejectionCode(readHostTaskResult(committed)), 'RESULT_INVALID');
      assert.equal(facts.usageDelivered, false);
      const failedFacts: FusionTaskFacts = { ...facts, state: 'failed', outcome: { status: 'failed' } };
      const failed = await readHostTaskResult({ ...baseTask('bfus2', 'failed', root), fusion: failedFacts });
      assert.equal(failed.state, 'failed');
      assert.equal(failed.delivery, 'none');
      assert.ok(failed.state === 'failed');
      assert.equal(failed.fusionFailure?.answer.present, false);
      assert.equal('text' in failed, false);
      assert.deepEqual(await readdir(dir), [], 'Fusion reads create no files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses tasks without a verified result', async () => {
    assert.equal(await rejectionCode(readHostTaskResult(baseTask('bshell', 'completed', tmpdir()))), 'NO_RESULT');
  });
});
