#!/usr/bin/env node
'use strict';

/**
 * Live DeepSeek Harness smoke for the ECC preset.
 *
 * Boots `dsh web` with an isolated $DSH_HOME, installs the ECC preset, then
 * verifies the exact surfaces a production session depends on:
 *   - the roster discovers `ecc` without a broken reason;
 *   - `session.create` mounts the full composition successfully.
 *
 * No model request is sent, so no DEEPSEEK_API_KEY is required.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  assertDshAvailable,
  installDshPreset,
  reservePort,
  rpc,
  spawnDshWeb,
  stopDshWeb,
  waitForApi,
} = require('./lib/dsh-test-runtime');

function parseArgs(argv) {
  const parsed = { timeoutMs: 30000 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') parsed.timeoutMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log([
    'Usage: node scripts/dsh-smoke.js [--timeout-ms <ms>]',
    '',
    'Boot an isolated dsh web server and verify that the ECC preset is',
    'discovered and mounts without a model request.',
  ].join('\n'));
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  assertDshAvailable();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-smoke-'));
  const home = path.join(tempRoot, 'home');
  installDshPreset(home);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnDshWeb({ port, home });

  try {
    await waitForApi(baseUrl, parsed.timeoutMs);

    const roster = await rpc(baseUrl, 'smoke-list', 'agentPreset.list', {});
    const preset = roster.presets.find(candidate => candidate.id === 'ecc');
    if (!preset) throw new Error('ecc preset missing from roster');
    if (preset.broken !== undefined) throw new Error(`ecc preset is broken: ${preset.broken}`);

    const session = await rpc(baseUrl, 'smoke-create', 'session.create', {
      cwd: ROOT,
      agentPreset: 'ecc',
    });
    if (session.agentPreset !== 'ecc') {
      throw new Error(`session mounted ${session.agentPreset}, expected ecc`);
    }

    console.log('DeepSeek Harness preset smoke: PASS');
    console.log(`- preset discovered: ${preset.name}`);
    console.log(`- session mounted: ${session.sessionId}`);
  } finally {
    await stopDshWeb(child, port);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('DeepSeek Harness preset smoke: FAIL');
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
