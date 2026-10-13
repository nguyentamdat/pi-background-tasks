---
doc_id: api/eventbus-host-v1
audience: maintainer
mode: mixed
review_policy: behavioral
stability: evolving
covers_surfaces: [eventbus:background-task-host-v1]
covers_sources: [src/core/host-api.ts, src/core/host-protocol.ts, src/core/host-results.ts]
---
# Host interface EventBus API v1

<!-- pi-docs:begin name="eventbus-host-contract" generator="scripts/docs/generate.mjs" -->
Availability: `always`; available by default: **yes**.

| Channel purpose | Channel | Schema |
| --- | --- | --- |
| Request | `pi-background-tasks:host:request:v1` | `pi-background-tasks.host-request.v1` |
| Response | `pi-background-tasks:host:response:v1` | `pi-background-tasks.host-response.v1` |
| Changed | `pi-background-tasks:host:changed:v1` | `pi-background-tasks.host-changed.v1` |

Operations: `capabilities`, `detail`, `list`, `logs`, `mark_seen`, `rerun`, `result`, `stop`, `stop_all`, `subscribe`, `unsubscribe`.


```json
{
  "api_version": 1,
  "max_inline_result_bytes": 49152,
  "max_log_bytes": 65536,
  "max_page_size": 50,
  "operations": [
    "capabilities",
    "subscribe",
    "unsubscribe",
    "list",
    "detail",
    "logs",
    "stop",
    "stop_all",
    "rerun",
    "result",
    "mark_seen"
  ]
}
```
<!-- pi-docs:end name="eventbus-host-contract" -->

Optional, versioned host surface for native front ends (for example a desktop or mobile job panel) that need to list, inspect, follow, stop, rerun and read verified results of background tasks. It is separate from, and does not change, the [EventBus API v1](eventbus-v1.md) request/response/terminal service, the registered tools and commands, the dock, notifications or wake-up behavior. The package has no dependency on any particular host application.

Primary sources: `src/core/host-protocol.ts` (closed wire types, validation, bounds, cursors), `src/core/host-api.ts` (activation-scoped service over the real registry) and `src/core/host-results.ts` (deferred read-only verified result reader). Code is authoritative.

## Activation, readiness and leases

A service is created per extension activation and listens only on the request channel. `capabilities` is answered at any time while the activation is open. Every other operation needs an initialized session context: before the first `session_start` has supplied it, `subscribe` fails with `UNAVAILABLE`. A fresh initialized activation publishes exactly one `ready` change frame with a fresh `activationId`, so a consumer can discover it regardless of extension load order. The service never awaits another extension during a `session_start` dispatch.

`subscribe {clientId}` (1..128 chars) returns `{leaseId, activationId, sessionId, revision, observedAt, counts}`. Subscribing again with the same `clientId` in the same live activation returns the same lease. At most 8 leases are live (`LEASE_LIMIT`). `unsubscribe` disposes that exact lease; a later subscribe receives a fresh lease, and a released lease id never regains authority.

Every other operation carries `{leaseId, activationId, sequence}`. `sequence` is a positive safe integer strictly increasing per lease. The service tracks a per-lease high-water mark and a bounded cache of the last 64 completed responses:

- an identical replay (same `request_id`, operation and payload) of a cached sequence returns the identical frame without executing again;
- a different request with an already used sequence is `CONFLICT`;
- a sequence at or below the high-water mark whose response was evicted is `STALE_REQUEST` and is never executed again;
- at most 16 operations may be in flight per activation (`BUSY`, without consuming the sequence).

## Frames and bounds

Requests are closed objects `{schema_version, request_id, operation, payload}`; unknown keys, operations or value types fail. `request_id` is at most 200 characters. Responses are `{schema_version, request_id, operation, ok:true, result}` or `{…, ok:false, error:{code, message}}`; error messages are whitespace-compacted and at most 512 characters, and callers branch on `code`. No operation accepts a file path, process id or shell command.

Every response frame is bounded to 256 KiB. An oversize success is replaced by a typed `TOO_LARGE` error, never a quietly incomplete value. Emitted frames are fresh JSON values, so consumers cannot mutate registry state through a returned view.

Error codes: `INVALID_REQUEST`, `UNKNOWN_OPERATION`, `UNAVAILABLE`, `CLOSED`, `LEASE_INVALID`, `LEASE_LIMIT`, `ACTIVATION_MISMATCH`, `STALE_REQUEST`, `CONFLICT`, `BUSY`, `NOT_FOUND`, `INVALID_CURSOR`, `NOT_RERUNNABLE`, `NO_RESULT`, `RESULT_INVALID`, `LOG_UNAVAILABLE`, `TOO_LARGE`, `OPERATION_FAILED`.

