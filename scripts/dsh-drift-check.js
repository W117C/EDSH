#!/usr/bin/env node
'use strict';

/**
 * Compare the ECC preset's reused DSH rows against the `standard` preset of
 * the locally installed `dsh` package.
 *
 * DSH is a developer preview, so a row rename or config-contract change can
 * silently break profile patches. This script resolves the `dsh` bin on PATH,
 * locates the package's shipped `config/agent-presets/standard`, and reports
 * missing, renamed, or differently-configured upstream rows.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  dshYamlSchema,
  ECC_ROW_IDS,
  validatePresetComposition,
  PINNED_DSH_VERSION,
} = require('./dsh-validate-preset');

const yaml = require('js-yaml');

function which(command) {
  const checked = spawnSync('/usr/bin/env', ['which', command], { encoding: 'utf8' });
  if (checked.status !== 0 || !checked.stdout.trim()) return undefined;
  return checked.stdout.trim().split('\n')[0];
}

function resolveDshPackageRoot(binPath) {
  let current = fs.realpathSync(binPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (manifest.name === '@deepseek-ai/dsh') return current;
      } catch {
        // Keep walking: the package.json may not belong to dsh.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not locate the @deepseek-ai/dsh package root from ${binPath}`);
}

function flattenRows(entries, parentId = '') {
  const rows = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      throw new Error('invalid upstream preset entry');
    }
    const id = parentId ? `${parentId}/${entry.id}` : entry.id;
    rows.set(id, entry);
    if (entry.group === true && Array.isArray(entry.config)) {
      for (const [childId, child] of flattenRows(entry.config, id)) rows.set(childId, child);
    }
  }
  return rows;
}

function stableConfig(entry) {
  return JSON.stringify({ config: entry.config ?? null, disabled: entry.disabled ?? null, inject: entry.inject ?? null, isolate: entry.isolate ?? null });
}

function buildPayload() {
  const composition = validatePresetComposition();
  const binPath = which('dsh');
  if (!binPath) {
    throw new Error('dsh binary not found on PATH; cannot locate the installed standard preset');
  }

  const dshRoot = resolveDshPackageRoot(binPath);
  const standardPath = path.join(dshRoot, 'config', 'agent-presets', 'standard', 'agent.cordis.yml');
  if (!fs.existsSync(standardPath)) {
    throw new Error(`installed dsh has no shipped standard preset at ${standardPath}`);
  }
  const upstreamEntries = yaml.load(fs.readFileSync(standardPath, 'utf8'), { schema: dshYamlSchema() });
  const upstream = flattenRows(upstreamEntries);
  const ours = new Map(composition.rows.map(row => [row.id, row.entry]));

  const mismatches = [];
  const compared = [];
  for (const [id, oursEntry] of ours) {
    if (ECC_ROW_IDS.has(id)) continue;
    if (!oursEntry.name.startsWith('@deepseek-ai/dsh-') && oursEntry.name !== 'cordis:group') continue;
    const upstreamEntry = upstream.get(id);
    if (!upstreamEntry) {
      mismatches.push(`${id}: missing from installed standard preset`);
      continue;
    }
    if (upstreamEntry.name !== oursEntry.name) {
      mismatches.push(`${id}: package drifted from ${oursEntry.name} to ${upstreamEntry.name}`);
      continue;
    }
    compared.push(id);
    // `persona` is an intentional ECC replacement. Groups are compared
    // through their flattened child rows above, so an ECC child inserted into
    // a reused group does not make the whole group look drifted.
    if (id !== 'persona' && oursEntry.group !== true && stableConfig(upstreamEntry) !== stableConfig(oursEntry)) {
      mismatches.push(`${id}: config drifted from installed standard preset`);
    }
  }

  for (const id of upstream.keys()) {
    if (!ours.has(id) && !id.startsWith('planning/') && !id.startsWith('compaction/') && !id.startsWith('delegation/')) {
      // New top-level standard rows are informational, not drift, unless this
      // preset would be expected to inherit them.
      compared.push(`(upstream-only) ${id}`);
    }
  }

  return {
    schema_version: 'ecc.dsh-drift.v1',
    pinned_dsh_version: PINNED_DSH_VERSION,
    installed_dsh_root: dshRoot,
    installed_standard_preset: standardPath,
    compared_row_count: compared.length,
    mismatches,
  };
}

function main() {
  const payload = buildPayload();
  if (payload.mismatches.length > 0) {
    throw new Error(payload.mismatches.join('; '));
  }
  console.log(JSON.stringify(payload, null, 2));
  console.log('DeepSeek Harness upstream drift check: PASS');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('DeepSeek Harness upstream drift check: FAIL');
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  buildPayload,
  flattenRows,
  resolveDshPackageRoot,
  stableConfig,
};
