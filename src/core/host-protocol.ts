import type { BgTaskSnapshot, TaskStatus } from './common.js';
import type { FusionFailureResultView } from './fusion/types.js';

/**
 * Versioned optional host interface (`pi-background-tasks:host:*:v1`).
 *
 * This module is pure: closed frame types, input validation, bounded error
 * text, opaque activation-scoped cursors and canonical request identity. It has
 * no registry, filesystem, timer or EventBus side effects. The public v1
 * request/response/terminal service in `extension-api.ts` is unrelated and
 * unchanged.
 */

export const HOST_REQUEST_CHANNEL = 'pi-background-tasks:host:request:v1';
export const HOST_RESPONSE_CHANNEL = 'pi-background-tasks:host:response:v1';
export const HOST_CHANGED_CHANNEL = 'pi-background-tasks:host:changed:v1';
export const HOST_REQUEST_SCHEMA = 'pi-background-tasks.host-request.v1';
export const HOST_RESPONSE_SCHEMA = 'pi-background-tasks.host-response.v1';
export const HOST_CHANGED_SCHEMA = 'pi-background-tasks.host-changed.v1';

export const HOST_API_VERSION = 1;
export const HOST_MAX_PAGE_SIZE = 50;
export const HOST_DEFAULT_PAGE_SIZE = 50;
export const HOST_MAX_LOG_BYTES = 65536;
export const HOST_DEFAULT_LOG_BYTES = 32768;
export const HOST_MAX_INLINE_RESULT_BYTES = 49152;
export const HOST_MAX_FRAME_BYTES = 256 * 1024;
export const HOST_MAX_ERROR_CHARS = 512;
export const HOST_MAX_REQUEST_ID_CHARS = 200;
export const HOST_MAX_CLIENT_ID_CHARS = 128;
export const HOST_MAX_TASK_ID_CHARS = 128;
export const HOST_MAX_CURSOR_CHARS = 512;
export const HOST_MAX_TASK_IDS = 1000;
export const HOST_MAX_LEASES = 8;
export const HOST_REPLAY_CACHE_SIZE = 64;
export const HOST_MAX_IN_FLIGHT = 16;
export const HOST_CHANGE_COALESCE_MS = 100;
/** List previews bound these free-text fields and name every bounded field explicitly. */
export const HOST_LIST_PREVIEW_CHARS = 512;

export type BackgroundTaskHostOperation =
  | 'capabilities'
  | 'subscribe'
  | 'unsubscribe'
  | 'list'
  | 'detail'
  | 'logs'
  | 'stop'
  | 'stop_all'
  | 'rerun'
  | 'result'
  | 'mark_seen';

export const HOST_OPERATIONS = [
  'capabilities',
  'subscribe',
  'unsubscribe',
  'list',
  'detail',
  'logs',
  'stop',
  'stop_all',
  'rerun',
  'result',
  'mark_seen',
] as const satisfies readonly BackgroundTaskHostOperation[];

export interface BackgroundTaskHostCapabilities {
  api_version: 1;
  operations: BackgroundTaskHostOperation[];
  max_page_size: number;
  max_log_bytes: number;
  max_inline_result_bytes: number;
}

export const HOST_CAPABILITIES = Object.freeze({
  api_version: 1,
  operations: HOST_OPERATIONS,
  max_page_size: HOST_MAX_PAGE_SIZE,
  max_log_bytes: HOST_MAX_LOG_BYTES,
  max_inline_result_bytes: HOST_MAX_INLINE_RESULT_BYTES,
});

export function hostCapabilities(): BackgroundTaskHostCapabilities {
  return {
    api_version: HOST_API_VERSION,
    operations: [...HOST_OPERATIONS],
    max_page_size: HOST_MAX_PAGE_SIZE,
    max_log_bytes: HOST_MAX_LOG_BYTES,
    max_inline_result_bytes: HOST_MAX_INLINE_RESULT_BYTES,
  };
}

export type HostErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_OPERATION'
  | 'UNAVAILABLE'
  | 'CLOSED'
  | 'LEASE_INVALID'
  | 'LEASE_LIMIT'
  | 'ACTIVATION_MISMATCH'
  | 'STALE_REQUEST'
  | 'CONFLICT'
  | 'BUSY'
  | 'NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'NOT_RERUNNABLE'
  | 'NO_RESULT'
  | 'RESULT_INVALID'
  | 'LOG_UNAVAILABLE'
  | 'TOO_LARGE'
  | 'OPERATION_FAILED';

