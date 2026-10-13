// Independent supervisor-owned planc entrypoint. Offline, no model calls, complete bounded logs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const lane = process.argv[2];
if (lane !== "feature" && lane !== "guard") throw new Error("Choose feature or guard");
const evidence = "/Users/lizavasilyeva/work/paseo-env/bg-jobs/judge-logs";
mkdirSync(evidence, { recursive: true });
const logs = mkdtempSync(path.join(evidence, lane + "-"));
const home = mkdtempSync(path.join(tmpdir(), "pi-bg-host-judge-"));
mkdirSync(path.join(home, "agent"));
const env = {
  PATH: process.env.PATH,
  SHELL: "/bin/zsh",
  TMPDIR: process.env.TMPDIR,
  LANG: "en_US.UTF-8",
  HOME: home,
  PI_CODING_AGENT_DIR: path.join(home, "agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  CI: "1",
  npm_config_cache: "/Users/lizavasilyeva/work/paseo-env/npm",
  npm_config_offline: "true",
};
console.log(`Host API ${lane} logs: ${logs}`);
const receipt = [];
function step(name, command, args, timeout = 600000) {
  const file = path.join(logs, name + ".log");
  const fd = openSync(file, "w");
  const started = Date.now();
  const outcome = spawnSync(command, args, {
    env,
    stdio: ["ignore", fd, fd],
    timeout,
    killSignal: "SIGKILL",
  });
  closeSync(fd);
  const ok = outcome.error === undefined && outcome.signal === null && outcome.status === 0;
  receipt.push({
    name,
    ok,
    exit: outcome.status,
    signal: outcome.signal,
    error: outcome.error?.message,
    elapsedMs: Date.now() - started,
    file,
  });
  writeFileSync(path.join(logs, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok)
    console.log(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /Error|FAIL|error:|expected|actual|✖/.test(line))
        .slice(-12)
        .map((line) => line.slice(0, 350))
        .join("\n"),
    );
  return ok;
}
if (
  !step("offline-install", "npm", [
    "ci",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ])
)
  throw new Error("HARNESS_PREPARATION_FAILED offline install");
if (!step("compiled-runtime", "npm", ["run", "build:runtime"]))
  throw new Error("HARNESS_PREPARATION_FAILED compiled runtime");
if (lane === "feature") {
  process.exitCode = step("host-api", process.execPath, [
    "--import",
    "tsx",
    "tests/oracle/host-api.mjs",
  ])
    ? 0
    : 1;
} else {
  const checks = [
    ["typecheck", "npm", ["run", "typecheck"]],
    ["type-safety", "npm", ["run", "test:type-safety"]],
    [
      "v1-ui-sdk-rpc",
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-force-exit",
        "--test-concurrency=1",
        "tests/unit/extension-api.test.ts",
        "tests/component/background-tasks-manager.test.ts",
        "tests/sdk/sdk.test.ts",
        "tests/sdk/lifecycle-sdk.test.ts",
        "tests/sdk/feature-selection-sdk.test.ts",
        "tests/rpc/rpc.test.ts",
      ],
    ],
    [
      "terminal-pty",
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-force-exit",
        "--test-concurrency=1",
        "tests/pty/pty.test.ts",
      ],
    ],
    [
      "typed-fixtures",
      process.execPath,
      ["--import", "tsx", "tests/oracle/host-api.mjs", "--fixtures-only"],
    ],
  ];
  let failed = 0;
  for (const [name, command, args] of checks) if (!step(name, command, args)) failed += 1;
  process.exitCode = failed === 0 ? 0 : 1;
}
