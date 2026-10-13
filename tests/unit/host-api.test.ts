import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import {
  installBackgroundTaskHostApi,
  readHostLogWindow,
  type BackgroundTaskHostRegistryPort,
  type BackgroundTaskHostService,
} from '../../src/core/host-api.js';
import {
  HOST_CHANGED_CHANNEL,
  HOST_CHANGED_SCHEMA,
  HOST_MAX_IN_FLIGHT,
  HOST_MAX_LEASES,
  HOST_OPERATIONS,
  HOST_REQUEST_CHANNEL,
  HOST_REQUEST_SCHEMA,
  HOST_RESPONSE_CHANNEL,
  HOST_RESPONSE_SCHEMA,
  type HostResultView,
} from '../../src/core/host-protocol.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
} from '../../src/core/registry.js';
import { snapshot, type BgTask, type KillKind } from '../../src/core/common.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../../src/core/windows-taskkill.js';

class MemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  count(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'));
    return true;
  }
}

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  assert.ok(isRecord(value), `expected object with ${key}`);
  return value[key];
}

interface Harness {
  root: string;
  ctx: BackgroundTaskContext;
  bus: MemoryEventBus;
  registry: BackgroundTaskRegistry;
  service: BackgroundTaskHostService;
  seen: Set<string>;
  responses: Frame[];
  changes: Frame[];
  spawns(): number;
  children: FakeChild[];
  ready(): void;
  dispose(): Promise<void>;
}

