/**
 * Optional keyless DSH lifecycle regression.
 *
 * This test runs only when the `dsh` binary is on PATH. CI environments
 * without DSH skip it; local machines with DSH exercise the complete
 * create_goal -> automatic goal round -> subagent review -> workflow fan-out
 * -> ecc_verify -> update_goal complete -> delivery sequence, plus a blocked
 * completion-without-verification repair path and a plan-mode enter ->
 * exit_plan_mode -> approved-plan transition, against a local mock DeepSeek
 * SSE server.
 */

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function runTests() {
  console.log('\n=== Testing keyless DSH lifecycle ===\n');

  const hasDsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasDsh) {
    console.log('  - skipped: dsh binary not found on PATH');
    console.log('\n0 passed, 0 failed');
    return;
  }

  try {
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'dsh-keyless-e2e.js'),
      '--timeout-ms', '240000',
    ], {
      encoding: 'utf8',
      timeout: 300000,
    });
    console.log(output);
    console.log('\n1 passed, 0 failed');
  } catch (error) {
    console.log(`  \u2717 keyless lifecycle failed`);
    console.log(error.stdout || '');
    console.log(error.stderr || error.message);
    console.log('\n0 passed, 1 failed');
    process.exitCode = 1;
  }
}

runTests();
