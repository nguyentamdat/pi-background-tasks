import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type EventBus,
} from '@earendil-works/pi-coding-agent';

// Exercises the compiled published entrypoint, not the TypeScript sources.
const compiledEntrypoint = resolve('dist/extensions/background-tasks.js');
const roots: string[] = [];

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  assert.ok(isRecord(value), `expected an object carrying ${key}`);
  return value[key];
}

interface Harness {
  session: AgentSession;
  events: EventBus;
  changes: Frame[];
  terminals: Map<string, Frame>;
  errors: unknown[];
  close(): Promise<void>;
}

async function harness(features?: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const previous = {
    features: process.env['PI_BG_FEATURES'],
    agentDir: process.env['PI_CODING_AGENT_DIR'],
  };
  if (features === undefined) Reflect.deleteProperty(process.env, 'PI_BG_FEATURES');
  else process.env['PI_BG_FEATURES'] = features;
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  const events = createEventBus();
  const changes: Frame[] = [];
  const terminals = new Map<string, Frame>();
  const offChanged = events.on('pi-background-tasks:host:changed:v1', (frame) => {
    if (isRecord(frame)) changes.push(frame);
  });
  const offTerminal = events.on('pi-background-tasks:terminal:v1', (frame) => {
    const task = field(frame, 'task');
    terminals.set(String(field(task, 'id')), frame as Frame);
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: events,
    additionalExtensionPaths: [compiledEntrypoint],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: 'builtin',
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  let closed = false;
  return {
    session,
    events,
    changes,
    terminals,
    errors,
    async close() {
      if (closed) return;
      closed = true;
      offChanged();
      offTerminal();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      if (previous.features === undefined) Reflect.deleteProperty(process.env, 'PI_BG_FEATURES');
      else process.env['PI_BG_FEATURES'] = previous.features;
      if (previous.agentDir === undefined) Reflect.deleteProperty(process.env, 'PI_CODING_AGENT_DIR');
      else process.env['PI_CODING_AGENT_DIR'] = previous.agentDir;
    },
  };
}

function request(
  events: EventBus,
  channel: 'host' | 'v1',
  operation: string,
  payload: unknown,
  timeoutMs = 8000,
): Promise<Frame | undefined> {
  const prefix = channel === 'host' ? 'pi-background-tasks:host' : 'pi-background-tasks';
  const schema = channel === 'host' ? 'pi-background-tasks.host' : 'pi-background-tasks.extension';
  const requestId = randomUUID();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      off();
      resolvePromise(undefined);
    }, timeoutMs);
    const off = events.on(`${prefix}:response:v1`, (frame) => {
      if (!isRecord(frame) || frame['request_id'] !== requestId) return;
      clearTimeout(timer);
      off();
      resolvePromise(frame);
    });
    events.emit(`${prefix}:request:v1`, {
      schema_version: `${schema}-request.v1`,
      request_id: requestId,
      operation,
      payload,
    });
  });
}

