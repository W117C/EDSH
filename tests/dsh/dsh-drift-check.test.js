/**
 * Optional upstream-drift guard for the ECC DSH preset.
 *
 * Runs only when the `dsh` binary is installed. It compares every reused
 * upstream row in `.dsh/agent-presets/ecc/agent.cordis.yml` with the shipped
 * `standard` preset next to that binary and fails on rename/config drift.
 */

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function runTests() {
  console.log('\n=== Testing DSH upstream drift ===\n');

  const hasDsh = spawnSync('dsh', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasDsh) {
    console.log('  - skipped: dsh binary not found on PATH');
    console.log('\n0 passed, 0 failed');
    return;
  }

  try {
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'dsh-drift-check.js'),
    ], { encoding: 'utf8', timeout: 30000 });
    console.log(output.split('\n').slice(-1)[0]);
    console.log('\n1 passed, 0 failed');
  } catch (error) {
    console.log('  \u2717 installed DSH standard preset drifted from the ECC preset');
    console.log(error.stdout || '');
    console.log(error.stderr || error.message);
    console.log('\n0 passed, 1 failed');
    process.exitCode = 1;
  }
}

runTests();
