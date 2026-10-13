#!/usr/bin/env node
// Bounded offline checks for the optional host interface.
//
// Usage:
//   node tests/helpers/host-api-check.mjs --cache <npm-cache-dir> [--logs-root <dir>] [--mode <mode>]
//
// --cache      Required. Existing npm cache used for `npm ci --offline --ignore-scripts`.
//              The helper never contacts a registry and fails loudly when the cache is absent.
// --logs-root  Optional. Directory under which a fresh run directory with complete logs and a
//              receipt.json is created and preserved (default: the OS temporary directory).
// --mode       units (default): offline install, then the three focused host unit files.
//              round1: install, typecheck, type-safety, focused units, runtime build,
//                      docs:generate, docs:verify, docs tests, host SDK test, host packed test,
//                      then a read-only `git status` listing of changed paths for scope audit.
//              qa: install, build, typecheck, type-safety, then every unit, SDK, RPC,
//                  component and package test file, the hook-contract gate and payload check.
//              root: the supervisor-owned feature and guard acceptance lanes, then focused units.
//
// Steps run sequentially. Every subprocess has a hard timeout with SIGKILL and the summed bounds
// of a mode stay below four hours. Output goes to one log file per step; a failed required step
// (install, build) stops the run, other failures are reported and the run continues. The real
// exit status, signal or spawn error of each step is recorded and any failure makes the helper
// exit non-zero. Each step gets its own temporary HOME, removed afterwards; nothing else is
// deleted. Temporary paths use the canonical (realpath) OS temporary directory, which children
// also receive as TMPDIR/TMP/TEMP; an unresolvable temporary root fails the run loudly.
// No shell wrapper, global dependency change, network registry or model call is used.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60 * 1000;
const MAX_TOTAL_MS = 235 * MIN;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const node = process.execPath;
const HOST_UNIT_FILES = [
  'tests/unit/host-protocol.test.ts',
  'tests/unit/host-api.test.ts',
  'tests/unit/host-results.test.ts',
];

function nodeTest(files, timeout) {
  return {
    command: node,
    args: ['--import', 'tsx', '--test', '--test-force-exit', '--test-concurrency=1', ...files],
    timeout,
  };
}

const STEPS = {
  install: {
    command: 'npm',
    args: ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    timeout: 15 * MIN,
    required: true,
  },
  build: { command: 'npm', args: ['run', 'build:runtime'], timeout: 10 * MIN, required: true },
  typecheck: { command: 'npm', args: ['run', 'typecheck'], timeout: 10 * MIN },
  'type-safety': nodeTest(['tests/package/type-safety.test.ts'], 10 * MIN),
  'host-units': nodeTest(HOST_UNIT_FILES, 15 * MIN),
  'docs-generate': { command: 'npm', args: ['run', 'docs:generate'], timeout: 10 * MIN },
  'docs-verify': { command: 'npm', args: ['run', 'docs:verify'], timeout: 10 * MIN },
  'docs-tests': nodeTest(['tests/unit/docs-gate.test.ts', 'tests/package/docs-contract.test.ts'], 15 * MIN),
  'host-sdk': nodeTest(['tests/sdk/host-api-sdk.test.ts'], 20 * MIN),
  'host-packed': nodeTest(['tests/package/host-api-packed.test.ts'], 20 * MIN),
  'unit-all': nodeTest(['tests/unit/**/*.test.ts'], 30 * MIN),
  'sdk-all': nodeTest(['tests/sdk/**/*.test.ts'], 50 * MIN),
  'rpc-all': nodeTest(['tests/rpc/**/*.test.ts'], 30 * MIN),
  'component-all': nodeTest(['tests/component/**/*.test.ts'], 15 * MIN),
  'package-all': nodeTest(['tests/package/**/*.test.ts'], 40 * MIN),
  'hook-contract': nodeTest(['tests/scripted-provider/pi-hook-contract.test.ts'], 15 * MIN),
  payload: { command: 'npm', args: ['run', 'payload:check'], timeout: 10 * MIN },
  'root-feature': { command: node, args: ['tests/oracle/judge-host-api.mjs', 'feature'], timeout: 40 * MIN },
  'root-guard': { command: node, args: ['tests/oracle/judge-host-api.mjs', 'guard'], timeout: 90 * MIN },
  'worktree-status': {
    command: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    timeout: 2 * MIN,
    print: true,
  },
};

const MODES = {
  units: ['install', 'host-units'],
  round1: [
    'install',
    'typecheck',
    'type-safety',
    'host-units',
    'build',
    'docs-generate',
    'docs-verify',
    'docs-tests',
    'host-sdk',
    'host-packed',
    'worktree-status',
  ],
  qa: [
    'install',
    'build',
    'typecheck',
    'type-safety',
    'unit-all',
    'sdk-all',
    'rpc-all',
    'component-all',
    'package-all',
    'hook-contract',
    'payload',
  ],
  root: ['root-feature', 'root-guard', 'install', 'host-units'],
};

