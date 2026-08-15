/**
 * Tests for the ecc-lifecycle DSH plugin. The `/ecc-goal` command is a human
 * slash command, so the message it queues must carry a user source: DSH goal
 * tools grant create/edit authority only to direct-human turns.
 */

const assert = require('assert');
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

async function runTests() {
  console.log('\n=== Testing ecc-lifecycle DSH plugin ===\n');

  let passed = 0;
  let failed = 0;

  if (await runAsyncTest('registers the phase protocol and /ecc-goal', async () => {
    const { apply } = await import(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'ecc-lifecycle.mjs'));
    const fake = {
      effect(fn) {
        const disposed = fn();
        return () => {
          if (typeof disposed === 'function') disposed();
        };
      },
      systemPrompt: {
        section(definition) {
          fake.section = definition;
          return () => {};
        },
      },
      commands: {
        register(definition) {
          fake.command = definition;
          return () => {};
        },
      },
    };

    apply(fake);

    assert.strictEqual(fake.section.name, 'ecc:engineering-system');
    assert.ok(fake.section.text.includes('REQUIREMENTS'));
    assert.ok(fake.section.text.includes('DELIVER'));

    let followed;
    const result = fake.command.handler({
      agent: {
        followup(message) {
          followed = message;
        },
      },
      rawInput: ' repair the failing build ',
    });

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(followed.role, 'user');
    assert.deepStrictEqual(followed.source, { kind: 'user' });
    assert.ok(followed.content[0].text.includes('repair the failing build'));
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
