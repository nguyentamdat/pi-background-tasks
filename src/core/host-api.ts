import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { BgTask, BgTaskSnapshot, StartTaskOptions } from './common.js';
import type { BackgroundTaskContext, BackgroundTaskRegistry } from './registry.js';
import {
  HOST_CHANGE_COALESCE_MS,
  HOST_CHANGED_CHANNEL,
  HOST_CHANGED_SCHEMA,
  HOST_DEFAULT_LOG_BYTES,
  HOST_DEFAULT_PAGE_SIZE,
  HOST_LIST_PREVIEW_CHARS,
  HOST_MAX_IN_FLIGHT,
  HOST_MAX_LEASES,
  HOST_REPLAY_CACHE_SIZE,
  HOST_REQUEST_CHANNEL,
  HOST_RESPONSE_CHANNEL,
  HostApiError,
  boundedHostErrorMessage,
  compareNewestFirst,
  decodeHostCursor,
  encodeHostCursor,
  hostCapabilities,
  hostErrorBody,
  hostErrorFrame,
  hostSuccessFrame,
  parseHostRequest,
  serializeHostResponse,
  type HostActivationFacts,
  type HostChangedFrame,
  type HostChangedKind,
  type HostDetailResult,
  type HostLeaseFields,
  type HostLeasedRequest,
  type HostListPayload,
  type HostListResult,
  type HostLogsPayload,
  type HostLogsResult,
  type HostMarkSeenEntry,
  type HostMarkSeenResult,
  type HostOperationResult,
  type HostRerunResult,
  type HostResponseFrame,
  type HostResultView,
  type HostStopAllEntry,
  type HostStopAllResult,
  type HostStopResult,
  type HostSubscribeResult,
  type HostTaskCounts,
  type HostTaskKind,
  type HostTaskView,
  type HostTruncatedField,
  type HostUnsubscribeResult,
  type ParsedHostRequest,
} from './host-protocol.js';

/**
 * Optional versioned host interface over the existing background-task registry.
 *
 * The service owns no second scheduler: every read and control goes through the
 * activation's real registry. It is activation-scoped. A fresh Pi activation
 * creates a fresh service with a fresh activation id, and `close()` is called on
 * the synchronous activation close fence before any asynchronous shutdown, so
 * old leases, cursors and late continuations lose authority.
 *
 * Without leases the service allocates no snapshots and arms no timers; an
 * invalidation only advances an integer revision. With leases, registry and
 * seen-state invalidations are coalesced into at most one small `changed`
 * frame per {@link HOST_CHANGE_COALESCE_MS} milliseconds. Change publication is
 * never coupled to registry terminal truth or completion notifications.
 */

export type BackgroundTaskHostServiceState = 'open' | 'closed';

/** The registry surface the host service needs; the real registry satisfies it. */
export type BackgroundTaskHostRegistryPort = Pick<
  BackgroundTaskRegistry,
  'allTasks' | 'snapshot' | 'stopTask' | 'startTask' | 'isShuttingDown'
>;

export interface BackgroundTaskHostServiceOptions {
  events: EventBus;
  registry: BackgroundTaskHostRegistryPort;
  getContext: () => BackgroundTaskContext | undefined;
  /** Shared terminal seen-set membership owned by the extension activation. */
  isSeen: (taskId: string) => boolean;
  /** Add exact terminal task ids to the shared seen set; the caller invalidates. */
  markSeen: (taskIds: readonly string[]) => void;
  /** Deferred, read-only verified result reader. */
  readResult: (task: BgTask) => Promise<HostResultView>;
  logger?: Pick<Console, 'error'> | undefined;
  now?: (() => number) | undefined;
  coalesceMs?: number | undefined;
}

export interface BackgroundTaskHostService {
  readonly state: BackgroundTaskHostServiceState;
  readonly activationId: string;
  readonly ready: boolean;
  readonly revision: number;
  readonly leaseCount: number;
  readonly inFlight: number;
  readonly changePending: boolean;
  readonly publicationFailures: number;
  /** Announce the initialized activation once; no effect before context or after close. */
  markReady(): void;
  /** Registry or seen-state change. Cheap and safe from any registry callback. */
  invalidate(): void;
  /** Synchronous, idempotent, permanent closure. */
  close(): void;
}