function usageError(message) {
  console.log(`host API check usage error: ${message}`);
  console.log(
    'usage: node tests/helpers/host-api-check.mjs --cache <npm-cache-dir> [--logs-root <dir>] [--mode units|round1|qa|root]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: 'units', cache: undefined, logsRoot: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--cache' && flag !== '--logs-root' && flag !== '--mode') {
      usageError(`unknown argument ${String(flag)}`);
    }
    if (value === undefined || value.startsWith('--')) usageError(`${flag} requires a value`);
    index += 1;
    if (flag === '--cache') options.cache = value;
    else if (flag === '--logs-root') options.logsRoot = value;
    else options.mode = value;
  }
  if (options.cache === undefined) usageError('--cache is required');
  if (!isAbsolute(options.cache)) usageError('--cache must be an absolute path');
  if (options.logsRoot !== undefined && !isAbsolute(options.logsRoot)) {
    usageError('--logs-root must be an absolute path');
  }
  if (MODES[options.mode] === undefined) usageError(`unknown mode ${options.mode}`);
  return options;
}

function interestingLines(text) {
  const lines = text.split('\n');
  const matched = lines.filter((line) =>
    /✖|not ok|error TS|AssertionError|Error:|expected|actual|FAIL|is stale/u.test(line),
  );
  return (matched.length > 0 ? matched : lines.slice(-8))
    .slice(0, 8)
    .map((line) => `  ${line.trim().slice(0, 170)}`);
}

const options = parseArgs(process.argv.slice(2));
let cacheStat;
try {
  cacheStat = statSync(options.cache);
} catch {
  cacheStat = undefined;
}
if (cacheStat === undefined || !cacheStat.isDirectory()) {
  console.log(`FAIL host API check: npm cache ${options.cache} is not an existing directory`);
  process.exit(1);
}
const steps = MODES[options.mode];
const totalBound = steps.reduce((sum, key) => sum + STEPS[key].timeout, 0);
if (totalBound > MAX_TOTAL_MS) {
  console.log(`FAIL host API check: mode ${options.mode} bounds exceed ${String(MAX_TOTAL_MS / MIN)} minutes`);
  process.exit(1);
}
// Canonical OS temporary root. Some platforms expose the temporary directory
// through a symlink alias (for example /tmp on macOS); tests that compare their
// own temporary paths with realpath-resolved paths must see the same canonical
// spelling, so children receive the resolved directory rather than the alias.
let tempRoot;
try {
  tempRoot = realpathSync(tmpdir());
  if (!statSync(tempRoot).isDirectory()) throw new Error('not a directory');
} catch (error) {
  console.log(
    `FAIL host API check: OS temporary directory ${tmpdir()} cannot be resolved to a real directory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const logsRoot = options.logsRoot ?? join(tempRoot, 'pi-bg-host-api-check-logs');
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(join(logsRoot, `${options.mode}-`));
console.log(`host API check mode=${options.mode} cache=${options.cache} temp=${tempRoot}`);
console.log(`logs ${logs}`);

const receipt = [];
let failures = 0;
for (const key of steps) {
  const step = STEPS[key];
  const home = mkdtempSync(join(tempRoot, 'pi-bg-host-api-check-home-'));
  const file = join(logs, `${key}.log`);
  const started = Date.now();
  let outcome;
  try {
    const agentDir = join(home, 'agent');
    mkdirSync(agentDir);
    const env = {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      LANG: 'en_US.UTF-8',
      SHELL: process.env['SHELL'] ?? '/bin/sh',
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      CI: '1',
      npm_config_cache: options.cache,
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    };
    const fd = openSync(file, 'w');
    try {
      outcome = spawnSync(step.command, step.args, {
        cwd: packageRoot,
        env,
        stdio: ['ignore', fd, fd],
        timeout: step.timeout,
        killSignal: 'SIGKILL',
      });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const elapsedMs = Date.now() - started;
  const ok = outcome.error === undefined && outcome.signal === null && outcome.status === 0;
  receipt.push({
    step: key,
    command: step.command,
    args: step.args,
    exit: outcome.status,
    signal: outcome.signal,
    error: outcome.error?.message,
    elapsedMs,
    timeoutMs: step.timeout,
    log: file,
  });
  writeFileSync(join(logs, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const counts = text
    .split('\n')
    .filter((line) => /^# (tests|pass|fail|skipped|cancelled) /u.test(line))
    .join(' ');
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${key} exit=${String(outcome.status)} signal=${String(outcome.signal)} ${String(Math.round(elapsedMs / 1000))}s ${counts}`,
  );
  if (ok && step.print === true) {
    const listed = text.split('\n').filter((line) => line.length > 0);
    console.log(`  ${String(listed.length)} changed path(s):`);
    console.log(listed.slice(0, 80).map((line) => `  ${line}`).join('\n'));
  }
  if (!ok) {
    failures += 1;
    if (outcome.error !== undefined) console.log(`  spawn error: ${outcome.error.message}`);
    console.log(interestingLines(text).join('\n'));
    if (step.required === true) {
      console.log(`  required step ${key} failed; later steps were not run`);
      break;
    }
  }
}
console.log(
  `host API check ${failures === 0 ? 'PASS' : `FAIL (${String(failures)} step(s))`} receipt=${join(logs, 'receipt.json')}`,
);
process.exitCode = failures === 0 ? 0 : 1;
