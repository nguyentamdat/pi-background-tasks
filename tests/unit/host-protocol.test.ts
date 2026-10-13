import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CAPABILITIES,
  HOST_MAX_ERROR_CHARS,
  HOST_MAX_FRAME_BYTES,
  HOST_MAX_TASK_IDS,
  HOST_OPERATIONS,
  HOST_REQUEST_SCHEMA,
  HOST_RESPONSE_SCHEMA,
  boundedHostErrorMessage,
  canonicalHostJson,
  compareNewestFirst,
  decodeHostCursor,
  encodeHostCursor,
  hostCapabilities,
  hostSuccessFrame,
  parseHostRequest,
  serializeHostResponse,
  type HostParseResult,
} from '../../src/core/host-protocol.js';

function frame(operation: unknown, payload: unknown, extra: Record<string, unknown> = {}): unknown {
  return { schema_version: HOST_REQUEST_SCHEMA, request_id: 'r-1', operation, payload, ...extra };
}

const lease = { leaseId: 'lease-a', activationId: 'act-a', sequence: 1 };

function code(result: HostParseResult): string {
  assert.equal(result.ok, false, 'expected a rejected request');
  return result.ok ? '' : result.error.code;
}

void describe('host protocol validation', () => {
  void it('advertises exactly the frozen operations and bounds', () => {
    const first = hostCapabilities();
    const second = hostCapabilities();
    assert.notEqual(first.operations, second.operations, 'each response gets a fresh copy');
    assert.deepEqual(first, {
      api_version: 1,
      operations: [
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
      ],
      max_page_size: 50,
      max_log_bytes: 65536,
      max_inline_result_bytes: 49152,
    });
    assert.deepEqual([...HOST_CAPABILITIES.operations], [...HOST_OPERATIONS]);
  });

  void it('accepts closed well-formed frames and normalizes payloads', () => {
    const parsed = parseHostRequest(frame('logs', { ...lease, taskId: 'b1', maxBytes: 4, tail: false }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.request.body, {
      operation: 'logs',
      payload: { ...lease, taskId: 'b1', maxBytes: 4, tail: false },
    });
    const subscribe = parseHostRequest(frame('subscribe', { clientId: 'paseo' }));
    assert.ok(subscribe.ok);
    const capabilities = parseHostRequest(frame('capabilities', {}));
    assert.ok(capabilities.ok);
  });

  void it('rejects unknown keys, operations, schemas and malformed envelopes with typed codes', () => {
    assert.equal(code(parseHostRequest(frame('capabilities', { command: 'x' }))), 'INVALID_REQUEST');
    const unknown = parseHostRequest(frame('run', { command: 'printf x' }));
    assert.equal(code(unknown), 'UNKNOWN_OPERATION');
    assert.ok(!unknown.ok && unknown.operation === 'run' && unknown.requestId === 'r-1');
    assert.equal(code(parseHostRequest(frame('list', lease, { extra: 1 }))), 'INVALID_REQUEST');
    assert.equal(
      code(parseHostRequest({ ...(frame('list', lease) as object), schema_version: 'v0' })),
      'INVALID_REQUEST',
    );
    assert.equal(code(parseHostRequest('not a frame')), 'INVALID_REQUEST');
    assert.equal(
      code(parseHostRequest({ ...(frame('list', lease) as object), request_id: 'x'.repeat(201) })),
      'INVALID_REQUEST',
    );
    const cyclic: Record<string, unknown> = { ...lease };
    cyclic['self'] = cyclic;
    assert.equal(code(parseHostRequest(frame('list', cyclic))), 'INVALID_REQUEST');
    assert.equal(
      code(parseHostRequest(frame('list', { ...lease, cursor: 'x'.repeat(HOST_MAX_FRAME_BYTES) }))),
      'TOO_LARGE',
    );
  });

  void it('enforces exact numeric, task id and selection bounds', () => {
    for (const maxBytes of [0, -1, 65537, null, '4', 1.5]) {
      assert.equal(
        code(parseHostRequest(frame('logs', { ...lease, taskId: 'b1', maxBytes }))),
        'INVALID_REQUEST',
      );
    }
    for (const limit of [0, 51, 2.5]) {
      assert.equal(code(parseHostRequest(frame('list', { ...lease, limit }))), 'INVALID_REQUEST');
    }
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.equal(code(parseHostRequest(frame('list', { ...lease, sequence }))), 'INVALID_REQUEST');
    }
    assert.equal(code(parseHostRequest(frame('detail', { ...lease, taskId: ' b1' }))), 'INVALID_REQUEST');
    assert.equal(code(parseHostRequest(frame('detail', { ...lease, taskId: '' }))), 'INVALID_REQUEST');
    assert.equal(code(parseHostRequest(frame('logs', { ...lease, taskId: 'b1', path: '/etc/passwd' }))), 'INVALID_REQUEST');
    assert.equal(code(parseHostRequest(frame('stop_all', { ...lease, taskIds: [] }))), 'INVALID_REQUEST');
    assert.equal(code(parseHostRequest(frame('stop_all', { ...lease, taskIds: ['a', 'a'] }))), 'INVALID_REQUEST');
    const tooMany = Array.from({ length: HOST_MAX_TASK_IDS + 1 }, (_, index) => `b${String(index)}`);
    assert.equal(code(parseHostRequest(frame('mark_seen', { ...lease, taskIds: tooMany }))), 'INVALID_REQUEST');
    assert.equal(
      code(parseHostRequest(frame('subscribe', { clientId: 'c'.repeat(129) }))),
      'INVALID_REQUEST',
    );
  });

  void it('derives request identity from request id, operation and canonical payload', () => {
    const a = parseHostRequest(frame('list', { sequence: 1, activationId: 'act-a', leaseId: 'lease-a' }));
    const b = parseHostRequest(frame('list', lease));
    const c = parseHostRequest(frame('list', lease, { request_id: 'r-2' }));
    assert.ok(a.ok && b.ok && c.ok);
    assert.equal(a.request.fingerprint, b.request.fingerprint);
    assert.notEqual(b.request.fingerprint, c.request.fingerprint);
    assert.equal(canonicalHostJson({ b: [2, 1], a: { d: 1, c: null } }), '{"a":{"c":null,"d":1},"b":[2,1]}');
  });

  void it('scopes opaque cursors to one activation and orders newest first', () => {
    const cursor = encodeHostCursor('act-a', { startTime: 10, id: 'b2' });
    assert.deepEqual(decodeHostCursor('act-a', cursor), { startTime: 10, id: 'b2' });
    assert.throws(() => decodeHostCursor('act-b', cursor), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeHostCursor('act-a', 'c1.%%%'), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeHostCursor('act-a', 'opaque'), { code: 'INVALID_CURSOR' });
    const ordered = [
      { startTime: 1, id: 'a' },
      { startTime: 3, id: 'a' },
      { startTime: 3, id: 'b' },
      { startTime: 2, id: 'z' },
    ].sort(compareNewestFirst);
    assert.deepEqual(ordered, [
      { startTime: 3, id: 'b' },
      { startTime: 3, id: 'a' },
      { startTime: 2, id: 'z' },
      { startTime: 1, id: 'a' },
    ]);
  });

  void it('bounds errors and replaces oversize responses with a typed error frame', () => {
    assert.ok(boundedHostErrorMessage('x'.repeat(5000)).length <= HOST_MAX_ERROR_CHARS);
    assert.equal(boundedHostErrorMessage('  spaced\n\nout  '), 'spaced out');
    const oversize = hostSuccessFrame('r-9', 'detail', {
      sourceTaskId: 'b1',
      task: {
        id: 'b2',
        command: 'x'.repeat(HOST_MAX_FRAME_BYTES),
        status: 'running',
        outputPath: 'o',
        cwd: '/',
        startTime: 1,
        bytesWritten: 0,
        isAgent: false,
        surviveReload: false,
        notified: false,
        notifyOnCompletion: true,
        triggerOnCompletion: false,
      },
    });
    const parsed: unknown = JSON.parse(serializeHostResponse(oversize));
    assert.deepEqual(parsed, {
      schema_version: HOST_RESPONSE_SCHEMA,
      request_id: 'r-9',
      operation: 'detail',
      ok: false,
      error: {
        code: 'TOO_LARGE',
        message: `detail response exceeds the ${String(HOST_MAX_FRAME_BYTES)}-byte frame bound; request a smaller page, window or the artifact reference`,
      },
    });
  });
});