interface HostLease {
  readonly leaseId: string;
  readonly clientId: string;
  highWater: number;
  disposed: boolean;
  readonly completed: Map<number, { fingerprint: string; frame: string }>;
  readonly pending: Map<number, { fingerprint: string; replays: number }>;
}

export interface HostLogWindow {
  text: string;
  bytesRead: number;
  totalBytes: number;
  windowStart: number;
  windowEnd: number;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Exclusive end that does not split a trailing UTF-8 sequence. */
function completeUtf8End(buffer: Buffer, start: number, end: number): number {
  let index = end - 1;
  let inspected = 0;
  while (index >= start && inspected < 4) {
    const byte = buffer.readUInt8(index);
    if (!isUtf8Continuation(byte)) {
      return index + utf8SequenceLength(byte) <= end ? end : index;
    }
    index -= 1;
    inspected += 1;
  }
  return end;
}

/**
 * Read one bounded window of a task output file. Window boundaries never split
 * a UTF-8 sequence; the exact returned byte range is reported so a consumer can
 * see what was omitted. Bytes are untrusted text.
 */
export async function readHostLogWindow(
  absPath: string,
  maxBytes: number,
  tail: boolean,
): Promise<HostLogWindow> {
  const handle = await open(absPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const position = tail ? size - length : 0;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    let start = 0;
    if (position > 0) {
      while (start < filled && start < 3 && isUtf8Continuation(buffer.readUInt8(start))) {
        start += 1;
      }
    }
    const end = completeUtf8End(buffer, start, filled);
    const bytes = buffer.subarray(start, end);
    return {
      text: bytes.toString('utf8'),
      bytesRead: bytes.length,
      totalBytes: size,
      windowStart: position + start,
      windowEnd: position + end,
    };
  } finally {
    await handle.close();
  }
}

export function hostTaskKind(task: BgTask): HostTaskKind {
  if (task.fusion !== undefined) return 'fusion';
  if (task.delegate !== undefined) return 'delegate';
  if (task.attestedPi !== undefined || task.eventsAbsPath !== undefined) return 'attested';
  if (task.managedCancel !== undefined) return 'managed';
  return task.isAgent ? 'agent-shell' : 'shell';
}

const RERUN_GUIDANCE: Readonly<Record<Exclude<HostTaskKind, 'shell'>, string>> = {
  'agent-shell':
    'agent shell tasks launch model work and are not rerun from the host interface; start a new run through bg_run or /bg --agent',
  delegate: 'delegate tasks are typed workflows; relaunch through bg_delegate',
  fusion: 'Fusion tasks are typed workflows; relaunch through the owning Fusion tool or /fusion',
  attested: 'attested Pi tasks are evidence producers; relaunch through bg_run_pi_attested',
  managed: 'managed tasks are typed workflows; relaunch through their owning tool',
};

function previewText(
  value: string | undefined,
  field: HostTruncatedField,
  truncated: HostTruncatedField[],
): string | undefined {
  if (value === undefined || value.length <= HOST_LIST_PREVIEW_CHARS) return value;
  truncated.push(field);
  return `${value.slice(0, HOST_LIST_PREVIEW_CHARS - 1)}…`;
}

class InstalledBackgroundTaskHostService implements BackgroundTaskHostService {
  readonly activationId = `act-${randomBytes(16).toString('hex')}`;
  private readonly events: EventBus;
  private readonly registry: BackgroundTaskHostRegistryPort;
  private readonly getContext: () => BackgroundTaskContext | undefined;
  private readonly isSeen: (taskId: string) => boolean;
  private readonly markSeenIds: (taskIds: readonly string[]) => void;
  private readonly readResult: (task: BgTask) => Promise<HostResultView>;
  private readonly logger: Pick<Console, 'error'>;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly unsubscribeRequests: () => void;
  private readonly leases = new Map<string, HostLease>();
  private readonly clientLeases = new Map<string, string>();
  private serviceState: BackgroundTaskHostServiceState = 'open';
  private isReady = false;
  private sessionId: string | undefined;
  private currentRevision = 0;
  private lastChangedAt = 0;
  private changeTimer: NodeJS.Timeout | undefined;
  private inFlightCount = 0;
  private publicationFailureCount = 0;

