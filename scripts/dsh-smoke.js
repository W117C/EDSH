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
 * No model request is sent, so no DEEPSEEK_API_KEY is required. Requires the
 * `dsh` binary on PATH.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const parsed = { timeoutMs: 30000 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function hasDsh() {
  const checked = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  return checked.status === 0;
}

function killPortOwners(port) {
  // dsh web can daemonize its actual server child. This narrows cleanup to
  // exactly the PIDs listening on the port this script reserved; it never
  // scans for or signals other dsh processes.
  const checked = spawnSync('lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
  ], { encoding: 'utf8', timeout: 5000 });
  if (checked.status !== 0) return;
  for (const rawPid of checked.stdout.split('\n')) {
    const pid = Number(rawPid.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The listener may have exited between lsof and kill.
    }
  }
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/agentPreset.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'smoke-ready',
          method: 'agentPreset.list',
          payload: {},
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.result?.ok === true) return;
        lastError = new Error(`agentPreset.list not ready: ${JSON.stringify(body.result?.error ?? body)}`);
      } else {
        lastError = new Error(`agentPreset.list HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`dsh web did not become ready: ${lastError ?? 'timeout'}`);
}

async function rpc(baseUrl, rpcId, method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body.result?.error ?? body)}`);
  }
  return body.result.value;
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (!hasDsh()) {
    throw new Error('dsh binary not found on PATH');
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-smoke-'));
  const install = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dsh-install.js'),
    '--dsh-home', home,
  ], { encoding: 'utf8' });
  if (install.status !== 0) {
    throw new Error(`preset install failed: ${install.stderr}`);
  }

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      ECC_DSH_MCP_CONTEXT7: '0',
      ECC_DSH_MCP_CODEGRAPH: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Fresh process group so teardown can never signal the user's own
    // dsh web instance or any other unrelated dsh process.
    detached: process.platform !== 'win32',
  });
  child.stdout.resume();
  child.stderr.resume();

  try {
    await waitForServer(baseUrl, parsed.timeoutMs);

    const roster = await rpc(baseUrl, 'smoke-list', 'agentPreset.list', {});
    const preset = roster.presets.find(candidate => candidate.id === 'ecc');
    if (!preset) {
      throw new Error('ecc preset missing from roster');
    }
    if (preset.broken !== undefined) {
      throw new Error(`ecc preset is broken: ${preset.broken}`);
    }

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
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 300));
    killPortOwners(port);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`DeepSeek Harness preset smoke: FAIL`);
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  reservePort,
  rpc,
};
