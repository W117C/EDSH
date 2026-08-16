/**
 * Tests for the ecc-plan-control plugin: the model-facing entry into DSH
 * plan mode. It must only enter plan mode; leaving remains owned by
 * exit_plan_mode review or the human /plan off command.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function loadPlugin({ setOutcome, current }) {
  const { apply } = await import(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'ecc-plan-control.mjs'));
  const fake = {
    definition: null,
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
    planMode: {
      set() {
        return setOutcome;
      },
      get() {
        return current;
      },
    },
  };
  apply(fake);
  return fake;
}

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

async function runTests() {
  console.log('\n=== Testing ecc-plan-control DSH plugin ===\n');

  let passed = 0;
  let failed = 0;

  if (await runAsyncTest('registers ecc_plan with an empty parameter object', async () => {
    const ctx = await loadPlugin({ setOutcome: 'committed', current: { active: true, pending: false } });
    assert.strictEqual(ctx.definition.name, 'ecc_plan');
    assert.strictEqual(ctx.definition.parameters.type, 'object');
  })) passed++; else failed++;

  if (await runAsyncTest('reports active mode when committed', async () => {
    const ctx = await loadPlugin({ setOutcome: 'committed', current: { active: true, pending: false } });
    const value = await ctx.definition.execute({}, {
      agent: { session: { events: [] } },
      signal: new AbortController().signal,
    });
    assert.deepStrictEqual(value, { active: true, queued: false });
  })) passed++; else failed++;

  if (await runAsyncTest('reports queued mode during an open turn', async () => {
    const ctx = await loadPlugin({ setOutcome: 'queued', current: { active: false, pending: true } });
    const value = await ctx.definition.execute({}, {
      agent: { session: { events: [] } },
      signal: new AbortController().signal,
    });
    assert.deepStrictEqual(value, { active: true, queued: true });
  })) passed++; else failed++;

  if (await runAsyncTest('rejects execution without a calling agent', async () => {
    const ctx = await loadPlugin({ setOutcome: 'committed', current: { active: true, pending: false } });
    await assert.rejects(
      () => ctx.definition.execute({}, { signal: new AbortController().signal }),
      /requires a calling agent/,
    );
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
