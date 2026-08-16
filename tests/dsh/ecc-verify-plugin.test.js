/**
 * Tests for the ecc_verify DSH plugin, exercised with an in-process fake
 * Cordis context. This proves the tool registration contract and the security
 * boundary: shell command text comes from `.ecc/dsh-verify.json`, never from
 * model arguments.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function createFakeContext() {
  const { apply } = await import(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'ecc-verify.mjs'));
  const fake = {
    effect(fn) {
      const disposed = fn();
      return () => {
        if (typeof disposed === 'function') disposed();
      };
    },
    tools: {
      register(definition) {
        fake.definition = definition;
        return () => {};
      },
    },
    systemPrompt: {
      section(definition) {
        fake.section = definition;
        return () => {};
      },
    },
    shell: {
      requests: [],
      resolve(request) {
        return request;
      },
      async run(spec) {
        fake.shell.requests.push(spec);
        return {
          exitCode: fake.nextExitCode,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: fake.nextStdout },
          stderr: { text: fake.nextStderr },
        };
      },
    },
    nextExitCode: 0,
    nextStdout: 'ok\n',
    nextStderr: '',
  };
  apply(fake);
  return fake;
}

async function runTests() {
  console.log('\n=== Testing ecc_verify DSH plugin ===\n');

  let passed = 0;
  let failed = 0;

  if (await runAsyncTest('registers ecc_verify and a verification prompt section', async () => {
    const ctx = await createFakeContext();
    assert.strictEqual(ctx.definition.name, 'ecc_verify');
    assert.strictEqual(ctx.definition.parameters.properties.check.type, 'string');
    assert.strictEqual(ctx.section.name, 'ecc:verify-gate');
    assert.ok(ctx.definition.description.includes('.ecc/dsh-verify.json'));
  })) passed++; else failed++;

  if (await runAsyncTest('executes only commands declared in the repository config', async () => {
    const ctx = await createFakeContext();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-verify-test-'));
    fs.mkdirSync(path.join(temp, '.ecc'));
    fs.writeFileSync(path.join(temp, '.ecc', 'dsh-verify.json'), JSON.stringify({
      checks: [
        { name: 'unit', command: 'node --version' },
        { name: 'adapters', command: 'npm run harness:adapters -- --check' },
      ],
    }));

    const previousCwd = process.cwd();
    process.chdir(temp);
    try {
      const value = await ctx.definition.execute({}, { signal: new AbortController().signal });
      assert.strictEqual(value.ok, true);
      assert.strictEqual(value.selected.length, 2);
      assert.strictEqual(ctx.shell.requests.length, 2);
      assert.strictEqual(ctx.shell.requests[0].command, 'node --version');
      assert.strictEqual(ctx.shell.requests[1].command, 'npm run harness:adapters -- --check');
      assert.ok(!Object.hasOwn(ctx.shell.requests[0], 'injectedCommand'));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await runAsyncTest('reads the gate from the agent session cwd, not the dsh process cwd', async () => {
    const ctx = await createFakeContext();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-verify-test-'));
    fs.mkdirSync(path.join(temp, '.ecc'));
    fs.writeFileSync(path.join(temp, '.ecc', 'dsh-verify.json'), JSON.stringify({
      checks: [{ name: 'session-local', command: 'node -e "console.log(123)"' }],
    }));

    const previousCwd = process.cwd();
    try {
      const value = await ctx.definition.execute({}, {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: temp } } },
      });
      assert.strictEqual(value.ok, true);
      assert.strictEqual(value.selected[0], 'session-local');
      assert.strictEqual(ctx.shell.requests[0].command, 'node -e "console.log(123)"');
      assert.strictEqual(ctx.shell.requests[0].workdir, temp, 'commands must run in the agent session cwd');
      assert.strictEqual(process.cwd(), previousCwd, 'the tool must not mutate the host process cwd');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await runAsyncTest('returns failed evidence when a declared check exits non-zero', async () => {
    const ctx = await createFakeContext();
    ctx.nextExitCode = 1;
    ctx.nextStdout = 'failed output';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-verify-test-'));
    fs.mkdirSync(path.join(temp, '.ecc'));
    fs.writeFileSync(path.join(temp, '.ecc', 'dsh-verify.json'), JSON.stringify({
      checks: [{ name: 'unit', command: 'node --version' }],
    }));

    const previousCwd = process.cwd();
    process.chdir(temp);
    try {
      const value = await ctx.definition.execute({}, { signal: new AbortController().signal });
      assert.strictEqual(value.ok, false);
      assert.strictEqual(value.checks[0].exitCode, 1);
      assert.strictEqual(value.checks[0].stdout, 'failed output');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await runAsyncTest('rejects a model-selected check that is not declared', async () => {
    const ctx = await createFakeContext();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-verify-test-'));
    fs.mkdirSync(path.join(temp, '.ecc'));
    fs.writeFileSync(path.join(temp, '.ecc', 'dsh-verify.json'), JSON.stringify({
      checks: [{ name: 'unit', command: 'node --version' }],
    }));

    const previousCwd = process.cwd();
    process.chdir(temp);
    try {
      await assert.rejects(
        () => ctx.definition.execute({ check: 'rm -rf /' }, { signal: new AbortController().signal }),
        /unknown verification check/,
      );
      assert.strictEqual(ctx.shell.requests.length, 0, 'no shell call may run for an unknown check');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
