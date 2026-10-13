#!/usr/bin/env node
// Independent deterministic delegate child. Only inference is substituted; production seeding,
// process launch, registry, artifact adjudication and verification stay real in the parent.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dir = process.env.PI_BG_DELEGATE_ARTIFACT_DIR;
const raw = fs.readFileSync(process.env.PI_BG_DELEGATE_SEED_PATH, "utf8");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
if (sha(Buffer.from(raw)) !== process.env.PI_BG_DELEGATE_SEED_SHA256)
  throw new Error("Seed hash mismatch");
const seed = JSON.parse(raw);
const text = "DELEGATE VERIFIED ANSWER: " + seed.directive.text;
const bytes = Buffer.from(text);
const route = { provider: seed.route.provider, model: seed.route.model };
const result = {
  schema_version: "pi-background-tasks.delegate-result.v1",
  task_id: process.env.PI_BG_DELEGATE_TASK_ID,
  launch_nonce: process.env.PI_BG_DELEGATE_LAUNCH_NONCE,
  seed_sha256: process.env.PI_BG_DELEGATE_SEED_SHA256,
  directive_sha256: seed.directive.sha256,
  route,
  route_attestations: [{ ...route, stop_reason: "stop" }],
  stop_reason: "stop",
  turns: 2,
  tool_calls: 1,
  usage: { status: "unavailable", reason: "Deterministic child performs no inference" },
  answer: {
    encoding: "utf-8",
    byte_length: bytes.length,
    sha256: sha(bytes),
    blocks: [
      {
        kind: "text",
        byte_length: bytes.length,
        sha256: sha(bytes),
        data_base64: bytes.toString("base64"),
      },
    ],
  },
  spilled_artifacts: [],
};
const pending = path.join(dir, "oracle-result.tmp");
fs.writeFileSync(pending, JSON.stringify(result) + "\n");
fs.renameSync(pending, path.join(dir, "result.json"));
