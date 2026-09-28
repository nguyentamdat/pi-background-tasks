import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { it } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

void it('refuses unknown Anthropic message roles under an external hard deadline', async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../fixtures/anthropic-role-progress.ts', import.meta.url)),
    ],
    { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 },
  );
  assert.match(result.stdout, /unknown role refused without looping/u);
});
