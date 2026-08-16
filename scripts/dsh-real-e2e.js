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
const path = require('path');
const {
  assertDshAvailable,
  installDshPreset,
  reservePort,
  rpc,
  spawnDshWeb,
  stopDshWeb,
  tempProject,
  waitForApi,
  waitForTurnEnd,
} = require('./lib/dsh-test-runtime');

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
  assertDshAvailable();

  const { tempRoot, project } = tempProject([
    { name: 'real-smoke', command: 'node -e "console.log(\'real-ecc-ok\')"', timeoutMs: 30000 },
  ]);
  const home = path.join(tempRoot, 'home');
  installDshPreset(home);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnDshWeb({ port, home });

  try {
    await waitForApi(baseUrl);
    const created = await rpc(baseUrl, 'real-create', 'session.create', {
      cwd: project,
      agentPreset: 'ecc',
    });
    await rpc(baseUrl, 'real-prompt', 'session.prompt', {
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: MISSION }],
    });

    const settled = await waitForTurnEnd(baseUrl, created.sessionId, parsed.timeoutMs);
    const artifact = path.join(project, 'ecc-real-smoke.txt');
    if (!fs.existsSync(artifact) || fs.readFileSync(artifact, 'utf8').trim() !== 'ecc-real-ok') {
      throw new Error('model did not create ecc-real-smoke.txt with ecc-real-ok');
    }
    const events = (settled.events ?? []).map(item => item.event ?? item);
    const finalText = events
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data?.message?.content ?? event.data?.content ?? [])
      .flat()
      .map(block => block?.text ?? '')
      .join('\n');
    if (!finalText.includes('REAL_DELIVERY_OK')) throw new Error('final delivery phrase missing');
    if (!JSON.stringify(settled).includes('real-ecc-ok')) {
      throw new Error('durable history lacks ecc_verify pass evidence');
    }

    console.log('DeepSeek Harness real-model e2e: PASS');
    console.log(`- artifact: ${artifact}`);
    console.log(`- verification evidence: real-ecc-ok`);
    console.log(`- delivery phrase: REAL_DELIVERY_OK`);
  } finally {
    await stopDshWeb(child, port);
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

module.exports = { main, parseArgs };
