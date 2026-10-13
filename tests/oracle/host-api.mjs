// Supervisor-owned independent host API acceptance. No implementation worker may edit this file.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installFusionFakePi } from "../helpers/fusion-fake-pi.ts";

const root = await mkdtemp(path.join(tmpdir(), "pi-bg-host-oracle-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
await mkdir(cwd);
await mkdir(agentDir);
const events = createEventBus();
const errors = [];
const changes = [];
const terminals = new Map();
const waiters = new Map();
const offChanged = events.on("pi-background-tasks:host:changed:v1", (frame) => changes.push(frame));
const offTerminal = events.on("pi-background-tasks:terminal:v1", (frame) => {
  assert.equal(frame.schema_version, "pi-background-tasks.extension-terminal.v1");
  terminals.set(frame.task.id, frame.task);
  const resolve = waiters.get(frame.task.id);
  if (resolve) {
    waiters.delete(frame.task.id);
    resolve(frame.task);
  }
});
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_BG_HOST_ORACLE_KEY = "local-test-key-no-inference";
const delegateChild = path.join(root, "delegate-child.cjs");
await writeFile(
  delegateChild,
  await readFile(path.resolve("tests/oracle/host-delegate-child.cjs")),
);
await chmod(delegateChild, 0o700);
const fakeChild = await installFusionFakePi(root, {
  delegatePi: delegateChild,
  mergedText: "UI verified answer.",
  delayMs: 200,
});
process.env.PATH = fakeChild.env.PATH;
const settingsManager = SettingsManager.inMemory({
  defaultProvider: "pi-bg-host-oracle",
  defaultModel: "scripted",
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  eventBus: events,
  additionalExtensionPaths: [path.resolve("dist/extensions/background-tasks.js")],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  noThemes: true,
});
await loader.reload();
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: null,
});
const models = new ModelRegistry(modelRuntime);
models.registerProvider("pi-bg-host-oracle", {
  name: "No-inference host oracle",
  baseUrl: "https://example.invalid",
  apiKey: "PI_BG_HOST_ORACLE_KEY",
  api: "openai-responses",
  models: [
    {
      id: "scripted",
      name: "Scripted",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 4096,
    },
  ],
});
const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader: loader,
  settingsManager,
  modelRuntime,
  sessionManager: SessionManager.inMemory(cwd),
  noTools: "builtin",
});
const model = models.find("pi-bg-host-oracle", "scripted");
assert.notEqual(model, undefined);
await session.setModel(model);
async function tool(name, input) {
  const definition = session.getToolDefinition(name);
  assert.notEqual(definition, undefined, `Missing real registered tool ${name}`);
  return definition.execute(
    randomUUID(),
    input,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
}
async function launchFusion(prompt) {
  const before = new Set(result(await request("v1", "status", {})).tasks.map((task) => task.id));
  const command = session.extensionRunner
    .getRegisteredCommands()
    .find((item) => item.invocationName === "fusion");
  assert.notEqual(command, undefined, "Missing real Fusion command");
  await command.handler(prompt, session.extensionRunner.createCommandContext());
  const added = result(await request("v1", "status", {})).tasks.filter(
    (task) => !before.has(task.id),
  );
  assert.equal(added.length, 1, "Fusion command must register exactly one real task");
  const task = added[0];
  assert.equal(task.triggerOnCompletion, false, "User command fixture must not wake inference");
  assert.notEqual(task.fusion, undefined);
  return { details: { task, artifact_dir: task.fusion.artifactDir } };
}
async function fingerprint(directory) {
  const entries = await readdir(directory, { recursive: true });
  const out = [];
  for (const entry of entries.sort()) {
    const file = path.join(directory, entry);
    const info = await stat(file);
    if (!info.isFile()) continue;
    out.push({
      path: entry,
      mtime: info.mtimeMs,
      hash: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
  }
  return out;
}

function request(version, operation, payload, requestId = randomUUID()) {
  const host = version === "host";
  const channel = host ? "pi-background-tasks:host" : "pi-background-tasks";
  const schema = host ? "pi-background-tasks.host" : "pi-background-tasks.extension";
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `Missing ${version} ${operation} response: host feature not implemented or not initialized`,
        ),
      );
    }, 12000);
    off = events.on(`${channel}:response:v1`, (frame) => {
      if (frame.request_id !== requestId) return;
      clearTimeout(timer);
      off();
      try {
        assert.equal(frame.schema_version, `${schema}-response.v1`);
        assert.equal(frame.operation, operation);
        assert.equal(typeof frame.ok, "boolean");
        resolve(frame);
      } catch (error) {
        reject(error);
      }
    });
    events.emit(`${channel}:request:v1`, {
      schema_version: `${schema}-request.v1`,
      request_id: requestId,
      operation,
      payload,
    });
  });
}
function result(frame) {
  assert.equal(frame.ok, true, JSON.stringify(frame));
  return frame.result;
}
async function terminal(id) {
  if (terminals.has(id)) return terminals.get(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`No terminal event for ${id}`));
    }, 15000);
    waiters.set(id, (task) => {
      clearTimeout(timer);
      resolve(task);
    });
  });
}
async function launch(name, command = "sleep 90", extra = {}) {
  return result(
    await request("v1", "run", {
      name,
      command,
      isAgent: false,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
      ...extra,
    }),
  );
}
let lease;
let sequence = 0;
async function host(operation, extra = {}, identity = {}) {
  assert.notEqual(lease, undefined);
  sequence += 1;
  return request("host", operation, {
    leaseId: lease.leaseId,
    activationId: lease.activationId,
    sequence,
    ...extra,
    ...identity,
  });
}
let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}
try {
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const v1 = result(await request("v1", "capabilities", {}));
  assert.deepEqual(v1, {
    api_version: 1,
    run: true,
    run_is_agent: true,
    run_completion_trigger: true,
    status: true,
    logs: true,
    logs_bounded: true,
    kill: true,
  });
  const primitive = await launch("Baseline primitive", "printf host-baseline-ok");
  assert.equal((await terminal(primitive.id)).status, "completed");
  assert.equal(await readFile(path.join(cwd, primitive.outputPath), "utf8"), "host-baseline-ok");
  pass("unchanged v1 and actual shell lifecycle are healthy before the new feature");

  if (process.argv[2] === "--fixtures-only") {
    const fusion = await launchFusion("Fixture prerequisite");
    assert.equal((await terminal(fusion.details.task.id)).status, "completed");
    const answer = await tool("bg_result", { taskId: fusion.details.task.id, delivery: "inline" });
    assert.equal(answer.details.state, "committed");
    assert.equal(
      answer.content.some(
        (part) => part.type === "text" && part.text.endsWith("UI verified answer."),
      ),
      true,
    );
    assert.equal(typeof answer.usage, "object");
    pass("existing compiled Fusion launch and verified result fixture");
    const delegated = await tool("bg_delegate", {
      name: "Fixture delegate",
      prompt: "original directive",
      route: { provider: "pi-bg-host-oracle", model: "scripted" },
      notifyOnCompletion: false,
      triggerOnCompletion: false,
      autoDeliver: "never",
    });
    assert.equal((await terminal(delegated.details.task.id)).status, "completed");
    const delegatedAnswer = await tool("bg_result", {
      taskId: delegated.details.task.id,
      delivery: "inline",
    });
    assert.equal(delegatedAnswer.details.state, "committed");
    assert.equal(
      delegatedAnswer.content.some(
        (part) =>
          part.type === "text" &&
          part.text.endsWith("DELEGATE VERIFIED ANSWER: original directive"),
      ),
      true,
    );
    pass("existing compiled delegate launch and verified result fixture");
    await installFusionFakePi(root, { delegatePi: delegateChild, mergedText: "λ".repeat(26000) });
    const large = await launchFusion("Oversize fixture prerequisite");
    assert.equal((await terminal(large.details.task.id)).status, "completed");
    assert.equal(
      (await tool("bg_result", { taskId: large.details.task.id })).details.delivery,
      "artifact",
    );
    await installFusionFakePi(root, { delegatePi: delegateChild, failStage: "candidate" });
    const failed = await launchFusion("Failure fixture prerequisite");
    assert.equal((await terminal(failed.details.task.id)).status, "failed");
    assert.equal(
      (await tool("bg_result", { taskId: failed.details.task.id })).details.delivery,
      "none",
    );
    pass("oversize and failed result fixtures already work without the proposed API");
  } else {
    assert.equal(process.argv[2], undefined, "Only explicit fixture-prerequisite mode is accepted");
    const capabilities = result(await request("host", "capabilities", {}));
    assert.equal(capabilities.api_version, 1);
    assert.equal(capabilities.max_page_size, 50);
    assert.equal(capabilities.max_log_bytes, 65536);
    assert.equal(capabilities.max_inline_result_bytes, 49152);
    assert.deepEqual(
      [...capabilities.operations].sort(),
      [
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
        "mark_seen",
      ].sort(),
    );
    lease = result(await request("host", "subscribe", { clientId: "independent-oracle" }));
    assert.equal(typeof lease.leaseId, "string");
    assert.notEqual(lease.leaseId, "");
    assert.equal(lease.sessionId, session.sessionManager.getSessionId());
    assert.equal(
      result(await request("host", "subscribe", { clientId: "independent-oracle" })).leaseId,
      lease.leaseId,
    );
    assert.equal((await request("host", "capabilities", { command: "not-an-api" })).ok, false);
    assert.equal((await request("host", "run", { command: "printf unauthorized" })).ok, false);
    pass("separate closed host capability handshake and real session binding");

    const beforeReads = JSON.stringify(session.sessionManager.getEntries());
    const page = result(await host("list", { limit: 1 }));
    assert.equal(page.tasks.length, 1);
    assert.equal(page.tasks[0].task.id, primitive.id);
    assert.equal(page.tasks[0].kind, "shell");
    assert.equal(page.tasks[0].seen, false);
    assert.equal(page.tasks[0].canRerun, true);
    assert.equal(page.tasks[0].canReadResult, false);
    const detail = result(await host("detail", { taskId: primitive.id }));
    assert.equal(detail.task.task.command, "printf host-baseline-ok");
    assert.equal(detail.task.task.model, undefined);
    assert.equal(detail.task.task.tokenUsage, undefined);
    const logs = result(await host("logs", { taskId: primitive.id, maxBytes: 4, tail: true }));
    assert.equal(logs.text, "e-ok");
    assert.equal(logs.truncated, true);
    assert.equal(logs.bytesRead, 4);
    assert.equal(JSON.stringify(session.sessionManager.getEntries()), beforeReads);
    for (const bad of [0, -1, 65537, null, "4"])
      assert.equal((await host("logs", { taskId: primitive.id, maxBytes: bad })).ok, false);
    assert.equal((await host("logs", { taskId: primitive.id, path: "/etc/passwd" })).ok, false);
    assert.equal((await host("detail", { taskId: primitive.id.slice(0, 4) })).ok, false);
    assert.equal(
      (await host("detail", { taskId: primitive.id }, { activationId: "foreign" })).ok,
      false,
    );
    assert.equal(
      (await host("detail", { taskId: primitive.id }, { leaseId: "foreign" })).ok,
      false,
    );
    pass(
      "bounded exact-task reads, unavailable telemetry, no transcript mutation, foreign/invalid refusal",
    );

    result(await host("mark_seen", { taskIds: [primitive.id] }));
    assert.equal(result(await host("detail", { taskId: primitive.id })).task.seen, true);
    assert.equal(result(await host("stop", { taskId: primitive.id })).alreadyTerminal, true);
    const running = await launch("Confirmed original");
    result(await host("mark_seen", { taskIds: [running.id] }));
    assert.equal(result(await host("detail", { taskId: running.id })).task.seen, false);
    const newer = await launch("Do not stop this newer task");
    result(await host("stop_all", { taskIds: [running.id] }));
    assert.equal((await terminal(running.id)).status, "killed");
    assert.equal(result(await host("detail", { taskId: newer.id })).task.task.status, "running");
    assert.equal(result(await host("detail", { taskId: running.id })).task.seen, false);
    result(await host("stop", { taskId: newer.id }));
    pass("frozen stop-all selection, finish race, and no premature completion acknowledgement");

    const rerunSource = await launch("Rerun source", "sleep 90", { timeoutSeconds: 120 });
    sequence += 1;
    const rerunPayload = {
      leaseId: lease.leaseId,
      activationId: lease.activationId,
      sequence,
      taskId: rerunSource.id,
    };
    const rerunFrame = await request("host", "rerun", rerunPayload, "rerun-identity");
    const rerun = result(rerunFrame);
    assert.notEqual(rerun.task.id, rerunSource.id);
    assert.equal(rerun.task.command, rerunSource.command);
    assert.equal(rerun.task.timeoutSeconds, 120);
    assert.equal(rerun.task.notifyOnCompletion, true);
    assert.equal(rerun.task.triggerOnCompletion, false);
    assert.deepEqual(await request("host", "rerun", rerunPayload, "rerun-identity"), rerunFrame);
    for (let i = 0; i < 80; i += 1) result(await host("list"));
    const replay = await request("host", "rerun", rerunPayload, "rerun-identity");
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, "STALE_REQUEST");
    const existing = result(await request("v1", "status", {})).tasks.filter(
      (task) => task.name === "Rerun source",
    );
    assert.equal(existing.length, 2, "replayed or evicted operation must never spawn a third task");
    result(await host("stop_all", { taskIds: existing.map((task) => task.id) }));
    const agentShell = await launch("Agent shell", "sleep 90", { isAgent: true });
    assert.equal(result(await host("detail", { taskId: agentShell.id })).task.kind, "agent-shell");
    assert.equal((await host("rerun", { taskId: agentShell.id })).ok, false);
    result(await host("stop", { taskId: agentShell.id }));
    pass("new-identity ordinary shell rerun, bounded replay fence, and agent-shell refusal");

    const many = [];
    for (let i = 0; i < 105; i += 1) many.push(await launch(`Page task ${i}`));
    const observed = new Set();
    let cursor;
    let pages = 0;
    do {
      const response = result(
        await host("list", { limit: 13, ...(cursor === undefined ? {} : { cursor }) }),
      );
      assert.equal(response.counts.running, 105);
      assert.equal(response.tasks.length <= 13, true);
      for (const view of response.tasks) {
        assert.equal(observed.has(view.task.id), false);
        observed.add(view.task.id);
      }
      cursor = response.nextCursor ?? undefined;
      pages += 1;
      assert.equal(pages <= 20, true, "pagination must terminate");
    } while (cursor !== undefined);
    for (const task of many)
      assert.equal(observed.has(task.id), true, `missing running task ${task.id}`);
    assert.equal(pages >= 9, true);
    result(await host("stop_all", { taskIds: many.map((task) => task.id) }));
    for (const task of many) assert.equal((await terminal(task.id)).status, "killed");
    pass("all 105 simultaneous real processes remain reachable through bounded pages");

    const fusionLaunch = await launchFusion("Return the deterministic test answer");
    const fusionId = fusionLaunch.details.task.id;
    const pendingResult = result(await host("result", { taskId: fusionId }));
    assert.equal(pendingResult.state, "running");
    assert.equal(pendingResult.delivery, "none");
    assert.equal((await terminal(fusionId)).status, "completed");
    assert.equal(result(await host("detail", { taskId: fusionId })).task.kind, "fusion");
    assert.equal((await host("rerun", { taskId: fusionId })).ok, false);
    const fusionDirectory = path.join(cwd, fusionLaunch.details.artifact_dir);
    const filesBefore = await fingerprint(fusionDirectory);
    const transcriptBeforeResult = JSON.stringify(session.sessionManager.getEntries());
    const view = result(await host("result", { taskId: fusionId }));
    assert.equal(view.state, "committed");
    assert.equal(view.delivery, "inline");
    assert.equal(view.text, "UI verified answer.");
    assert.equal(view.answerBytes, Buffer.byteLength(view.text));
    assert.equal(view.answerSha256, createHash("sha256").update(view.text).digest("hex"));
    assert.deepEqual(await fingerprint(fusionDirectory), filesBefore);
    assert.equal(JSON.stringify(session.sessionManager.getEntries()), transcriptBeforeResult);
    assert.equal(
      result(await request("v1", "status", { taskId: fusionId })).tasks[0].fusion.usageDelivered,
      false,
    );
    const firstModelResult = await tool("bg_result", { taskId: fusionId, delivery: "inline" });
    assert.equal(typeof firstModelResult.usage, "object");
    assert.equal(
      (await tool("bg_result", { taskId: fusionId, delivery: "inline" })).usage,
      undefined,
    );
    await writeFile(path.join(fusionDirectory, "merged.md"), "TAMPERED");
    assert.equal((await host("result", { taskId: fusionId })).ok, false);
    pass(
      "verified Fusion read is transcript/file/usage-neutral; model claim stays once-only; tamper refused",
    );

    const delegateLaunch = await tool("bg_delegate", {
      name: "Delegate result",
      prompt: "original directive",
      route: { provider: "pi-bg-host-oracle", model: "scripted" },
      notifyOnCompletion: false,
      triggerOnCompletion: false,
      autoDeliver: "never",
    });
    const delegateId = delegateLaunch.details.task.id;
    assert.equal((await terminal(delegateId)).status, "completed");
    const delegateDetail = result(await host("detail", { taskId: delegateId })).task;
    assert.equal(delegateDetail.kind, "delegate");
    assert.equal(delegateDetail.canRerun, false);
    assert.equal((await host("rerun", { taskId: delegateId })).ok, false);
    const delegateDirectory = delegateDetail.task.delegate.artifactDirAbs;
    delegateDetail.task.delegate.route.model = "mutated-returned-view";
    assert.equal(
      result(await request("v1", "status", { taskId: delegateId })).tasks[0].delegate.route.model,
      "scripted",
      "host views must not expose mutable engine facts",
    );
    const delegateBefore = await fingerprint(delegateDirectory);
    const delegateView = result(await host("result", { taskId: delegateId }));
    assert.equal(delegateView.text, "DELEGATE VERIFIED ANSWER: original directive");
    assert.deepEqual(
      await fingerprint(delegateDirectory),
      delegateBefore,
      "UI must not rewrite outcome.json",
    );
    await writeFile(path.join(delegateDirectory, "result.json"), "{}");
    assert.equal((await host("result", { taskId: delegateId })).ok, false);
    pass("delegate read reuses integrity checks without writing adjudication");

    const hugeText = "λ".repeat(26000);
    await installFusionFakePi(root, { delegatePi: delegateChild, mergedText: hugeText });
    const hugeLaunch = await launchFusion("Oversize answer witness");
    const hugeId = hugeLaunch.details.task.id;
    assert.equal((await terminal(hugeId)).status, "completed");
    const hugeView = result(await host("result", { taskId: hugeId }));
    assert.equal(hugeView.delivery, "artifact");
    assert.equal(hugeView.text, undefined);
    assert.equal(hugeView.answerBytes, Buffer.byteLength(hugeText));
    assert.equal(hugeView.answerSha256, createHash("sha256").update(hugeText).digest("hex"));
    assert.equal(typeof hugeView.artifactPath, "string");
    await installFusionFakePi(root, { delegatePi: delegateChild, failStage: "candidate" });
    const failedLaunch = await launchFusion("Failed answer witness");
    assert.equal((await terminal(failedLaunch.details.task.id)).status, "failed");
    const failedView = result(await host("result", { taskId: failedLaunch.details.task.id }));
    assert.equal(failedView.state, "failed");
    assert.equal(failedView.delivery, "none");
    assert.equal(failedView.text, undefined);
    pass("oversize answers are artifacts, failed work exposes no partial answer");

    const priorLease = lease;
    result(await host("unsubscribe"));
    assert.equal((await host("list")).ok, false);
    lease = result(await request("host", "subscribe", { clientId: "independent-oracle" }));
    assert.notEqual(lease.leaseId, priorLease.leaseId);
    sequence = 0;
    assert.equal((await host("list", {}, { leaseId: priorLease.leaseId })).ok, false);
    const survivorLaunch = await tool("bg_run", {
      name: "Reload survivor",
      command: "sleep 90",
      isAgent: false,
      surviveReload: true,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    const survivor = survivorLaunch.details.task;
    const survivorRerun = result(await host("rerun", { taskId: survivor.id })).task;
    assert.equal(survivorRerun.surviveReload, true);
    assert.notEqual(survivorRerun.id, survivor.id);
    assert.notEqual(survivorRerun.pid, survivor.pid);
    const previousActivation = lease.activationId;
    await session.reload();
    lease = result(await request("host", "subscribe", { clientId: "after-reload" }));
    sequence = 0;
    assert.notEqual(lease.activationId, previousActivation);
    const reloaded = result(await host("list"));
    assert.equal(reloaded.counts.running, 2);
    for (const original of [survivor, survivorRerun]) {
      const current = result(await host("detail", { taskId: original.id })).task.task;
      assert.equal(current.pid, original.pid);
      assert.equal(current.outputPath, original.outputPath);
      assert.equal(current.surviveReload, true);
    }
    result(await host("stop_all", { taskIds: [survivor.id, survivorRerun.id] }));
    assert.equal(result(await host("list")).counts.running, 0);
    pass("UI rerun preserves opt-in same-process survivor identity through actual reload");
    assert.equal((await host("list", {}, { activationId: previousActivation })).ok, false);
    assert.equal(
      changes.some((frame) => frame.kind === "ready" && frame.activationId === lease.activationId),
      true,
    );
    assert.deepEqual(errors, []);
    pass("unsubscribed and replaced activations lose authority across real Pi reload");
  }
} finally {
  offChanged();
  offTerminal();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await rm(root, { recursive: true, force: true });
}
console.log(
  process.argv[2] === "--fixtures-only"
    ? `Host fixtures: ${passed}/4 groups passed (not host API acceptance)`
    : `Host API independent acceptance: ${passed}/11 groups passed`,
);
