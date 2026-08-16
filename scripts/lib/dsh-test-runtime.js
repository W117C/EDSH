'use strict';

/**
 * Shared process/runtime helpers for DSH smoke and e2e scripts.
 *
 * Every helper that launches `dsh web` does so in a fresh process group with
 * an isolated $DSH_HOME and tears down only that group plus the exact
 * listening port the caller reserved. Callers must never clean up by process
 * name; that would risk signalling the operator's own dsh web instance.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function assertDshAvailable() {
  const checked = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (checked.status !== 0) {
    throw new Error('dsh binary not found on PATH');
  }
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function sleep(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms));
}

function installDshPreset(home) {
  const install = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dsh-install.js'),
    '--dsh-home', home,
  ], { encoding: 'utf8' });
  if (install.status !== 0) {
    throw new Error(`preset install failed: ${install.stderr}`);
  }
}

async function rpc(baseUrl, rpcId, method, payload, timeoutMs = 20000) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body.result?.error ?? body)}`);
  }
  return body.result.value;
}

async function waitForApi(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rpc(baseUrl, 'shared-ready', 'agentPreset.list', {}, 2000);
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`dsh web did not become API-ready: ${lastError ?? 'timeout'}`);
}

function spawnDshWeb({ port, home, cwd = ROOT, extraEnv = {} }) {
  return spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      ECC_DSH_MCP_CONTEXT7: '0',
      ECC_DSH_MCP_CODEGRAPH: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    // Fresh process group: teardown can kill -child.pid without ever
    // signalling the operator's own dsh web process.
    detached: process.platform !== 'win32',
  });
}

function killPortOwners(port) {
  // dsh web can daemonize its actual server child. This narrows cleanup to
  // exactly the PIDs listening on the port THIS script reserved; it never
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

async function stopDshWeb(child, port) {
  if (!child || child.exitCode !== null) return;
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
    sleep(3000),
  ]);
  await sleep(300);
  killPortOwners(port);
}

async function collectHistory(baseUrl, sessionId, maxMessages = 200) {
  return await rpc(baseUrl, 'shared-history', 'session.history', { sessionId, maxMessages });
}

async function waitForTurnEnd(baseUrl, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await collectHistory(baseUrl, sessionId);
    let saw = false;
    let open = false;
    for (const item of last.events ?? []) {
      const type = item.event?.type;
      if (type === 'turn/start') {
        saw = true;
        open = true;
      } else if (type === 'turn/end') {
        saw = true;
        open = false;
      }
    }
    if (saw && !open) return last;
    await sleep(250);
  }
  throw new Error(`session did not settle within ${timeoutMs}ms`);
}

function tempProject(verifyChecks) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-e2e-'));
  const project = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(project, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(project, '.ecc', 'dsh-verify.json'), JSON.stringify({ checks: verifyChecks }, null, 2));
  return { tempRoot, project };
}

module.exports = {
  ROOT,
  assertDshAvailable,
  collectHistory,
  installDshPreset,
  killPortOwners,
  reservePort,
  rpc,
  sleep,
  spawnDshWeb,
  stopDshWeb,
  tempProject,
  waitForApi,
  waitForTurnEnd,
};