async function ok(pending: Promise<Frame | undefined>): Promise<Frame> {
  const frame = await pending;
  assert.ok(frame !== undefined, 'expected a response');
  assert.equal(frame['ok'], true, JSON.stringify(frame));
  const result = frame['result'];
  assert.ok(isRecord(result));
  return result;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

class HostClient {
  private sequence = 0;
  leaseId = '';
  activationId = '';

  constructor(private readonly events: EventBus) {}

  async subscribe(clientId: string): Promise<Frame> {
    const result = await ok(request(this.events, 'host', 'subscribe', { clientId }));
    this.leaseId = String(result['leaseId']);
    this.activationId = String(result['activationId']);
    this.sequence = 0;
    return result;
  }

  call(operation: string, extra: Record<string, unknown> = {}, timeoutMs?: number): Promise<Frame | undefined> {
    this.sequence += 1;
    return request(
      this.events,
      'host',
      operation,
      { leaseId: this.leaseId, activationId: this.activationId, sequence: this.sequence, ...extra },
      timeoutMs,
    );
  }
}

async function launch(h: Harness, name: string, command: string): Promise<string> {
  const task = field(
    await ok(
      request(h.events, 'v1', 'run', {
        name,
        command,
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      }),
    ),
    'id',
  );
  return String(task);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('compiled host interface through the Pi SDK', { concurrency: false }, () => {
  void it('serves exact reads and controls over the real registry without transcript effects', async () => {
    const h = await harness();
    try {
      const ready = h.changes.find((frame) => frame['kind'] === 'ready');
      assert.ok(ready, 'an initialized activation announces itself once');
      assert.equal(h.changes.filter((frame) => frame['kind'] === 'ready').length, 1);
      const capabilities = await ok(request(h.events, 'host', 'capabilities', {}));
      assert.equal(capabilities['api_version'], 1);
      const client = new HostClient(h.events);
      const lease = await client.subscribe('sdk-client');
      assert.equal(lease['activationId'], ready['activationId']);
      assert.equal(lease['sessionId'], h.session.sessionManager.getSessionId());

      const transcript = JSON.stringify(h.session.sessionManager.getEntries());
      const printed = await launch(h, 'Printed', 'printf host-sdk-ok');
      await waitFor(() => h.terminals.has(printed), 'printed terminal');
      await waitFor(
        () => h.changes.some((frame) => frame['kind'] === 'changed'),
        'coalesced changed frame for a subscribed client',
      );
      const page = await ok(client.call('list', { limit: 5 }));
      const views = page['tasks'];
      assert.ok(Array.isArray(views));
      const view = views.find((entry) => field(field(entry, 'task'), 'id') === printed);
      assert.equal(field(view, 'kind'), 'shell');
      assert.equal(field(view, 'seen'), false);
      const logs = await ok(client.call('logs', { taskId: printed, maxBytes: 7, tail: true }));
      assert.equal(logs['text'], 'host-sdk-ok'.slice(-7));
      assert.equal(logs['truncated'], true);
      assert.equal(logs['bytesWritten'], Buffer.byteLength('host-sdk-ok'));
      const marked = await ok(client.call('mark_seen', { taskIds: [printed] }));
      assert.equal(field(marked['counts'], 'unseenCompleted'), 0);
      const resultFrame = await client.call('result', { taskId: printed });
      assert.equal(field(field(resultFrame, 'error'), 'code'), 'NO_RESULT');

      const sleeper = await launch(h, 'Sleeper', 'sleep 60');
      const stopped = await ok(client.call('stop', { taskId: sleeper }));
      assert.equal(stopped['alreadyTerminal'], false);
      assert.equal(field(stopped['task'], 'status'), 'killed');
      assert.equal(
        JSON.stringify(h.session.sessionManager.getEntries()),
        transcript,
        'host reads, seen marks and stopping notification-disabled work add no transcript entries',
      );
      // Rerun is new user-initiated work under the dock policy (notification on, no wake),
      // so its later terminal notification is ordinary completion delivery.
      const rerun = await ok(client.call('rerun', { taskId: sleeper }));
      const rerunId = String(field(rerun['task'], 'id'));
      assert.notEqual(rerunId, sleeper);
      assert.equal(field(rerun['task'], 'command'), 'sleep 60');
      assert.equal(field(rerun['task'], 'notifyOnCompletion'), true);
      assert.equal(field(rerun['task'], 'triggerOnCompletion'), false);
      const all = await ok(client.call('stop_all', { taskIds: [rerunId, printed] }));
      assert.equal(all['stopped'], 1);
      assert.equal(all['alreadyTerminal'], 1);
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  });

  void it('does no change publication work without a lease and closes on shutdown', async () => {
    const h = await harness('process');
    try {
      const printed = await launch(h, 'Unobserved', 'printf unobserved');
      await waitFor(() => h.terminals.has(printed), 'unobserved terminal');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      assert.deepEqual(
        h.changes.map((frame) => frame['kind']),
        ['ready'],
        'no changed frames are built while no client is subscribed',
      );
      const client = new HostClient(h.events);
      await client.subscribe('process-only');
      const page = await ok(client.call('list'));
      assert.equal(field(page['counts'], 'completed'), 1);
      await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      assert.equal(h.changes.at(-1)?.['kind'], 'closed');
      assert.equal(await client.call('list', {}, 300), undefined, 'a closed activation answers nothing');
      assert.equal(await request(h.events, 'host', 'capabilities', {}, 300), undefined);
    } finally {
      await h.close();
    }
  });
});
