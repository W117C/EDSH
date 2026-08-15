#!/usr/bin/env node
'use strict';

/**
 * Validate the native DeepSeek Harness adapter shipped in `.dsh/`.
 *
 * The checks are structural and deterministic; they do not boot dsh. The
 * optional integration check in `scripts/dsh-install.js` copies the preset
 * into $DSH_HOME so the real harness can discover it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const PRESET_DIR = path.join(ROOT, '.dsh', 'agent-presets', 'ecc');
const PRESET_FILE = path.join(PRESET_DIR, 'agent.cordis.yml');
const PRESET_METADATA_FILE = path.join(PRESET_DIR, 'preset.yml');
const SKILL_DIR = path.join(ROOT, '.dsh', 'skills');
const VERIFY_CONFIG = path.join(ROOT, '.ecc', 'dsh-verify.json');
const PINNED_DSH_VERSION = '0.1.0-rc.6';

// Every row this preset expects from the shipped DSH standard preset.
// Nested rows are represented as `groupId/nestedId`.
const PINNED_STANDARD_ROWS = Object.freeze([
  ['persona', '@deepseek-ai/dsh-persona'],
  ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
  ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
  ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
  ['planning', 'cordis:group'],
  ['planning/plan-mode', '@deepseek-ai/dsh-plan-mode'],
  ['compaction', 'cordis:group'],
  ['compaction/compaction-basic', '@deepseek-ai/dsh-compaction-basic'],
  ['compaction/command-compact', '@deepseek-ai/dsh-command-compact'],
  ['compaction/tool-result-pruner', '@deepseek-ai/dsh-compaction-tool-result-pruner'],
  ['delegation', 'cordis:group'],
  ['delegation/tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control'],
  ['delegation/tool-subagent-list-agents', '@deepseek-ai/dsh-tool-subagent-control/list-agents'],
  ['delegation/tool-subagent', '@deepseek-ai/dsh-tool-subagent'],
  ['delegation/tool-subagent-fork', '@deepseek-ai/dsh-tool-subagent'],
  ['delegation/tool-subagent-codex', '@deepseek-ai/dsh-tool-subagent'],
  ['delegation/tool-subagent-claude-code', '@deepseek-ai/dsh-tool-subagent'],
  ['delegation/workflow-worker-thread', '@deepseek-ai/dsh-workflow-worker-thread'],
  ['delegation/tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
  ['delegation/tool-ralph', '@deepseek-ai/dsh-tool-ralph'],
  ['tool-ask-user', '@deepseek-ai/dsh-tool-ask-user'],
  ['tool-todo', '@deepseek-ai/dsh-tool-todo'],
  ['tool-web', '@deepseek-ai/dsh-tool-web'],
]);

const ECC_ROWS = Object.freeze([
  ['ecc-lifecycle', './ecc-lifecycle.mjs'],
  ['ecc-verify', './ecc-verify.mjs'],
  ['mcp-context7', '@deepseek-ai/dsh-mcp-client'],
  ['mcp-codegraph', '@deepseek-ai/dsh-mcp-client'],
]);

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dshYamlSchema() {
  const jsExpression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: data => typeof data === 'string',
    construct: data => ({ __jsExpr: data }),
    predicate: value => value !== null && typeof value === 'object' && Object.hasOwn(value, '__jsExpr'),
  });
  return yaml.DEFAULT_SCHEMA.extend([jsExpression]);
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'), { schema: dshYamlSchema() });
}

function flattenRows(entries, parentId = '') {
  const rows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      throw new Error(`invalid entry in ${PRESET_FILE}: every row needs string id and name`);
    }
    const id = parentId ? `${parentId}/${entry.id}` : entry.id;
    rows.push({ id, name: entry.name, entry });
    if (entry.group === true && Array.isArray(entry.config)) {
      rows.push(...flattenRows(entry.config, id));
    }
  }
  return rows;
}

function validatePresetComposition() {
  const entries = readYaml(PRESET_FILE);
  if (!Array.isArray(entries)) {
    throw new Error(`${PRESET_FILE} must contain a top-level list of plugin rows`);
  }

  const rows = flattenRows(entries);
  const byId = new Map(rows.map(row => [row.id, row]));
  const duplicateIds = rows.filter((row, index) => (
    rows.findIndex(candidate => candidate.id === row.id) !== index
  ));
  if (duplicateIds.length > 0) {
    throw new Error(`duplicate row ids in ${PRESET_FILE}: ${[...new Set(duplicateIds.map(row => row.id))].join(', ')}`);
  }

  const errors = [];
  for (const [id, expectedName] of [...PINNED_STANDARD_ROWS, ...ECC_ROWS]) {
    const row = byId.get(id);
    if (!row) {
      errors.push(`missing pinned row "${id}"`);
      continue;
    }
    if (row.name !== expectedName) {
      errors.push(`row "${id}" expected name "${expectedName}", found "${row.name}"`);
    }
  }

  for (const row of rows) {
    if (row.name.startsWith('./')) {
      const pluginPath = path.resolve(PRESET_DIR, row.name.slice(2));
      if (!fs.existsSync(pluginPath)) {
        errors.push(`row "${row.id}" references missing plugin ${row.name}`);
        continue;
      }
      const checked = spawnSync(process.execPath, ['--check', pluginPath], { encoding: 'utf8' });
      if (checked.status !== 0) {
        errors.push(`row "${row.id}" plugin ${row.name} failed syntax check: ${checked.stderr.trim()}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  return {
    entries,
    rows,
    topLevelCount: entries.length,
    totalRowCount: rows.length,
  };
}

function validatePresetMetadata() {
  const metadata = readYaml(PRESET_METADATA_FILE);
  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`${PRESET_METADATA_FILE} must contain a YAML object`);
  }
  if (typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
    throw new Error(`${PRESET_METADATA_FILE} needs a non-empty name`);
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim().length === 0) {
    throw new Error(`${PRESET_METADATA_FILE} needs a non-empty description`);
  }
  return metadata;
}

function validateSkillFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(source);
  if (!match) {
    throw new Error(`${filePath} needs YAML frontmatter with name and description`);
  }
  const frontmatter = yaml.load(match[1]);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`${filePath} frontmatter must be a YAML object`);
  }
  if (typeof frontmatter.name !== 'string' || !KEBAB_NAME.test(frontmatter.name)) {
    throw new Error(`${filePath} frontmatter name must be kebab-case`);
  }
  if (typeof frontmatter.description !== 'string' || frontmatter.description.trim().length === 0) {
    throw new Error(`${filePath} frontmatter description must be a non-empty string`);
  }
  if (source.length > 64 * 1024) {
    throw new Error(`${filePath} is too large for a model-loadable skill (${source.length} bytes)`);
  }
  return frontmatter;
}

function validateSkills() {
  const skills = [];
  for (const entry of fs.readdirSync(SKILL_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(SKILL_DIR, entry.name);
    skills.push({ file: path.relative(ROOT, filePath), frontmatter: validateSkillFile(filePath) });
  }
  if (skills.length === 0) {
    throw new Error(`${SKILL_DIR} must contain at least one flat skill`);
  }
  return skills;
}

function validateVerifyConfig() {
  const config = JSON.parse(fs.readFileSync(VERIFY_CONFIG, 'utf8'));
  if (!config || typeof config !== 'object' || !Array.isArray(config.checks) || config.checks.length === 0) {
    throw new Error(`${VERIFY_CONFIG} needs a non-empty checks array`);
  }
  const names = new Set();
  for (const check of config.checks) {
    if (!check || typeof check !== 'object') {
      throw new Error(`${VERIFY_CONFIG} check entries must be objects`);
    }
    if (typeof check.name !== 'string' || !KEBAB_NAME.test(check.name)) {
      throw new Error(`${VERIFY_CONFIG} check name must be kebab-case`);
    }
    if (names.has(check.name)) {
      throw new Error(`${VERIFY_CONFIG} duplicate check name "${check.name}"`);
    }
    names.add(check.name);
    if (typeof check.command !== 'string' || check.command.trim().length === 0) {
      throw new Error(`${VERIFY_CONFIG} check "${check.name}" needs a non-empty command`);
    }
    if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
      throw new Error(`${VERIFY_CONFIG} check "${check.name}" timeoutMs must be a positive safe integer`);
    }
  }
  return config;
}

function buildPayload() {
  const composition = validatePresetComposition();
  const metadata = validatePresetMetadata();
  const skills = validateSkills();
  const verifyConfig = validateVerifyConfig();
  return {
    schema_version: 'ecc.dsh-preset.v1',
    pinned_dsh_version: PINNED_DSH_VERSION,
    preset_id: 'ecc',
    top_level_rows: composition.topLevelCount,
    total_rows: composition.totalRowCount,
    skills: skills.map(skill => skill.frontmatter.name),
    verify_checks: verifyConfig.checks.map(check => check.name),
    metadata,
  };
}

function main() {
  const payload = buildPayload();
  console.log(JSON.stringify(payload, null, 2));
  console.log('DeepSeek Harness preset validation: PASS');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`DeepSeek Harness preset validation: FAIL`);
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  ECC_ROW_IDS: Object.freeze(new Set(ECC_ROWS.map(([id]) => id))),
  PINNED_DSH_VERSION,
  buildPayload,
  dshYamlSchema,
  validatePresetComposition,
  validatePresetMetadata,
  validateSkillFile,
  validateSkills,
  validateVerifyConfig,
};
