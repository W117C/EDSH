/**
 * Tests for the ecc-completion-gate plugin: goal completion must be blocked
 * until a successful ecc_verify result exists in the current session log.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function loadPlugin() {
  const { apply } = await import(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'ecc-completion-gate.mjs'));
  const fake = {
    listeners: new Map(),
    section: null,
    effect(fn) {
      const disposed = fn();
      return () => {
        if (typeof disposed === 'function') disposed();
      };
    },
    on(event, listener) {
      fake.listeners.set(event, listener);
      return () => {};
    },
    systemPrompt: {
      section(definition) {
        fake.section = definition;
        return () => {};
      },
    },
  };
  apply(fake);
  return fake;
}

function verifyPassEvents() {
  return [
    { type: 'tool/call', data: { callId: 'verify-1', name: 'ecc_verify', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { callId: 'verify-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'verify-1',
            isError: false,
            content: [{ type: 'text', text: '{\n  "ok": true,\n  "checks": []\n}' }],
          }],
        },
      },
    },
  ];
}

function completionExecution(events, goalId = 'goal-1') {
  return {
    name: 'update_goal',
    arguments: { goal_id: goalId, revision: 1, action: 'complete' },
    agent: { session: { events } },
    signal: new AbortController().signal,
  };
}

async function runTests() {
  console.log('\n=== Testing ecc-completion-gate DSH plugin ===\n');

  let passed = 0;
  let failed = 0;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    assert.ok(listener, 'tools/pre-execute listener must be registered');
    assert.strictEqual(ctx.section.name, 'ecc:completion-gate');
    return true;
  })().then(ok => test('registers the completion interlock', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 registers the completion interlock');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    const decision = await listener(
      completionExecution(verifyPassEvents()),
      async () => 'accepted',
    );
    assert.strictEqual(decision, 'accepted');
    return true;
  })().then(ok => test('accepts goal completion after a passing ecc_verify', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 accepts goal completion after a passing ecc_verify');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    const decision = await listener(
      completionExecution([]),
      async () => 'accepted',
    );
    assert.strictEqual(decision.kind, 'deny');
    assert.ok(decision.reason.includes('ecc-completion-gate'));
    return true;
  })().then(ok => test('blocks goal completion without verification evidence', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 blocks goal completion without verification evidence');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    const events = verifyPassEvents();
    events[1].data.message.content[0].isError = true;
    const decision = await listener(
      completionExecution(events),
      {},
      async () => 'accepted',
    );
    assert.strictEqual(decision.kind, 'deny');
    return true;
  })().then(ok => test('blocks completion after a failed ecc_verify result', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 blocks completion after a failed ecc_verify result');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    const staleEvents = [
      { type: 'goal/change', seq: 1, data: { operation: 'create', goal: { id: 'goal-old' } } },
      { type: 'tool/call', seq: 2, data: { callId: 'verify-old', name: 'ecc_verify', arguments: '{}' } },
      {
        type: 'tool/result',
        seq: 3,
        data: {
          message: {
            source: { callId: 'verify-old' },
            content: [{ type: 'tool-result', toolCallId: 'verify-old', isError: false, content: [{ type: 'text', text: '{"ok": true}' }] }],
          },
        },
      },
      { type: 'goal/change', seq: 4, data: { operation: 'create', goal: { id: 'goal-new' } } },
    ];
    const decision = await listener(
      completionExecution(staleEvents, 'goal-new'),
      async () => 'accepted',
    );
    assert.strictEqual(decision.kind, 'deny');
    return true;
  })().then(ok => test('does not reuse verification evidence from an older goal', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 does not reuse verification evidence from an older goal');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  if (await (async () => {
    const ctx = await loadPlugin();
    const listener = ctx.listeners.get('tools/pre-execute');
    const execution = completionExecution([]);
    execution.arguments = { goal_id: 'goal-1', revision: 1, action: 'pause' };
    const decision = await listener(execution, async () => 'accepted');
    assert.strictEqual(decision, 'accepted');
    return true;
  })().then(ok => test('does not gate non-complete goal updates', () => assert.ok(ok))).catch(error => {
    console.log('  \u2717 does not gate non-complete goal updates');
    console.log(`    Error: ${error.message}`);
    return false;
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runTests();
