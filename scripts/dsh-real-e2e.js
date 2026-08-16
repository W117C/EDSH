#!/usr/bin/env node
'use strict';

/**
 * Real-model DSH acceptance smoke for the ECC preset.
 *
 * Requires DEEPSEEK_API_KEY. It boots an isolated `dsh web`, opens an `ecc`
 * session in a temporary project, and asks the real DeepSeek model to create
 * a small artifact, run the repository-owned verification gate, and report a
 * fixed delivery phrase. The assertions are artifact- and log-based, not
 * prompt-echo based.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MISSION = [
  'Create a file named ecc-real-smoke.txt whose entire content is the line ecc-real-ok.',
  'Then call ecc_verify.',
  'Then finish with a short delivery report containing the exact phrase REAL_DELIVERY_OK.',
].join(' ');

function parseArgs(argv) {
  const parsed = { timeoutMs: 900000, keep: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') parsed.timeoutMs = Number(argv[++index]);
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log([
    'Usage: node scripts/dsh-real-e2e.js [--timeout-ms <ms>] [--keep]',
    '',
    'Run the ECC preset against the real DeepSeek API.',
    'Requires DEEPSEEK_API_KEY (and optionally DEEPSEEK_BASE_URL).',
  ].join('\n'));
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

async function rpc(baseUrl, rpcId, method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(body.result?.error ?? body)}`);
  }
  return body.result.value;
}

async function waitForApi(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpc(baseUrl, 'real-ready', 'agentPreset.list', {});
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('dsh web did not become API-ready');
}

async function history(baseUrl, sessionId) {
  return await rpc(baseUrl, 'real-history', 'session.history', { sessionId, maxMessages: 200 });
}

async function waitForTurnEnd(baseUrl, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await history(baseUrl, sessionId);
    let saw = false;
    let open = false;
    for (const item of last.events ?? []) {
      if (item.event?.type === 'turn/start') {
        saw = true;
        open = true;
      } else if (item.event?.type === 'turn/end') {
        saw = true;
        open = false;
      }
    }
    if (saw && !open) return last;
    await sleep(500);
  }
  throw new Error(`real-model session did not settle within ${timeoutMs}ms`);
}

function spawnWeb({ port, home }) {
  return spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      ECC_DSH_MCP_CONTEXT7: '0',
      ECC_DSH_MCP_CODEGRAPH: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: process.platform !== 'win32',
  });
}

function killPortOwners(port) {
  const checked = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (checked.status !== 0) return;
  for (const rawPid of checked.stdout.split('\n')) {
    const pid = Number(rawPid.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

async function stopWeb(child, port) {
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

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('DeepSeek Harness real-model e2e: SKIP (DEEPSEEK_API_KEY not set)');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-real-'));
  const home = path.join(tempRoot, 'home');
  const project = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(project, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(project, '.ecc', 'dsh-verify.json'), JSON.stringify({
    checks: [{ name: 'real-smoke', command: 'node -e "console.log(\'real-ecc-ok\')"', timeoutMs: 30000 }],
  }, null, 2));

  const install = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dsh-install.js'), '--dsh-home', home,
  ], { encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`preset install failed: ${install.stderr}`);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = spawnWeb({ port, home });

  try {
    await waitForApi(baseUrl, 30000);
    const created = await rpc(baseUrl, 'real-create', 'session.create', {
      cwd: project,
      agentPreset: 'ecc',
    });
    const sessionId = created.sessionId;
    await rpc(baseUrl, 'real-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: MISSION }],
    });
    const settled = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    const artifact = path.join(project, 'ecc-real-smoke.txt');
    if (!fs.existsSync(artifact)) throw new Error('model did not create ecc-real-smoke.txt');
    if (fs.readFileSync(artifact, 'utf8').trim() !== 'ecc-real-ok') {
      throw new Error('artifact content is not exactly ecc-real-ok');
    }
    const events = (settled.events ?? []).map(item => item.event ?? item);
    const finalText = events
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data?.message?.content ?? event.data?.content ?? [])
      .flat()
      .map(block => block?.text ?? '')
      .join('\n');
    if (!finalText.includes('REAL_DELIVERY_OK')) throw new Error('final delivery phrase missing');
    const verified = JSON.stringify(settled).includes('real-ecc-ok');
    if (!verified) throw new Error('durable history lacks ecc_verify pass evidence');

    console.log('DeepSeek Harness real-model e2e: PASS');
    console.log(`- artifact: ${artifact}`);
    console.log(`- verification evidence: real-ecc-ok`);
    console.log(`- delivery phrase: REAL_DELIVERY_OK`);
  } finally {
    await stopWeb(child, port);
    if (!parsed.keep) fs.rmSync(tempRoot, { recursive: true, force: true });
    else console.log(`kept artifacts under ${tempRoot}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('DeepSeek Harness real-model e2e: FAIL');
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
};
