/**
 * Regression tests for the native DeepSeek Harness surface.
 *
 * Structural guards only. The real DSH mount smoke is performed manually or
 * in CI with an installed `dsh` binary; see scripts/dsh-install.js and
 * scripts/dsh-validate-preset.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildPayload,
  dshYamlSchema,
  PINNED_DSH_VERSION,
} = require('../../scripts/dsh-validate-preset');
const {
  getInstallTargetAdapter,
  planInstallTargetScaffold,
} = require('../../scripts/lib/install-targets/registry');
const {
  planOperations,
} = require('../../scripts/dsh-install');

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

function runTests() {
  console.log('\n=== Testing DeepSeek Harness adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('validates the ecc preset payload', () => {
    const payload = buildPayload();
    assert.strictEqual(payload.schema_version, 'ecc.dsh-preset.v1');
    assert.strictEqual(payload.pinned_dsh_version, PINNED_DSH_VERSION);
    assert.strictEqual(payload.preset_id, 'ecc');
    assert.ok(payload.total_rows >= 33, 'expected standard rows plus ECC rows');
    assert.ok(payload.skills.includes('engineering-lifecycle'));
    assert.deepStrictEqual(payload.verify_checks, ['adapters', 'unit']);
  })) passed++; else failed++;

  if (test('keeps upstream standard rows name-pinned', () => {
    const yaml = require('js-yaml');
    const source = fs.readFileSync(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'agent.cordis.yml'), 'utf8');
    const entries = yaml.load(source, { schema: dshYamlSchema() });
    const expected = [
      ['persona', '@deepseek-ai/dsh-persona'],
      ['delegation/tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
      ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
      ['compaction/compaction-basic', '@deepseek-ai/dsh-compaction-basic'],
    ];

    const rows = new Map();
    const visit = (list, prefix = '') => {
      for (const row of list) {
        const id = prefix ? `${prefix}/${row.id}` : row.id;
        rows.set(id, row.name);
        if (row.group && Array.isArray(row.config)) visit(row.config, id);
      }
    };
    visit(entries);

    for (const [id, name] of expected) {
      assert.strictEqual(rows.get(id), name, `${id} drifted from the pinned DSH preset`);
    }
  })) passed++; else failed++;

  if (test('groups service-providing preset rows in isolate realms', () => {
    const yaml = require('js-yaml');
    const source = fs.readFileSync(path.join(ROOT, '.dsh', 'agent-presets', 'ecc', 'agent.cordis.yml'), 'utf8');
    const entries = yaml.load(source, { schema: dshYamlSchema() });

    for (const row of entries) {
      if (row.name === 'cordis:group') {
        assert.strictEqual(row.group, true, `${row.id} must be a group`);
        assert.ok(row.isolate && Object.keys(row.isolate).length > 0, `${row.id} must isolate a realm`);
      }
    }
  })) passed++; else failed++;

  if (test('ships exactly the runtime preset files to $DSH_HOME', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-test-'));
    const operations = planOperations(path.join(homeDir, '.dsh'));
    const destinations = operations
      .filter(operation => operation.kind === 'copy')
      .map(operation => operation.destination);

    assert.ok(destinations.some(destination => destination.endsWith(path.join('.agent-presets', 'ecc', 'agent.cordis.yml'))));
    assert.ok(destinations.some(destination => destination.endsWith(path.join('skills', 'engineering-lifecycle.md'))));
    assert.ok(!destinations.some(destination => destination.endsWith(path.join('README.md'))), 'repo docs must not be installed as DSH runtime files');
    assert.strictEqual(operations.find(operation => operation.kind === 'state').destination, path.join(homeDir, '.dsh', 'ecc-dsh-install-state.json'));
  })) passed++; else failed++;

  if (test('registers dsh in the generic installer with a default profile', () => {
    const adapter = getInstallTargetAdapter('dsh');
    assert.strictEqual(adapter.id, 'dsh-home');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(adapter.resolveRoot({ homeDir: '/home/tester' }), path.join('/home/tester', '.dsh'));

    const { loadInstallManifests } = require('../../scripts/lib/install-manifests');
    const manifests = loadInstallManifests({ repoRoot: ROOT });
    const module = manifests.modulesById.get('dsh-preset');
    assert.ok(module, 'dsh-preset module must exist');
    assert.ok(module.targets.includes('dsh'));
    assert.ok(manifests.profiles.dsh.modules.includes('dsh-preset'));

    const plan = planInstallTargetScaffold({
      target: 'dsh',
      repoRoot: ROOT,
      projectRoot: ROOT,
      homeDir: '/home/tester',
      modules: [module],
    });
    assert.strictEqual(plan.operations.length, 7, 'four preset plugins + composition + metadata + skill');
  })) passed++; else failed++;

  if (test('adds DeepSeek Harness to the adapter compliance records', () => {
    const { ADAPTER_RECORDS } = require('../../scripts/lib/harness-adapter-compliance');
    const record = ADAPTER_RECORDS.find(candidate => candidate.id === 'dsh');
    assert.ok(record, 'dsh adapter record must exist');
    assert.strictEqual(record.harness, 'DeepSeek Harness');
    assert.strictEqual(record.last_verified_at, '2026-08-16');
    assert.ok(record.source_docs.includes('.dsh/agent-presets/ecc/agent.cordis.yml'));
    assert.ok(record.verification_commands.some(command => command.includes('dsh:e2e')));
  })) passed++; else failed++;

  if (test('publishes the DSH lifecycle scripts as installable runtime', () => {
    const packageJson = require('../../package.json');
    for (const script of ['dsh-install.js', 'dsh-drift-check.js', 'dsh-smoke.js', 'dsh-keyless-e2e.js']) {
      assert.ok(packageJson.files.includes(`scripts/${script}`), `package files must include ${script}`);
    }
    assert.strictEqual(packageJson.scripts['dsh:e2e'], 'node scripts/dsh-keyless-e2e.js');
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runTests();