export interface HostErrorBody {
  code: HostErrorCode;
  message: string;
}

/** Typed host failure. Callers branch on `code`, never on message text. */
export class HostApiError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostApiError';
    this.code = code;
  }
}

export function boundedHostErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const text = raw.replace(/\s+/gu, ' ').trim();
  const nonEmpty = text.length > 0 ? text : 'unspecified host error';
  if (nonEmpty.length <= HOST_MAX_ERROR_CHARS) return nonEmpty;
  return `${nonEmpty.slice(0, HOST_MAX_ERROR_CHARS - 1)}…`;
}

export function hostErrorBody(error: unknown, fallback: HostErrorCode = 'OPERATION_FAILED'): HostErrorBody {
  if (error instanceof HostApiError) {
    return { code: error.code, message: boundedHostErrorMessage(error.message) };
  }
  return { code: fallback, message: boundedHostErrorMessage(error) };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface HostLeaseFields {
  leaseId: string;
  activationId: string;
  sequence: number;
}

export interface HostSubscribePayload {
  clientId: string;
}

export interface HostListPayload extends HostLeaseFields {
  cursor?: string;
  limit?: number;
}

export interface HostTaskIdPayload extends HostLeaseFields {
  taskId: string;
}

export interface HostLogsPayload extends HostTaskIdPayload {
  maxBytes?: number;
  tail?: boolean;
}

export interface HostTaskIdsPayload extends HostLeaseFields {
  taskIds: string[];
}

export type HostLeasedRequest =
  | { operation: 'unsubscribe'; payload: HostLeaseFields }
  | { operation: 'list'; payload: HostListPayload }
  | { operation: 'detail'; payload: HostTaskIdPayload }
  | { operation: 'logs'; payload: HostLogsPayload }
  | { operation: 'stop'; payload: HostTaskIdPayload }
  | { operation: 'stop_all'; payload: HostTaskIdsPayload }
  | { operation: 'rerun'; payload: HostTaskIdPayload }
  | { operation: 'result'; payload: HostTaskIdPayload }
  | { operation: 'mark_seen'; payload: HostTaskIdsPayload };

export type HostRequestBody =
  | { operation: 'capabilities'; payload: Record<string, never> }
  | { operation: 'subscribe'; payload: HostSubscribePayload }
  | HostLeasedRequest;

export interface ParsedHostRequest {
  requestId: string;
  body: HostRequestBody;
  /** Canonical identity of request_id, operation and normalized payload. */
  fingerprint: string;
}

export type HostParseResult =
  | { ok: true; request: ParsedHostRequest }
  | { ok: false; requestId: string; operation: string; error: HostErrorBody };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type HostTaskKind = 'shell' | 'agent-shell' | 'delegate' | 'fusion' | 'attested' | 'managed';
export type HostTruncatedField = 'command' | 'description' | 'error';

export interface HostTaskCounts {
  running: number;
  completed: number;
  failed: number;
  killed: number;
  unseenCompleted: number;
  unseenFailed: number;
  unseenKilled: number;
  total: number;
}

export interface HostTaskView {
  task: BgTaskSnapshot;
  kind: HostTaskKind;
  seen: boolean;
  canRerun: boolean;
  canReadResult: boolean;
  truncatedFields: HostTruncatedField[];
}

export interface HostActivationFacts {
  activationId: string;
  sessionId: string;
  revision: number;
  observedAt: number;
  counts: HostTaskCounts;
}

export interface HostSubscribeResult extends HostActivationFacts {
  leaseId: string;
}

export interface HostUnsubscribeResult {
  leaseId: string;
  released: true;
}

export interface HostListResult extends HostActivationFacts {
  tasks: HostTaskView[];
  nextCursor: string | null;
}

export interface HostDetailResult {
  task: HostTaskView;
}

export interface HostLogsResult {
  task: BgTaskSnapshot;
  path: string;
  text: string;
  tail: boolean;
  maxBytes: number;
  bytesRead: number;
  totalBytes: number;
  windowStart: number;
  windowEnd: number;
  truncated: boolean;
  bytesWritten: number;
}

export interface HostStopResult {
  task: BgTaskSnapshot;
  alreadyTerminal: boolean;
}

export type HostStopAllOutcome = 'stopped' | 'already_terminal' | 'not_found' | 'failed';

export interface HostStopAllEntry {
  taskId: string;
  outcome: HostStopAllOutcome;
  status?: TaskStatus;
  error?: string;
}

export interface HostStopAllResult {
  results: HostStopAllEntry[];
  stopped: number;
  alreadyTerminal: number;
  notFound: number;
  failed: number;
}

export interface HostRerunResult {
  sourceTaskId: string;
  task: BgTaskSnapshot;
}

export type HostResultKind = 'delegate' | 'fusion';

export interface HostRunningResultView {
  taskId: string;
  kind: HostResultKind;
  state: 'running';
  delivery: 'none';
}

export interface HostCommittedResultView {
  taskId: string;
  kind: HostResultKind;
  state: 'committed';
  delivery: 'inline' | 'artifact';
  answerBytes: number;
  answerSha256: string;
  artifactPath: string;
  text?: string;
}

export interface HostNoAnswerResultView {
  taskId: string;
  kind: HostResultKind;
  state: 'failed' | 'cancelled';
  delivery: 'none';
  errorCode?: string;
  message?: string;
  fusionFailure?: FusionFailureResultView;
}

export type HostResultView = HostRunningResultView | HostCommittedResultView | HostNoAnswerResultView;

export type HostMarkSeenOutcome = 'marked' | 'already_seen' | 'not_terminal' | 'not_found';

export interface HostMarkSeenEntry {
  taskId: string;
  outcome: HostMarkSeenOutcome;
}

export interface HostMarkSeenResult {
  results: HostMarkSeenEntry[];
  revision: number;
  counts: HostTaskCounts;
}

export type HostOperationResult =
  | BackgroundTaskHostCapabilities
  | HostSubscribeResult
  | HostUnsubscribeResult
  | HostListResult
  | HostDetailResult
  | HostLogsResult
  | HostStopResult
  | HostStopAllResult
  | HostRerunResult
  | HostResultView
  | HostMarkSeenResult;

export type HostResponseFrame =
  | {
      schema_version: typeof HOST_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: true;
      result: HostOperationResult;
    }
  | {
      schema_version: typeof HOST_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: false;
      error: HostErrorBody;
    };

export type HostChangedKind = 'ready' | 'changed' | 'closed';

export interface HostChangedFrame extends HostActivationFacts {
  schema_version: typeof HOST_CHANGED_SCHEMA;
  kind: HostChangedKind;
}

export function hostSuccessFrame(
  requestId: string,
  operation: string,
  result: HostOperationResult,
): HostResponseFrame {
  return {
    schema_version: HOST_RESPONSE_SCHEMA,
    request_id: requestId,
    operation,
    ok: true,
    result,
  };
}

export function hostErrorFrame(
  requestId: string,
  operation: string,
  error: HostErrorBody,
): HostResponseFrame {
  return {
    schema_version: HOST_RESPONSE_SCHEMA,
    request_id: requestId,
    operation,
    ok: false,
    error: { code: error.code, message: boundedHostErrorMessage(error.message) },
  };
}

/**
 * Serialize one outgoing frame. Every frame is bounded; an oversize success is
 * replaced by a typed TOO_LARGE error rather than a quietly incomplete value.
 */
export function serializeHostResponse(frame: HostResponseFrame): string {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') <= HOST_MAX_FRAME_BYTES) return text;
  return JSON.stringify(
    hostErrorFrame(frame.request_id, frame.operation, {
      code: 'TOO_LARGE',
      message: `${frame.operation} response exceeds the ${String(HOST_MAX_FRAME_BYTES)}-byte frame bound; request a smaller page, window or the artifact reference`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new HostApiError('INVALID_REQUEST', message);
}

function own(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertClosed(record: JsonRecord, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) invalid(`${label} contains unknown key ${key}`);
  }
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) invalid(`${label} must be at most ${String(maximum)} characters`);
  return value;
}

function requireTaskId(value: unknown, label: string): string {
  const taskId = requireBoundedString(value, label, HOST_MAX_TASK_ID_CHARS);
  if (taskId.trim() !== taskId) invalid(`${label} must be an exact task id without whitespace`);
  return taskId;
}

function requireIntegerInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function parseLeaseFields(payload: JsonRecord, label: string): HostLeaseFields {
  const leaseId = requireBoundedString(payload['leaseId'], `${label}.leaseId`, 128);
  const activationId = requireBoundedString(payload['activationId'], `${label}.activationId`, 128);
  const sequence = requireIntegerInRange(
    payload['sequence'],
    `${label}.sequence`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  return { leaseId, activationId, sequence };
}

function parseTaskIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array of exact task ids`);
  if (value.length < 1 || value.length > HOST_MAX_TASK_IDS) {
    invalid(`${label} must contain 1 to ${String(HOST_MAX_TASK_IDS)} task ids`);
  }
  const ids: string[] = [];
  const unique = new Set<string>();
  value.forEach((entry: unknown, index: number) => {
    const id = requireTaskId(entry, `${label}[${String(index)}]`);
    if (unique.has(id)) invalid(`${label} contains duplicate task id ${id}`);
    unique.add(id);
    ids.push(id);
  });
  return ids;
}

const LEASE_KEYS = ['leaseId', 'activationId', 'sequence'] as const;

function parseBody(operation: BackgroundTaskHostOperation, rawPayload: unknown): HostRequestBody {
  const label = `${operation}.payload`;
  const payload = requireRecord(rawPayload, label);
  switch (operation) {
    case 'capabilities':
      assertClosed(payload, [], label);
      return { operation, payload: {} };
    case 'subscribe':
      assertClosed(payload, ['clientId'], label);
      return {
        operation,
        payload: {
          clientId: requireBoundedString(
            payload['clientId'],
            `${label}.clientId`,
            HOST_MAX_CLIENT_ID_CHARS,
          ),
        },
      };
    case 'unsubscribe':
      assertClosed(payload, LEASE_KEYS, label);
      return { operation, payload: parseLeaseFields(payload, label) };
    case 'list': {
      assertClosed(payload, [...LEASE_KEYS, 'cursor', 'limit'], label);
      const parsed: HostListPayload = parseLeaseFields(payload, label);
      if (own(payload, 'cursor')) {
        parsed.cursor = requireBoundedString(
          payload['cursor'],
          `${label}.cursor`,
          HOST_MAX_CURSOR_CHARS,
        );
      }
      if (own(payload, 'limit')) {
        parsed.limit = requireIntegerInRange(
          payload['limit'],
          `${label}.limit`,
          1,
          HOST_MAX_PAGE_SIZE,
        );
      }
      return { operation, payload: parsed };
    }
    case 'detail':
    case 'stop':
    case 'rerun':
    case 'result':
      assertClosed(payload, [...LEASE_KEYS, 'taskId'], label);
      return {
        operation,
        payload: {
          ...parseLeaseFields(payload, label),
          taskId: requireTaskId(payload['taskId'], `${label}.taskId`),
        },
      };
    case 'logs': {
      assertClosed(payload, [...LEASE_KEYS, 'taskId', 'maxBytes', 'tail'], label);
      const parsed: HostLogsPayload = {
        ...parseLeaseFields(payload, label),
        taskId: requireTaskId(payload['taskId'], `${label}.taskId`),
      };
      if (own(payload, 'maxBytes')) {
        parsed.maxBytes = requireIntegerInRange(
          payload['maxBytes'],
          `${label}.maxBytes`,
          1,
          HOST_MAX_LOG_BYTES,
        );
      }
      if (own(payload, 'tail')) parsed.tail = requireBoolean(payload['tail'], `${label}.tail`);
      return { operation, payload: parsed };
    }
    case 'stop_all':
    case 'mark_seen':
      assertClosed(payload, [...LEASE_KEYS, 'taskIds'], label);
      return {
        operation,
        payload: {
          ...parseLeaseFields(payload, label),
          taskIds: parseTaskIds(payload['taskIds'], `${label}.taskIds`),
        },
      };
  }
}

function isHostOperation(value: unknown): value is BackgroundTaskHostOperation {
  return typeof value === 'string' && HOST_OPERATIONS.some((operation) => operation === value);
}

function echo(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0) return 'malformed';
  return value.length <= maximum ? value : 'malformed';
}

/** Stable JSON for plain validated values: object keys sorted, arrays ordered. */
export function canonicalHostJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalHostJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalHostJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function serializedInputBytes(data: unknown): number | undefined {
  try {
    const text = JSON.stringify(data);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Parse and bound one untrusted request frame. Never throws. */
export function parseHostRequest(data: unknown): HostParseResult {
  if (!isRecord(data)) {
    return {
      ok: false,
      requestId: 'malformed',
      operation: 'malformed',
      error: { code: 'INVALID_REQUEST', message: 'request frame must be an object' },
    };
  }
  const requestId = echo(data['request_id'], HOST_MAX_REQUEST_ID_CHARS);
  const operationEcho = echo(data['operation'], 64);
  const fail = (code: HostErrorCode, message: string): HostParseResult => ({
    ok: false,
    requestId,
    operation: operationEcho,
    error: { code, message: boundedHostErrorMessage(message) },
  });
  const bytes = serializedInputBytes(data);
  if (bytes === undefined) return fail('INVALID_REQUEST', 'request frame must be plain JSON data');
  if (bytes > HOST_MAX_FRAME_BYTES) {
    return fail(
      'TOO_LARGE',
      `request frame exceeds the ${String(HOST_MAX_FRAME_BYTES)}-byte frame bound`,
    );
  }
  try {
    assertClosed(data, ['schema_version', 'request_id', 'operation', 'payload'], 'request');
    if (data['schema_version'] !== HOST_REQUEST_SCHEMA) {
      invalid(`request.schema_version must be ${HOST_REQUEST_SCHEMA}`);
    }
    const parsedRequestId = requireBoundedString(
      data['request_id'],
      'request.request_id',
      HOST_MAX_REQUEST_ID_CHARS,
    );
    const operation = data['operation'];
    if (!isHostOperation(operation)) {
      return fail(
        'UNKNOWN_OPERATION',
        `request.operation must be one of ${HOST_OPERATIONS.join(', ')}`,
      );
    }
    if (!own(data, 'payload')) invalid('request.payload is required');
    const body = parseBody(operation, data['payload']);
    return {
      ok: true,
      request: {
        requestId: parsedRequestId,
        body,
        fingerprint: canonicalHostJson({
          request_id: parsedRequestId,
          operation,
          payload: body.payload,
        }),
      },
    };
  } catch (error) {
    if (error instanceof HostApiError) return fail(error.code, error.message);
    return fail('INVALID_REQUEST', boundedHostErrorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Opaque activation-scoped keyset cursors
// ---------------------------------------------------------------------------

export interface HostCursorPosition {
  startTime: number;
  id: string;
}

const CURSOR_PREFIX = 'c1.';

export function encodeHostCursor(activationId: string, position: HostCursorPosition): string {
  const body = Buffer.from(
    JSON.stringify([activationId, position.startTime, position.id]),
    'utf8',
  ).toString('base64url');
  return `${CURSOR_PREFIX}${body}`;
}

export function decodeHostCursor(activationId: string, cursor: string): HostCursorPosition {
  const reject = (): never => {
    throw new HostApiError(
      'INVALID_CURSOR',
      'cursor is not a valid list cursor for this activation; restart paging from the first page',
    );
  };
  if (!cursor.startsWith(CURSOR_PREFIX)) reject();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    reject();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) reject();
  const tuple: unknown[] = Array.isArray(parsed) ? parsed : [];
  const [cursorActivation, startTime, id] = tuple;
  if (
    cursorActivation !== activationId ||
    typeof startTime !== 'number' ||
    !Number.isFinite(startTime) ||
    typeof id !== 'string' ||
    id.length === 0
  ) {
    reject();
  }
  return { startTime: Number(startTime), id: String(id) };
}

/** Stable newest-first order: start time descending, then id descending. */
export function compareNewestFirst(left: HostCursorPosition, right: HostCursorPosition): number {
  if (left.startTime !== right.startTime) return right.startTime - left.startTime;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}