  constructor(options: BackgroundTaskHostServiceOptions) {
    this.events = options.events;
    this.registry = options.registry;
    this.getContext = options.getContext;
    this.isSeen = options.isSeen;
    this.markSeenIds = options.markSeen;
    this.readResult = options.readResult;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.coalesceMs = options.coalesceMs ?? HOST_CHANGE_COALESCE_MS;
    this.unsubscribeRequests = this.events.on(HOST_REQUEST_CHANNEL, (data) => {
      this.handle(data);
    });
  }

  get state(): BackgroundTaskHostServiceState {
    return this.serviceState;
  }

  get ready(): boolean {
    return this.isReady;
  }

  get revision(): number {
    return this.currentRevision;
  }

  get leaseCount(): number {
    return this.leases.size;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  get changePending(): boolean {
    return this.changeTimer !== undefined;
  }

  get publicationFailures(): number {
    return this.publicationFailureCount;
  }

  markReady(): void {
    if (this.serviceState === 'closed' || this.isReady) return;
    const ctx = this.getContext();
    if (ctx?.sessionId === undefined || this.registry.isShuttingDown()) return;
    this.sessionId = ctx.sessionId;
    this.isReady = true;
    this.publishChange('ready');
  }

  invalidate(): void {
    if (this.serviceState === 'closed') return;
    this.currentRevision += 1;
    if (!this.isReady || this.leases.size === 0 || this.changeTimer !== undefined) return;
    const delay = Math.max(0, this.lastChangedAt + this.coalesceMs - this.now());
    const timer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.serviceState === 'closed' || this.leases.size === 0) return;
      this.publishChange('changed');
    }, delay);
    timer.unref();
    this.changeTimer = timer;
  }

  close(): void {
    if (this.serviceState === 'closed') return;
    const announce = this.isReady;
    this.serviceState = 'closed';
    if (this.changeTimer !== undefined) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
    }
    try {
      this.unsubscribeRequests();
    } catch (error) {
      this.logger.error(
        `[background-tasks] host interface listener removal failed: ${boundedHostErrorMessage(error)}`,
      );
    }
    for (const lease of this.leases.values()) lease.disposed = true;
    this.leases.clear();
    this.clientLeases.clear();
    if (announce) this.publishChange('closed');
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  private counts(): HostTaskCounts {
    const counts: HostTaskCounts = {
      running: 0,
      completed: 0,
      failed: 0,
      killed: 0,
      unseenCompleted: 0,
      unseenFailed: 0,
      unseenKilled: 0,
      total: 0,
    };
    for (const task of this.registry.allTasks()) {
      counts.total += 1;
      if (task.status === 'running') {
        counts.running += 1;
        continue;
      }
      const seen = this.isSeen(task.id);
      if (task.status === 'completed') {
        counts.completed += 1;
        if (!seen) counts.unseenCompleted += 1;
      } else if (task.status === 'failed') {
        counts.failed += 1;
        if (!seen) counts.unseenFailed += 1;
      } else {
        counts.killed += 1;
        if (!seen) counts.unseenKilled += 1;
      }
    }
    return counts;
  }

  private publishChange(kind: HostChangedKind): void {
    const sessionId = this.sessionId;
    if (sessionId === undefined) return;
    let frame: HostChangedFrame;
    try {
      frame = {
        schema_version: HOST_CHANGED_SCHEMA,
        kind,
        activationId: this.activationId,
        sessionId,
        revision: this.currentRevision,
        observedAt: this.now(),
        counts: this.counts(),
      };
    } catch (error) {
      this.publicationFailureCount += 1;
      this.logger.error(
        `[background-tasks] host ${kind} frame could not be prepared: ${boundedHostErrorMessage(error)}`,
      );
      return;
    }
    this.lastChangedAt = frame.observedAt;
    try {
      this.events.emit(HOST_CHANGED_CHANNEL, frame);
    } catch (error) {
      // Never recorded as delivered. Consumers resynchronize from any list or
      // subscribe response, which always carries the current revision.
      this.publicationFailureCount += 1;
      this.logger.error(
        `[background-tasks] host ${kind} frame publication failed (revision ${String(frame.revision)}): ${boundedHostErrorMessage(error)}`,
      );
    }
  }

  private emitText(text: string): void {
    try {
      this.events.emit(HOST_RESPONSE_CHANNEL, JSON.parse(text));
    } catch (error) {
      this.logger.error(
        `[background-tasks] host response emit failed: ${boundedHostErrorMessage(error)}`,
      );
    }
  }

  private emitFrame(frame: HostResponseFrame): void {
    this.emitText(serializeHostResponse(frame));
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private handle(data: unknown): void {
    if (this.serviceState === 'closed') return;
    const parsed = parseHostRequest(data);
    if (!parsed.ok) {
      this.emitFrame(hostErrorFrame(parsed.requestId, parsed.operation, parsed.error));
      return;
    }
    const request = parsed.request;
    const body = request.body;
    try {
      switch (body.operation) {
        case 'capabilities':
          this.emitFrame(hostSuccessFrame(request.requestId, body.operation, hostCapabilities()));
          return;
        case 'subscribe':
          this.emitFrame(
            hostSuccessFrame(request.requestId, body.operation, this.subscribe(body.payload.clientId)),
          );
          return;
        default:
          this.handleLeased(request, body);
          return;
      }
    } catch (error) {
      this.emitFrame(hostErrorFrame(request.requestId, body.operation, hostErrorBody(error)));
    }
  }

  private handleLeased(request: ParsedHostRequest, body: HostLeasedRequest): void {
    const lease = this.authorize(body.payload);
    const sequence = body.payload.sequence;
    if (sequence <= lease.highWater) {
      const completed = lease.completed.get(sequence);
      if (completed !== undefined) {
        if (completed.fingerprint !== request.fingerprint) {
          throw new HostApiError(
            'CONFLICT',
            `sequence ${String(sequence)} was already used by a different request on this lease`,
          );
        }
        this.emitText(completed.frame);
        return;
      }
      const pending = lease.pending.get(sequence);
      if (pending !== undefined) {
        if (pending.fingerprint !== request.fingerprint) {
          throw new HostApiError(
            'CONFLICT',
            `sequence ${String(sequence)} is in flight for a different request on this lease`,
          );
        }
        pending.replays += 1;
        return;
      }
      throw new HostApiError(
        'STALE_REQUEST',
        `sequence ${String(sequence)} is at or below this lease's high-water mark ${String(lease.highWater)} and its response is no longer retained; it was not executed again`,
      );
    }
    if (this.inFlightCount >= HOST_MAX_IN_FLIGHT) {
      throw new HostApiError(
        'BUSY',
        `at most ${String(HOST_MAX_IN_FLIGHT)} host operations may be in flight; retry with the same sequence after a response arrives`,
      );
    }
    lease.highWater = sequence;
    const pending = { fingerprint: request.fingerprint, replays: 0 };
    lease.pending.set(sequence, pending);
    this.inFlightCount += 1;
    const operation = this.execute(body, lease);
    void operation
      .then(
        (result): HostResponseFrame => hostSuccessFrame(request.requestId, body.operation, result),
        (error: unknown): HostResponseFrame =>
          hostErrorFrame(request.requestId, body.operation, hostErrorBody(error)),
      )
      .then((frame) => {
        this.settle(request, body, lease, sequence, pending, frame);
      });
  }

  private settle(
    request: ParsedHostRequest,
    body: HostLeasedRequest,
    lease: HostLease,
    sequence: number,
    pending: { fingerprint: string; replays: number },
    frame: HostResponseFrame,
  ): void {
    this.inFlightCount -= 1;
    lease.pending.delete(sequence);
    // A request admitted before closure may report failure, never success
    // from a closed activation.
    const finalFrame =
      this.serviceState === 'closed' && frame.ok
        ? hostErrorFrame(request.requestId, body.operation, {
            code: 'CLOSED',
            message:
              'the host interface activation closed before this request completed; subscribe to the current activation',
          })
        : frame;
    const text = serializeHostResponse(finalFrame);
    if (!lease.disposed && this.serviceState === 'open') {
      lease.completed.set(sequence, { fingerprint: pending.fingerprint, frame: text });
      while (lease.completed.size > HOST_REPLAY_CACHE_SIZE) {
        const oldest = lease.completed.keys().next();
        if (oldest.done === true) break;
        lease.completed.delete(oldest.value);
      }
    }
    for (let emitted = 0; emitted <= pending.replays; emitted += 1) this.emitText(text);
  }

  private authorize(fields: HostLeaseFields): HostLease {
    if (fields.activationId !== this.activationId) {
      throw new HostApiError(
        'ACTIVATION_MISMATCH',
        'activationId does not name the current host activation; subscribe again',
      );
    }
    const lease = this.leases.get(fields.leaseId);
    if (lease === undefined || lease.disposed) {
      throw new HostApiError('LEASE_INVALID', 'leaseId is not a live lease of this activation');
    }
    return lease;
  }

  private requireContext(): BackgroundTaskContext {
    if (this.serviceState === 'closed') {
      throw new HostApiError('CLOSED', 'the host interface activation is closed');
    }
    if (this.registry.isShuttingDown()) {
      throw new HostApiError('UNAVAILABLE', 'the background task activation is shutting down');
    }
    const ctx = this.getContext();
    if (!this.isReady || ctx === undefined) {
      throw new HostApiError(
        'UNAVAILABLE',
        'the background task host interface has no initialized session context yet; wait for its ready frame',
      );
    }
    return ctx;
  }

  private activationFacts(): HostActivationFacts {
    this.requireContext();
    const sessionId = this.sessionId;
    if (sessionId === undefined) {
      throw new HostApiError('UNAVAILABLE', 'the activation has no session identity');
    }
    return {
      activationId: this.activationId,
      sessionId,
      revision: this.currentRevision,
      observedAt: this.now(),
      counts: this.counts(),
    };
  }

  private subscribe(clientId: string): HostSubscribeResult {
    const facts = this.activationFacts();
    const existingId = this.clientLeases.get(clientId);
    const existing = existingId === undefined ? undefined : this.leases.get(existingId);
    if (existing !== undefined && !existing.disposed) return { ...facts, leaseId: existing.leaseId };
    if (this.leases.size >= HOST_MAX_LEASES) {
      throw new HostApiError(
        'LEASE_LIMIT',
        `at most ${String(HOST_MAX_LEASES)} host leases may be live in one activation`,
      );
    }
    const lease: HostLease = {
      leaseId: `lease-${randomBytes(16).toString('hex')}`,
      clientId,
      highWater: 0,
      disposed: false,
      completed: new Map(),
      pending: new Map(),
    };
    this.leases.set(lease.leaseId, lease);
    this.clientLeases.set(clientId, lease.leaseId);
    return { ...facts, leaseId: lease.leaseId };
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private async execute(body: HostLeasedRequest, lease: HostLease): Promise<HostOperationResult> {
    switch (body.operation) {
      case 'unsubscribe':
        return this.unsubscribeLease(lease);
      case 'list':
        return this.list(body.payload);
      case 'detail':
        return this.detail(body.payload.taskId);
      case 'logs':
        return this.logs(body.payload);
      case 'stop':
        return this.stop(body.payload.taskId);
      case 'stop_all':
        return this.stopAll(body.payload.taskIds);
      case 'rerun':
        return this.rerun(body.payload.taskId);
      case 'result':
        return this.result(body.payload.taskId);
      case 'mark_seen':
        return this.markSeen(body.payload.taskIds);
    }
  }

  private unsubscribeLease(lease: HostLease): HostUnsubscribeResult {
    lease.disposed = true;
    this.leases.delete(lease.leaseId);
    if (this.clientLeases.get(lease.clientId) === lease.leaseId) {
      this.clientLeases.delete(lease.clientId);
    }
    if (this.leases.size === 0 && this.changeTimer !== undefined) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
    }
    return { leaseId: lease.leaseId, released: true };
  }

  private findTask(taskId: string): BgTask {
    const task = this.registry.allTasks().find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw new HostApiError('NOT_FOUND', `no retained background task has exact id ${taskId}`);
    }
    return task;
  }

  private view(task: BgTask, preview: boolean): HostTaskView {
    const snapshot: BgTaskSnapshot = { ...this.registry.snapshot(task) };
    const truncatedFields: HostTruncatedField[] = [];
    if (preview) {
      snapshot.command = previewText(snapshot.command, 'command', truncatedFields) ?? '';
      snapshot.description = previewText(snapshot.description, 'description', truncatedFields);
      snapshot.error = previewText(snapshot.error, 'error', truncatedFields);
    }
    const kind = hostTaskKind(task);
    return {
      task: snapshot,
      kind,
      seen: task.status !== 'running' && this.isSeen(task.id),
      canRerun: kind === 'shell',
      canReadResult: kind === 'delegate' || kind === 'fusion',
      truncatedFields,
    };
  }

  private list(payload: HostListPayload): HostListResult {
    const facts = this.activationFacts();
    const limit = payload.limit ?? HOST_DEFAULT_PAGE_SIZE;
    const ordered = this.registry.allTasks().sort(compareNewestFirst);
    let start = 0;
    if (payload.cursor !== undefined) {
      const position = decodeHostCursor(this.activationId, payload.cursor);
      start = ordered.findIndex((task) => compareNewestFirst(task, position) > 0);
      if (start < 0) start = ordered.length;
    }
    const page = ordered.slice(start, start + limit);
    const last = page.at(-1);
    const nextCursor =
      start + limit < ordered.length && last !== undefined
        ? encodeHostCursor(this.activationId, { startTime: last.startTime, id: last.id })
        : null;
    return { ...facts, tasks: page.map((task) => this.view(task, true)), nextCursor };
  }

  private detail(taskId: string): HostDetailResult {
    this.requireContext();
    return { task: this.view(this.findTask(taskId), false) };
  }

  private async logs(payload: HostLogsPayload): Promise<HostLogsResult> {
    this.requireContext();
    const task = this.findTask(payload.taskId);
    const maxBytes = payload.maxBytes ?? HOST_DEFAULT_LOG_BYTES;
    const tail = payload.tail ?? true;
    if (!existsSync(task.outputAbsPath)) {
      throw new HostApiError(
        'LOG_UNAVAILABLE',
        `output file for ${task.id} does not exist (${task.outputPath}); the task has not produced an output file or it was removed`,
      );
    }
    let window: HostLogWindow;
    try {
      window = await readHostLogWindow(task.outputAbsPath, maxBytes, tail);
    } catch (error) {
      throw new HostApiError(
        'LOG_UNAVAILABLE',
        `output file for ${task.id} could not be read (${task.outputPath}): ${boundedHostErrorMessage(error)}`,
      );
    }
    return {
      task: this.registry.snapshot(task),
      path: task.outputPath,
      text: window.text,
      tail,
      maxBytes,
      bytesRead: window.bytesRead,
      totalBytes: window.totalBytes,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      truncated: window.windowStart > 0 || window.windowEnd < window.totalBytes,
      bytesWritten: task.bytesWritten,
    };
  }

  /** Stop one running task; resolves only after actual terminal settlement. */
  private async stopOne(task: BgTask): Promise<'stopped' | 'already_terminal'> {
    if (task.status !== 'running') return 'already_terminal';
    try {
      await this.registry.stopTask(task, 'user');
    } catch (error) {
      if (task.status !== 'running') return 'already_terminal';
      throw new HostApiError(
        'OPERATION_FAILED',
        `stopping ${task.id} failed: ${boundedHostErrorMessage(error)}`,
      );
    }
    if (task.status === 'running') {
      throw new HostApiError(
        'OPERATION_FAILED',
        `stopping ${task.id} returned before terminal settlement`,
      );
    }
    return 'stopped';
  }

  private async stop(taskId: string): Promise<HostStopResult> {
    this.requireContext();
    const task = this.findTask(taskId);
    const outcome = await this.stopOne(task);
    return { task: this.registry.snapshot(task), alreadyTerminal: outcome === 'already_terminal' };
  }

  private async stopAll(taskIds: readonly string[]): Promise<HostStopAllResult> {
    this.requireContext();
    // The frozen confirmed selection only; never a fresh registry-wide scan.
    const byId = new Map(this.registry.allTasks().map((task) => [task.id, task]));
    const results = await Promise.all(
      taskIds.map(async (taskId): Promise<HostStopAllEntry> => {
        const task = byId.get(taskId);
        if (task === undefined) return { taskId, outcome: 'not_found' };
        try {
          const outcome = await this.stopOne(task);
          return { taskId, outcome, status: task.status };
        } catch (error) {
          return {
            taskId,
            outcome: 'failed',
            status: task.status,
            error: boundedHostErrorMessage(error),
          };
        }
      }),
    );
    const count = (outcome: HostStopAllEntry['outcome']): number =>
      results.filter((entry) => entry.outcome === outcome).length;
    return {
      results,
      stopped: count('stopped'),
      alreadyTerminal: count('already_terminal'),
      notFound: count('not_found'),
      failed: count('failed'),
    };
  }

  private async rerun(taskId: string): Promise<HostRerunResult> {
    const ctx = this.requireContext();
    const source = this.findTask(taskId);
    const kind = hostTaskKind(source);
    if (kind !== 'shell') {
      throw new HostApiError('NOT_RERUNNABLE', `${source.id}: ${RERUN_GUIDANCE[kind]}`);
    }
    // Exact original command through real registry admission; a new identity.
    // The ordinary user-initiated dock policy applies: notification on, no wake.
    const options: StartTaskOptions = {
      name: source.name,
      isAgent: false,
      surviveReload: source.surviveReload === true,
      notifyOnCompletion: true,
      triggerOnCompletion: false,
    };
    if (source.description !== undefined) options.description = source.description;
    if (source.timeoutSeconds !== undefined) options.timeoutSeconds = source.timeoutSeconds;
    const task = await this.registry.startTask(ctx, source.command, options);
    return { sourceTaskId: source.id, task: this.registry.snapshot(task) };
  }

  private async result(taskId: string): Promise<HostResultView> {
    this.requireContext();
    const task = this.findTask(taskId);
    const kind = hostTaskKind(task);
    if (kind !== 'delegate' && kind !== 'fusion') {
      throw new HostApiError(
        'NO_RESULT',
        `${task.id} is a ${kind} task without a verified result; read its output with logs`,
      );
    }
    if (task.status === 'running') {
      return { taskId: task.id, kind, state: 'running', delivery: 'none' };
    }
    return this.readResult(task);
  }

  private markSeen(taskIds: readonly string[]): HostMarkSeenResult {
    this.requireContext();
    const byId = new Map(this.registry.allTasks().map((task) => [task.id, task]));
    const marked: string[] = [];
    const results = taskIds.map((taskId): HostMarkSeenEntry => {
      const task = byId.get(taskId);
      if (task === undefined) return { taskId, outcome: 'not_found' };
      // Viewing a running task can never pre-acknowledge its future completion.
      if (task.status === 'running') return { taskId, outcome: 'not_terminal' };
      if (this.isSeen(taskId)) return { taskId, outcome: 'already_seen' };
      marked.push(taskId);
      return { taskId, outcome: 'marked' };
    });
    if (marked.length > 0) this.markSeenIds(marked);
    return { results, revision: this.currentRevision, counts: this.counts() };
  }
}

export function installBackgroundTaskHostApi(
  options: BackgroundTaskHostServiceOptions,
): BackgroundTaskHostService {
  return new InstalledBackgroundTaskHostService(options);
}