async function createHarness(options: { coalesceMs?: number } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-api-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const bus = new MemoryEventBus();
  const children: FakeChild[] = [];
  const live = new Set<number>();
  let pid = 7100;
  let idSeq = 0;
  let service: BackgroundTaskHostService | undefined;
  const spawn: BackgroundTaskSpawn = () => {
    const child = new FakeChild(++pid);
    live.add(child.pid);
    child.on('close', () => live.delete(child.pid));
    children.push(child);
    return child;
  };
  const killProcess = (target: number, signal?: NodeJS.Signals | number): boolean => {
    const group = Math.abs(target);
    if (signal === 0) {
      if (live.has(group)) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
    const child = children.find((candidate) => candidate.pid === group);
    if (!child) throw new Error(`no fake child ${String(group)}`);
    child.kill(typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  };
  const killTree = (target: number, phase: WindowsKillPhase): Promise<TaskkillOutcome> => {
    killProcess(target, phase === 'force' ? 'SIGKILL' : 'SIGTERM');
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  };
  const seen = new Set<string>();
  const registry = new BackgroundTaskRegistry({
    makeTaskId: () => `bhost${String(++idSeq).padStart(4, '0')}`,
    sendCompletionNotification: () => {},
    killGraceMs: 20,
    stopWaitMs: 1000,
    platform: 'linux',
    killProcess,
    killTree,
    spawn,
    onChange: () => service?.invalidate(),
    logger: { error: () => {} },
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'host-api-unit-session',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  let currentCtx: BackgroundTaskContext | undefined;
  service = installBackgroundTaskHostApi({
    events: bus,
    registry,
    getContext: () => currentCtx,
    isSeen: (taskId) => seen.has(taskId),
    markSeen: (taskIds) => {
      for (const taskId of taskIds) seen.add(taskId);
      service?.invalidate();
    },
    readResult: () => Promise.reject(new Error('no result reader in this harness')),
    coalesceMs: options.coalesceMs,
    logger: { error: () => {} },
  });
  const installed = service;
  const responses: Frame[] = [];
  const changes: Frame[] = [];
  bus.on(HOST_RESPONSE_CHANNEL, (data) => {
    if (isRecord(data)) responses.push(data);
  });
  bus.on(HOST_CHANGED_CHANNEL, (data) => {
    if (isRecord(data)) changes.push(data);
  });
  return {
    root,
    ctx,
    bus,
    registry,
    service: installed,
    seen,
    responses,
    changes,
    spawns: () => children.length,
    children,
    ready() {
      currentCtx = ctx;
      installed.markReady();
    },
    async dispose() {
      for (const task of registry.allTasks()) {
        if (task.status === 'running') await registry.stopTask(task, 'shutdown').catch(() => task);
      }
      installed.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

let requestCounter = 0;

function send(bus: EventBus, operation: string, payload: unknown, requestId?: string): Promise<Frame> {
  const id = requestId ?? `req-${String(++requestCounter)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no host response for ${operation} ${id}`));
    }, 5000);
    const off = bus.on(HOST_RESPONSE_CHANNEL, (data) => {
      if (!isRecord(data) || data['request_id'] !== id) return;
      clearTimeout(timer);
      off();
      assert.equal(data['schema_version'], HOST_RESPONSE_SCHEMA);
      assert.equal(data['operation'], operation);
      resolve(data);
    });
    bus.emit(HOST_REQUEST_CHANNEL, {
      schema_version: HOST_REQUEST_SCHEMA,
      request_id: id,
      operation,
      payload,
    });
  });
}

function ok(frame: Frame): Frame {
  assert.equal(frame['ok'], true, JSON.stringify(frame));
  const result = frame['result'];
  assert.ok(isRecord(result));
  return result;
}

function errorCode(frame: Frame): unknown {
  assert.equal(frame['ok'], false, JSON.stringify(frame));
  return field(frame['error'], 'code');
}

class Client {
  sequence = 0;
  leaseId = '';
  activationId = '';

  constructor(private readonly bus: EventBus) {}

  async subscribe(clientId = 'unit-client'): Promise<Frame> {
    const result = ok(await send(this.bus, 'subscribe', { clientId }));
    this.leaseId = String(result['leaseId']);
    this.activationId = String(result['activationId']);
    this.sequence = 0;
    return result;
  }

  call(operation: string, extra: Record<string, unknown> = {}, requestId?: string): Promise<Frame> {
    this.sequence += 1;
    return send(
      this.bus,
      operation,
      {
        leaseId: this.leaseId,
        activationId: this.activationId,
        sequence: this.sequence,
        ...extra,
      },
      requestId,
    );
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeTask(id: string, overrides: Partial<BgTask> = {}): BgTask {
  return {
    id,
    name: id,
    command: `printf ${id}`,
    status: 'completed',
    outputPath: `.pi/tasks/s/${id}.output`,
    outputAbsPath: `/nonexistent/${id}.output`,
    metadataAbsPath: `/nonexistent/${id}.json`,
    cwd: '/nonexistent',
    startTime: 1000,
    bytesWritten: 0,
    isAgent: false,
    surviveReload: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
    terminalPublished: false,
    terminalPublicationState: 'pending',
    terminalPublishAttempts: 0,
    waiters: [],
    ...overrides,
  };
}

interface PortHarness {
  bus: MemoryEventBus;
  service: BackgroundTaskHostService;
  tasks: BgTask[];
  stopCalls: string[];
  holdStops: Array<() => void>;
}

function createPortHarness(
  tasks: BgTask[],
  readResult: (task: BgTask) => Promise<HostResultView> = () =>
    Promise.reject(new Error('unused')),
): PortHarness {
  const bus = new MemoryEventBus();
  const stopCalls: string[] = [];
  const holdStops: Array<() => void> = [];
  const port: BackgroundTaskHostRegistryPort = {
    allTasks: () => [...tasks],
    snapshot: (task) => snapshot(task),
    isShuttingDown: () => false,
    stopTask: (task: BgTask, _kind: KillKind) =>
      new Promise<BgTask>((resolve) => {
        stopCalls.push(task.id);
        holdStops.push(() => {
          task.status = 'killed';
          resolve(task);
        });
      }),
    startTask: () => Promise.reject(new Error('startTask is not used by this harness')),
  };
  const ctx: BackgroundTaskContext = {
    cwd: '/nonexistent',
    sessionId: 'host-port-session',
    modelRegistry: { getAll: () => [] },
  };
  const service = installBackgroundTaskHostApi({
    events: bus,
    registry: port,
    getContext: () => ctx,
    isSeen: () => false,
    markSeen: () => {},
    readResult,
    logger: { error: () => {} },
  });
  service.markReady();
  return { bus, service, tasks, stopCalls, holdStops };
}

void describe('host interface service', { concurrency: false }, () => {
  void it('answers capabilities before readiness, refuses pre-session subscribe, then announces ready once', async () => {
    const h = await createHarness();
    try {
      const capabilities = ok(await send(h.bus, 'capabilities', {}));
      assert.deepEqual(capabilities['operations'], [...HOST_OPERATIONS]);
      assert.equal(capabilities['max_page_size'], 50);
      assert.equal(errorCode(await send(h.bus, 'subscribe', { clientId: 'early' })), 'UNAVAILABLE');
      assert.equal(h.changes.length, 0);
      h.ready();
      h.ready();
      assert.equal(h.changes.length, 1);
      assert.equal(h.changes[0]?.['kind'], 'ready');
      assert.equal(h.changes[0]?.['schema_version'], HOST_CHANGED_SCHEMA);
      assert.equal(h.changes[0]?.['activationId'], h.service.activationId);
      const first = ok(await send(h.bus, 'subscribe', { clientId: 'same' }));
      const second = ok(await send(h.bus, 'subscribe', { clientId: 'same' }));
      assert.equal(first['leaseId'], second['leaseId']);
      assert.equal(first['sessionId'], 'host-api-unit-session');
      for (let index = 1; index < HOST_MAX_LEASES; index += 1) {
        ok(await send(h.bus, 'subscribe', { clientId: `client-${String(index)}` }));
      }
      assert.equal(errorCode(await send(h.bus, 'subscribe', { clientId: 'overflow' })), 'LEASE_LIMIT');
      assert.equal(errorCode(await send(h.bus, 'run', { command: 'printf no' })), 'UNKNOWN_OPERATION');
    } finally {
      await h.dispose();
    }
  });

  void it('arms no timer and builds no frame without leases; coalesces changes with a lease', async () => {
    const h = await createHarness({ coalesceMs: 60 });
    try {
      h.ready();
      const before = h.service.revision;
      for (let index = 0; index < 50; index += 1) h.service.invalidate();
      assert.equal(h.service.revision, before + 50);
      assert.equal(h.service.changePending, false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(h.changes.filter((frame) => frame['kind'] === 'changed').length, 0);

      const client = new Client(h.bus);
      await client.subscribe();
      for (let index = 0; index < 50; index += 1) h.service.invalidate();
      assert.equal(h.service.changePending, true);
      await waitFor(() => h.changes.some((frame) => frame['kind'] === 'changed'), 'changed frame');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const changed = h.changes.filter((frame) => frame['kind'] === 'changed');
      assert.equal(changed.length, 1, 'many invalidations coalesce into one frame');
      assert.equal(changed[0]?.['revision'], h.service.revision);

      h.service.invalidate();
      assert.equal(h.service.changePending, true);
      ok(await client.call('unsubscribe'));
      assert.equal(h.service.changePending, false, 'last unsubscribe clears the pending timer');
      assert.equal(h.service.leaseCount, 0);
    } finally {
      await h.dispose();
    }
  });

  void it('fences sequences: identical replay, conflict, stale eviction without re-execution', async () => {
    const h = await createHarness();
    try {
      h.ready();
      const client = new Client(h.bus);
      await client.subscribe();
      const source = await h.registry.startTask(h.ctx, 'sleep 90', { name: 'Source', isAgent: false });
      const spawnsBefore = h.spawns();
      client.sequence += 1;
      const rerunPayload = {
        leaseId: client.leaseId,
        activationId: client.activationId,
        sequence: client.sequence,
        taskId: source.id,
      };
      const first = await send(h.bus, 'rerun', rerunPayload, 'rerun-fixed');
      const rerun = ok(first);
      assert.notEqual(field(rerun['task'], 'id'), source.id);
      assert.equal(field(rerun['task'], 'command'), 'sleep 90');
      assert.equal(field(rerun['task'], 'notifyOnCompletion'), true);
      assert.equal(field(rerun['task'], 'triggerOnCompletion'), false);
      assert.equal(h.spawns(), spawnsBefore + 1);
      assert.deepEqual(await send(h.bus, 'rerun', rerunPayload, 'rerun-fixed'), first);
      assert.equal(
        errorCode(await send(h.bus, 'rerun', { ...rerunPayload, taskId: 'bhost9999' }, 'rerun-fixed')),
        'CONFLICT',
      );
      assert.equal(h.spawns(), spawnsBefore + 1);
      for (let index = 0; index < 70; index += 1) ok(await client.call('list', { limit: 1 }));
      assert.equal(errorCode(await send(h.bus, 'rerun', rerunPayload, 'rerun-fixed')), 'STALE_REQUEST');
      assert.equal(h.spawns(), spawnsBefore + 1, 'an evicted request is never executed again');
      const skipped = client.sequence + 10;
      client.sequence = skipped;
      ok(await client.call('list'));
      client.sequence = skipped - 1;
      assert.equal(errorCode(await client.call('list')), 'STALE_REQUEST');
    } finally {
      await h.dispose();
    }
  });

  void it('rejects foreign activation, foreign or released leases and invalid inputs', async () => {
    const h = await createHarness();
    try {
      h.ready();
      const task = await h.registry.startTask(h.ctx, 'printf ok', { name: 'Exact', isAgent: false });
      const client = new Client(h.bus);
      await client.subscribe();
      client.sequence += 1;
      assert.equal(
        errorCode(
          await send(h.bus, 'detail', {
            leaseId: client.leaseId,
            activationId: 'act-foreign',
            sequence: client.sequence,
            taskId: task.id,
          }),
        ),
        'ACTIVATION_MISMATCH',
      );
      client.sequence += 1;
      assert.equal(
        errorCode(
          await send(h.bus, 'detail', {
            leaseId: 'lease-foreign',
            activationId: client.activationId,
            sequence: client.sequence,
            taskId: task.id,
          }),
        ),
        'LEASE_INVALID',
      );
      assert.equal(errorCode(await client.call('detail', { taskId: task.id.slice(0, 4) })), 'NOT_FOUND');
      for (const bad of [0, -1, 65537, null, '4', 1.5]) {
        assert.equal(errorCode(await client.call('logs', { taskId: task.id, maxBytes: bad })), 'INVALID_REQUEST');
      }
      assert.equal(errorCode(await client.call('logs', { taskId: task.id, path: '/etc/passwd' })), 'INVALID_REQUEST');
      assert.equal(errorCode(await client.call('list', { limit: 51 })), 'INVALID_REQUEST');
      assert.equal(errorCode(await client.call('list', { cursor: 'c1.garbage' })), 'INVALID_CURSOR');
      assert.equal(errorCode(await client.call('stop_all', { taskIds: [] })), 'INVALID_REQUEST');
      assert.equal(errorCode(await client.call('mark_seen', { taskIds: [task.id, task.id] })), 'INVALID_REQUEST');
      const prior = client.leaseId;
      ok(await client.call('unsubscribe'));
      assert.equal(errorCode(await client.call('list')), 'LEASE_INVALID');
      const next = await client.subscribe();
      assert.notEqual(next['leaseId'], prior);
    } finally {
      await h.dispose();
    }
  });

  void it('pages every retained running task beyond the 100-task retention bound', async () => {
    const h = await createHarness();
    try {
      h.ready();
      const ids: string[] = [];
      for (let index = 0; index < 120; index += 1) {
        ids.push((await h.registry.startTask(h.ctx, 'sleep 90', { name: `Page ${String(index)}`, isAgent: false })).id);
      }
      const client = new Client(h.bus);
      await client.subscribe();
      const seenIds: string[] = [];
      let cursor: unknown;
      let pages = 0;
      let previous: { startTime: number; id: string } | undefined;
      do {
        const page = ok(await client.call('list', cursor === undefined ? { limit: 13 } : { limit: 13, cursor }));
        assert.equal(field(page['counts'], 'running'), 120);
        const tasks = page['tasks'];
        assert.ok(Array.isArray(tasks));
        assert.ok(tasks.length <= 13);
        for (const view of tasks) {
          const task = field(view, 'task');
          const id = String(field(task, 'id'));
          const startTime = Number(field(task, 'startTime'));
          if (previous !== undefined) {
            assert.ok(
              startTime < previous.startTime || (startTime === previous.startTime && id < previous.id),
              'newest-first stable order',
            );
          }
          previous = { startTime, id };
          assert.equal(seenIds.includes(id), false);
          seenIds.push(id);
        }
        cursor = page['nextCursor'] ?? undefined;
        pages += 1;
        assert.ok(pages <= 20);
      } while (cursor !== undefined);
      assert.deepEqual([...seenIds].sort(), [...ids].sort());
      const other = await createHarness();
      try {
        other.ready();
        const otherClient = new Client(other.bus);
        await otherClient.subscribe();
        const firstPage = ok(await client.call('list', { limit: 1 }));
        assert.equal(
          errorCode(await otherClient.call('list', { cursor: firstPage['nextCursor'] })),
          'INVALID_CURSOR',
        );
      } finally {
        await other.dispose();
      }
    } finally {
      await h.dispose();
    }
  });

  void it('bounds list previews explicitly, returns full detail and refuses oversize frames', async () => {
    const long = `printf ${'x'.repeat(2000)}`;
    const huge = `printf ${'y'.repeat(300 * 1024)}`;
    const port = createPortHarness([
      fakeTask('blong', { command: long, startTime: 2 }),
      fakeTask('bhuge', { command: huge, startTime: 1 }),
    ]);
    const client = new Client(port.bus);
    await client.subscribe();
    const page = ok(await client.call('list', { limit: 1 }));
    const view = (page['tasks'] as unknown[])[0];
    assert.deepEqual(field(view, 'truncatedFields'), ['command']);
    assert.ok(String(field(field(view, 'task'), 'command')).length <= 512);
    const detail = ok(await client.call('detail', { taskId: 'blong' }));
    assert.equal(field(field(detail['task'], 'task'), 'command'), long);
    assert.deepEqual(field(detail['task'], 'truncatedFields'), []);
    assert.equal(errorCode(await client.call('detail', { taskId: 'bhuge' })), 'TOO_LARGE');
    port.service.close();
  });

  void it('reads bounded UTF-8-safe log windows and refuses missing output loudly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-host-log-'));
    try {
      const file = join(root, 'task.output');
      await writeFile(file, Buffer.from('αβγ-host-baseline-ok', 'utf8'));
      const tailWindow = await readHostLogWindow(file, 4, true);
      assert.equal(tailWindow.text, 'e-ok');
      assert.equal(tailWindow.bytesRead, 4);
      const split = await readHostLogWindow(file, 5, false);
      assert.equal(split.text, 'αβ', 'a head window never splits a multi-byte character');
      assert.equal(split.windowEnd, 4);
      const lead = await readHostLogWindow(file, Buffer.byteLength('γ-host-baseline-ok') + 1, true);
      assert.equal(lead.text, 'γ-host-baseline-ok', 'a tail window skips a split leading character');
      assert.equal(lead.windowStart, Buffer.byteLength('αβ'));
      const port = createPortHarness([
        fakeTask('blog', { outputAbsPath: file }),
        fakeTask('bmissing', { outputAbsPath: join(root, 'missing.output') }),
      ]);
      const client = new Client(port.bus);
      await client.subscribe();
      const logs = ok(await client.call('logs', { taskId: 'blog', maxBytes: 4 }));
      assert.equal(logs['text'], 'e-ok');
      assert.equal(logs['truncated'], true);
      assert.equal(logs['totalBytes'], Buffer.byteLength('αβγ-host-baseline-ok'));
      assert.equal(errorCode(await client.call('logs', { taskId: 'bmissing' })), 'LOG_UNAVAILABLE');
      port.service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('stops a frozen selection only, reports finished races and never pre-acknowledges running work', async () => {
    const h = await createHarness();
    try {
      h.ready();
      const done = await h.registry.startTask(h.ctx, 'printf done', { name: 'Done', isAgent: false });
      h.children.at(-1)?.emit('close', 0, null);
      await waitFor(() => done.status === 'completed', 'completion');
      const original = await h.registry.startTask(h.ctx, 'sleep 90', { name: 'Original', isAgent: false });
      const newer = await h.registry.startTask(h.ctx, 'sleep 90', { name: 'Newer', isAgent: false });
      const client = new Client(h.bus);
      await client.subscribe();
      assert.equal(ok(await client.call('stop', { taskId: done.id }))['alreadyTerminal'], true);
      const marks = ok(await client.call('mark_seen', { taskIds: [original.id, done.id, 'bmissing'] }));
      assert.deepEqual(
        (marks['results'] as unknown[]).map((entry) => field(entry, 'outcome')),
        ['not_terminal', 'marked', 'not_found'],
      );
      assert.equal(h.seen.has(original.id), false);
      const all = ok(await client.call('stop_all', { taskIds: [original.id, done.id, 'bnone'] }));
      assert.deepEqual(
        (all['results'] as unknown[]).map((entry) => field(entry, 'outcome')),
        ['stopped', 'already_terminal', 'not_found'],
      );
      assert.equal(original.status, 'killed');
      assert.equal(newer.status, 'running', 'stop_all never rescans for newer tasks');
      const detail = ok(await client.call('detail', { taskId: original.id }));
      assert.equal(field(detail['task'], 'seen'), false);
      const stopped = ok(await client.call('stop', { taskId: newer.id }));
      assert.equal(stopped['alreadyTerminal'], false);
      assert.equal(field(stopped['task'], 'status'), 'killed');
    } finally {
      await h.dispose();
    }
  });

  void it('refuses rerun for typed and agent work', async () => {
    const port = createPortHarness([
      fakeTask('bagent', { isAgent: true }),
      fakeTask('battested', { isAgent: true, eventsAbsPath: '/nonexistent/battested.pi-events.jsonl' }),
      fakeTask('bmanaged', { managedCancel: () => {} }),
    ]);
    const client = new Client(port.bus);
    await client.subscribe();
    for (const taskId of ['bagent', 'battested', 'bmanaged']) {
      assert.equal(errorCode(await client.call('rerun', { taskId })), 'NOT_RERUNNABLE');
    }
    const kinds = ok(await client.call('list'));
    assert.deepEqual(
      (kinds['tasks'] as unknown[]).map((view) => [field(view, 'kind'), field(view, 'canRerun')]).sort(),
      [
        ['agent-shell', false],
        ['attested', false],
        ['managed', false],
      ],
    );
    assert.equal(errorCode(await client.call('result', { taskId: 'bagent' })), 'NO_RESULT');
    port.service.close();
  });

  void it('bounds in-flight work and never reports success after closure', async () => {
    const tasks = Array.from({ length: HOST_MAX_IN_FLIGHT + 1 }, (_, index) =>
      fakeTask(`brun${String(index)}`, { status: 'running', startTime: index }),
    );
    const port = createPortHarness(tasks);
    const client = new Client(port.bus);
    await client.subscribe();
    const pending: Array<Promise<Frame>> = [];
    for (let index = 0; index < HOST_MAX_IN_FLIGHT; index += 1) {
      pending.push(client.call('stop', { taskId: `brun${String(index)}` }));
    }
    await waitFor(() => port.service.inFlight === HOST_MAX_IN_FLIGHT, 'in-flight saturation');
    assert.equal(errorCode(await client.call('stop', { taskId: `brun${String(HOST_MAX_IN_FLIGHT)}` })), 'BUSY');
    const releaseFirst = port.holdStops.shift();
    releaseFirst?.();
    assert.equal(ok(await (pending[0] ?? Promise.reject(new Error('missing'))))['alreadyTerminal'], false);
    port.service.close();
    assert.equal(port.bus.count(HOST_REQUEST_CHANNEL), 0, 'closure removes the request listener');
    for (const release of port.holdStops.splice(0)) release();
    const late = await Promise.all(pending.slice(1));
    for (const frame of late) assert.equal(errorCode(frame), 'CLOSED');
    port.service.invalidate();
    assert.equal(port.service.changePending, false);
  });

  void it('isolates throwing change listeners from registry state and records the failure', async () => {
    const h = await createHarness({ coalesceMs: 1 });
    try {
      h.ready();
      const client = new Client(h.bus);
      await client.subscribe();
      const off = h.bus.on(HOST_CHANGED_CHANNEL, () => {
        throw new Error('consumer failure');
      });
      const task = await h.registry.startTask(h.ctx, 'printf ok', { name: 'Isolated', isAgent: false });
      h.children.at(-1)?.emit('close', 0, null);
      await waitFor(() => task.status === 'completed', 'completion despite listener failure');
      await waitFor(() => h.service.publicationFailures > 0, 'recorded publication failure');
      off();
      const page = ok(await client.call('list'));
      assert.equal(page['revision'], h.service.revision, 'list resynchronizes the current revision');
    } finally {
      await h.dispose();
    }
  });

  void it('closes once with a closed frame and loses authority', async () => {
    const h = await createHarness();
    h.ready();
    const client = new Client(h.bus);
    await client.subscribe();
    h.service.close();
    h.service.close();
    assert.equal(h.changes.filter((frame) => frame['kind'] === 'closed').length, 1);
    assert.equal(h.service.state, 'closed');
    assert.equal(h.service.leaseCount, 0);
    assert.equal(h.bus.count(HOST_REQUEST_CHANNEL), 0);
    await rm(h.root, { recursive: true, force: true });
  });
});
