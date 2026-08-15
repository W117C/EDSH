#!/usr/bin/env node
'use strict';

/**
 * Install or refresh the ECC DeepSeek Harness preset under $DSH_HOME.
 *
 * Layout:
 *   $DSH_HOME/.agent-presets/ecc/*  — agent-plane composition and plugins
 *   $DSH_HOME/skills/*              — ECC-DSH skills
 *
 * The installer never edits $DSH_HOME/settings.yaml and never changes the
 * user's default preset. Select `ecc` in the picker or set `agent-presets:
 * default: ecc` yourself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPayload } = require('./dsh-validate-preset');

const ROOT = path.resolve(__dirname, '..');
const PRESET_SOURCE = path.join(ROOT, '.dsh', 'agent-presets', 'ecc');
const SKILLS_SOURCE = path.join(ROOT, '.dsh', 'skills');
const STATE_FILE_NAME = 'ecc-dsh-install-state.json';

function parseArgs(argv) {
  const parsed = {
    check: false,
    dryRun: false,
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      parsed.check = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--dsh-home') {
      parsed.dshHome = path.resolve(argv[index + 1] || parsed.dshHome);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log([
    'Usage: node scripts/dsh-install.js [options]',
    '',
    'Install the ECC Agent Engineering System preset into $DSH_HOME.',
    '',
    'Options:',
    '  --check           Validate the source preset, then exit without copying',
    '  --dry-run         Print the planned file operations without copying',
    '  --dsh-home <path> Override the DeepSeek Harness home directory',
    '  -h, --help        Show this help',
  ].join('\n'));
}

function listFiles(root) {
  const files = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(root, '');
  return files;
}

function planOperations(dshHome) {
  const presetDestination = path.join(dshHome, '.agent-presets', 'ecc');
  const skillsDestination = path.join(dshHome, 'skills');
  const operations = [];

  for (const file of listFiles(PRESET_SOURCE)) {
    operations.push({
      kind: 'copy',
      source: path.join(PRESET_SOURCE, file),
      destination: path.join(presetDestination, file),
      relative: path.join('.agent-presets/ecc', file),
    });
  }

  for (const file of listFiles(SKILLS_SOURCE)) {
    if (!file.endsWith('.md')) continue;
    operations.push({
      kind: 'copy',
      source: path.join(SKILLS_SOURCE, file),
      destination: path.join(skillsDestination, file),
      relative: path.join('skills', file),
    });
  }

  operations.push({
    kind: 'state',
    destination: path.join(dshHome, STATE_FILE_NAME),
    relative: STATE_FILE_NAME,
  });

  return operations;
}

function executeOperations(operations) {
  const applied = [];
  for (const operation of operations) {
    fs.mkdirSync(path.dirname(operation.destination), { recursive: true });
    if (operation.kind === 'copy') {
      fs.copyFileSync(operation.source, operation.destination);
    }
    applied.push(operation.relative);
  }

  const statePath = operations.find(operation => operation.kind === 'state').destination;
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 'ecc.dsh-install.v1',
    installed_at: new Date().toISOString(),
    preset_id: 'ecc',
    files: operations.filter(operation => operation.kind === 'copy').map(operation => operation.relative),
  }, null, 2));
  return applied;
}

function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printHelp();
    return;
  }

  const payload = buildPayload();

  if (parsed.check) {
    console.log(`ECC-DSH preset validated (${payload.pinned_dsh_version} base): PASS`);
    console.log(`Rows: ${payload.total_rows}; skills: ${payload.skills.join(', ')}; checks: ${payload.verify_checks.join(', ')}`);
    return;
  }

  const operations = planOperations(parsed.dshHome);
  if (parsed.dryRun) {
    console.log(`Dry-run install into ${parsed.dshHome}`);
    for (const operation of operations) {
      console.log(`- ${operation.relative}`);
    }
    return;
  }

  const applied = executeOperations(operations);
  console.log(`Installed ECC-DSH preset into ${parsed.dshHome}`);
  for (const file of applied) {
    console.log(`- ${file}`);
  }
  console.log('Select preset "ECC Engineering System" in dsh, or set agent-presets.default to ecc.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  listFiles,
  parseArgs,
  planOperations,
};
