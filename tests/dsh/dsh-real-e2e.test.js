/**
 * Real-model DSH acceptance test.
 *
 * Runs only when DEEPSEEK_API_KEY is set. Without a key it reports a skip;
 * this keeps the repository test suite keyless by default while giving CI a
 * one-command real-model acceptance path.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function runTests() {
  console.log('\n=== Testing real-model DSH lifecycle ===\n');

  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('  - skipped: DEEPSEEK_API_KEY not set');
    console.log('\n0 passed, 0 failed');
    return;
  }

  try {
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'dsh-real-e2e.js'),
    ], {
      encoding: 'utf8',
      timeout: 960000,
    });
    console.log(output);
    console.log('\n1 passed, 0 failed');
  } catch (error) {
    console.log('  \u2717 real-model lifecycle failed');
    console.log(error.stdout || '');
    console.log(error.stderr || error.message);
    console.log('\n0 passed, 1 failed');
    process.exitCode = 1;
  }
}

runTests();