## Operations

All task operations take exact task ids; prefixes are never resolved.

- `list {cursor?, limit?}` — `limit` 1..50, default 50. Stable newest-first order by start time then id, with an opaque keyset cursor scoped to the activation (`INVALID_CURSOR` otherwise). Every retained task is reachable by paging, including more than 100 running tasks; the finished-task retention bound is not a running-task cap. List previews bound `command`, `description` and `error` to 512 characters and name each bounded field in `truncatedFields`.
- `detail {taskId}` — one task view with complete strings, or `TOO_LARGE`.
- A task view is `{task, kind, seen, canRerun, canReadResult, truncatedFields}` where `kind` is `shell | agent-shell | delegate | fusion | attested | managed`. Task-owned telemetry and its unavailable reason are passed through unchanged; absent telemetry stays absent rather than becoming zero or a parent value.
- `logs {taskId, maxBytes?, tail?}` — `maxBytes` 1..65536 (default 32768), `tail` default `true`. Returns `{task, path, text, tail, maxBytes, bytesRead, totalBytes, windowStart, windowEnd, truncated, bytesWritten}`. Window edges never split a UTF-8 sequence; the exact returned byte range is reported. A missing or unreadable output file is `LOG_UNAVAILABLE`, not empty output. Text is untrusted output.
- `stop {taskId}` — stops through the registry and resolves only after actual terminal settlement; an already terminal task returns `alreadyTerminal:true`.
- `stop_all {taskIds}` — 1..1000 unique ids. Acts only on that frozen, confirmed selection (never a fresh registry scan) and returns per-task `stopped | already_terminal | not_found | failed` outcomes.
- `rerun {taskId}` — ordinary non-agent shell tasks only; other kinds return `NOT_RERUNNABLE` with owning-tool guidance. It re-admits the exact original command through the registry as a new task id, preserving name, description, timeout and `surviveReload`, with notification on and no automatic wake (the dock's user-initiated policy). Arbitrary shell commands are unsandboxed; no pattern-based safety claim is made.
- `result {taskId}` — delegate and Fusion tasks only (`NO_RESULT` otherwise). Running work returns `{state:"running", delivery:"none"}`. Failed or cancelled work returns a truthful no-answer state (`fusionFailure` carries the bounded, manifest-bound Fusion failure view). Committed work returns `{state:"committed", delivery:"inline"|"artifact", answerBytes, answerSha256, artifactPath, text?}`; text is included only up to 49,152 UTF-8 bytes, otherwise the artifact reference is returned and nothing is truncated. Integrity failures are `RESULT_INVALID`.
- `mark_seen {taskIds}` — shares the dock/footer seen set and marks only terminal tasks; viewing or marking a running task never acknowledges its future completion.

### Read-only verified results

Results reuse the existing verifiers. Delegate reads call the pure adjudication boundary exported from `src/core/delegate/runner.ts`, never the `evaluateDelegateTerminal` wrapper that writes `outcome.json`. Fusion reads use the manifest-bound readers and never claim the once-only usage accounting, so the first ordinary `bg_result` retrieval still receives usage exactly once. No tool result, message or session entry is produced. The reader module is loaded lazily on the first terminal result read, so process-only startup does not import delegate or Fusion verifiers.

## Change feed and lifecycle

Change frames `{schema_version, kind:"ready"|"changed"|"closed", activationId, sessionId, revision, observedAt, counts}` are small invalidations; consumers fetch data with `list`/`detail`. `counts` carries `running`, `completed`, `failed`, `killed`, `unseenCompleted`, `unseenFailed`, `unseenKilled` and `total` over all retained tasks. Revisions only advance.

Without leases the service arms no timers and builds no snapshots; registry and seen-state changes only advance the integer revision. With leases, changes are coalesced into at most one `changed` frame per 100 ms. Output byte growth alone does not invalidate; followers read `logs` deliberately (at most once a second while following) and the returned `bytesWritten` is current. Change publication is independent of the registry's durable terminal barrier and completion notifications: a throwing listener cannot change terminal truth. A failed change publication is counted and logged, never recorded as delivered; any `list` or `subscribe` response resynchronizes the current revision.

Session shutdown closes the service on the existing synchronous activation fence before any asynchronous cleanup: the request listener is removed, leases are disposed, a pending change timer is cleared and one `closed` frame is published. Requests first emitted after closure receive no response. A request admitted before closure can report failure (`CLOSED`) but never success. Reload creates a fresh service; opted same-process survivor tasks remain owned by the existing reload owner and appear in the fresh activation. Process restart does not resurrect or adopt tasks.
