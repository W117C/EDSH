#!/usr/bin/env node
'use strict';

/**
 * Keyless end-to-end smoke for the ECC Agent Engineering System on DSH.
 *
 * A local mock implements the DeepSeek chat-completions SSE surface. The
 * script boots an isolated `dsh web` with a temporary $DSH_HOME, installs the
 * `ecc` preset, opens a session in a temporary project, and asks the mock
 * model to run the lifecycle. The mock model deliberately calls:
 *
 *   1. create_goal        — arms DSH's same-session goal-round driver
 *   2. ecc_verify         — runs the project-owned verification gate
 *   3. final delivery text — reports evidence and lets the one-round goal idle
 *
 * The assertions inspect the durable session log for those tool calls, the
 * goal activation, the automatic goal round, and the passed verification
 * evidence. No DEEPSEEK_API_KEY or real model is used; a fake key satisfies
 * the credential reference and all traffic stays on 127.0.0.1.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MISSION = 'Build and verify a keyless mission.';
const DELIVERY = 'Delivery complete: keyless lifecycle evidence collected.';

function parseArgs(argv) {
  const parsed = { timeoutMs: 120000, keep: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(argv[++index]);
    } else if (arg === '--keep') {
      parsed.keep = true;
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
    'Usage: node scripts/dsh-keyless-e2e.js [options]',
    '',
    'Run the ECC-DSH lifecycle against an isolated dsh web process and a',
    'local mock DeepSeek SSE server. Requires the dsh binary on PATH.',
    '',
    'Options:',
    '  --timeout-ms <ms>  Overall session-settle timeout (default 120000)',
    '  --keep             Keep the temporary home/project directories for inspection',
    '  -h, --help         Show this help',
  ].join('\n'));
}

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
      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

/** Local OpenAI/DeepSeek-compatible chat-completions SSE mock. */
function createMockServer() {
  const state = {
    requests: [],
    createGoalSeen: false,
    verifySeen: false,
    cheatUpdateAttempts: 0,
    cheatVerifyStarted: false,
  };

  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk.toString('utf8') });
    request.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400).end('invalid json');
        return;
      }
      state.requests.push(parsed);

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = messages.find(message => message.role === 'system');
      const systemText = typeof system?.content === 'string' ? system.content : '';
      const assistantCalls = messages
        .filter(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
        .flatMap(message => message.tool_calls)
        .map(call => call?.function?.name)
        .filter(Boolean);
      const userMessages = messages.filter(message => message.role === 'user');
      const userText = userMessages
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
        .join('\n');
      const lastUserText = userMessages
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
        .slice(-1)[0] ?? '';
      const toolText = messages
        .filter(message => message.role === 'tool')
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
        .join('\n');
      const goalToolResult = toolText.match(
        /\{"goal":\{"id":"([^"]+)","revision":(\d+),"objective":"([^"]+)"/
      );
      const goalId = goalToolResult?.[1];
      const goalRevision = Number(goalToolResult?.[2]);
      const cheatGoalResult = toolText.match(
        /\{"goal":\{"id":"([^"]+)","revision":(\d+),"objective":"Cheating ECC mission"/
      );
      const cheatGoalId = cheatGoalResult?.[1];
      const cheatGoalRevision = Number(cheatGoalResult?.[2]);
      const hasGoalRound = userText.includes('<goal_round>');
      const hasVerifyResult = toolText.includes('ecc-keyless-ok');
      const cheatMode = userText.includes('CHEAT');

      let text = null;
      let toolCall = null;

      if (systemText.includes('Create a concise title')) {
        text = 'Keyless mission';
      } else if (userText.includes('Adversarially review')) {
        text = 'REVIEW_PASS';
      } else if (userText.includes('Workflow reviewer')) {
        text = 'WF_OK';
      } else if (cheatMode && cheatGoalId === undefined) {
        toolCall = {
          name: 'create_goal',
          arguments: { objective: 'Cheating ECC mission', max_goal_rounds: 1 },
        };
        state.createGoalSeen = true;
      } else if (cheatMode && !hasGoalRound) {
        text = 'Goal armed; attempting completion without verification.';
      } else if (cheatMode && state.cheatUpdateAttempts === 0) {
        toolCall = {
          name: 'update_goal',
          arguments: {
            goal_id: cheatGoalId,
            revision: cheatGoalRevision,
            action: 'complete',
          },
        };
        state.cheatUpdateAttempts += 1;
      } else if (cheatMode && toolText.includes('ecc-completion-gate') && !state.cheatVerifyStarted) {
        toolCall = { name: 'ecc_verify', arguments: {} };
        state.cheatVerifyStarted = true;
        state.verifySeen = true;
      } else if (cheatMode && state.cheatVerifyStarted && state.cheatUpdateAttempts === 1) {
        toolCall = {
          name: 'update_goal',
          arguments: {
            goal_id: cheatGoalId,
            revision: cheatGoalRevision,
            action: 'complete',
          },
        };
        text = DELIVERY;
        state.cheatUpdateAttempts += 1;
      } else if (lastUserText.includes('Resume and confirm')) {
        text = DELIVERY;
      } else if (!assistantCalls.includes('create_goal') && goalId === undefined) {
        toolCall = {
          name: 'create_goal',
          arguments: { objective: 'Keyless ECC mission', max_goal_rounds: 1 },
        };
        state.createGoalSeen = true;
      } else if (!hasGoalRound && !hasVerifyResult) {
        text = 'Goal armed; the autonomous goal round will now review and verify.';
      } else if (hasGoalRound && !assistantCalls.includes('subagent')) {
        toolCall = {
          name: 'subagent',
          arguments: {
            description: 'review verification',
            prompt: 'Adversarially review the verification plan for this keyless mission.',
          },
        };
      } else if (hasGoalRound && assistantCalls.includes('subagent') && !assistantCalls.includes('workflow')) {
        toolCall = {
          name: 'workflow',
          arguments: {
            meta: { name: 'keyless-review', description: 'Fan out two mock reviewers' },
            script: [
              "const one = await agent('Workflow reviewer one: check the plan.', { label: 'review-one' });",
              "const two = await agent('Workflow reviewer two: check the plan.', { label: 'review-two' });",
              'return { one, two };',
            ].join('\n'),
          },
        };
      } else if (hasGoalRound && assistantCalls.includes('workflow') && !assistantCalls.includes('ecc_verify')) {
        toolCall = { name: 'ecc_verify', arguments: {} };
        state.verifySeen = true;
      } else if (hasVerifyResult && goalId !== undefined && !toolText.includes('ecc-completion-gate') && assistantCalls.filter(name => name === 'update_goal').length === 0) {
        toolCall = {
          name: 'update_goal',
          arguments: {
            goal_id: goalId,
            revision: goalRevision,
            action: 'complete',
          },
        };
        text = DELIVERY;
      } else {
        text = DELIVERY;
      }

      const events = [];
      if (text !== null) {
        events.push(JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }));
        events.push(JSON.stringify({ choices: [{ delta: { content: text } }] }));
      }
      if (toolCall) {
        events.push(JSON.stringify({
          choices: [{
            delta: {
              content: null,
              tool_calls: [{
                index: 0,
                id: `call_${state.requests.length}`,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
              }],
            },
          }],
        }));
      }
      events.push(JSON.stringify({
        choices: [{ delta: { content: '' }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
      events.push('[DONE]');

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0;
      const writeNext = () => {
        if (index >= events.length) {
          response.end();
          return;
        }
        response.write(`data: ${events[index]}\n\n`);
        index += 1;
        setTimeout(writeNext, 2);
      };
      writeNext();
    });
  });

  return { server, state };
}

async function startMock() {
  const mock = createMockServer();
  await new Promise((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(0, '127.0.0.1', resolve);
  });
  const address = mock.server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind');
  return { ...mock, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise(resolve => server.close(() => resolve()));
}

async function waitForApi(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/agentPreset.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'e2e-ready',
          method: 'agentPreset.list',
          payload: {},
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.result?.ok === true) return;
        lastError = new Error(JSON.stringify(body.result?.error ?? body));
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`dsh web did not become API-ready: ${lastError ?? 'timeout'}`);
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

async function sleep(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms));
}

function spawnWeb({ port, home, mockUrl }) {
  return spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: mockUrl,
      DEEPSEEK_API_KEY: 'test-key',
      DSH_PERMISSION_MODE: 'danger-full-access',
      ECC_DSH_MCP_CONTEXT7: '0',
      ECC_DSH_MCP_CODEGRAPH: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    // Every e2e web process becomes the leader of a fresh process group.
    // Teardown kills that group id, so the script can never signal the
    // user's own dsh web instance or any unrelated dsh process.
    detached: process.platform !== 'win32',
  });
}

async function stopWeb(child) {
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
}

function findDeep(data, predicate) {
  const matches = [];
  const visit = value => {
    if (predicate(value)) matches.push(value);
    if (value === null || typeof value !== 'object') return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(data);
  return matches;
}

async function collectHistory(baseUrl, sessionId) {
  const value = await rpc(baseUrl, 'e2e-history', 'session.history', {
    sessionId,
    maxMessages: 200,
  });
  return value;
}

async function waitForTurnEnd(baseUrl, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let history;
  while (Date.now() < deadline) {
    history = await collectHistory(baseUrl, sessionId);
    const events = Array.isArray(history.events) ? history.events : [];
    let sawTurn = false;
    let open = false;
    for (const item of events) {
      const type = item.event?.type;
      if (type === 'turn/start') {
        sawTurn = true;
        open = true;
      } else if (type === 'turn/end') {
        sawTurn = true;
        open = false;
      }
    }
    if (sawTurn && !open) return history;
    await sleep(250);
  }
  throw new Error(`session did not settle within ${timeoutMs}ms`);
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  assertDshAvailable();

  const mock = await startMock();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-e2e-'));
  const home = path.join(tempRoot, 'home');
  const project = path.join(tempRoot, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(project, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(project, '.ecc', 'dsh-verify.json'), JSON.stringify({
    checks: [
      { name: 'keyless', command: 'node -e "console.log(\'ecc-keyless-ok\')"', timeoutMs: 30000 },
    ],
  }, null, 2));

  const install = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dsh-install.js'),
    '--dsh-home', home,
  ], { encoding: 'utf8' });
  if (install.status !== 0) {
    throw new Error(`preset install failed: ${install.stderr}`);
  }

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = spawnWeb({ port, home, mockUrl: mock.url });

  try {
    await waitForApi(baseUrl, 30000);
    const roster = await rpc(baseUrl, 'e2e-list', 'agentPreset.list', {});
    const preset = roster.presets.find(candidate => candidate.id === 'ecc');
    if (!preset || preset.broken !== undefined) {
      throw new Error(`ecc preset unavailable: ${JSON.stringify(preset)}`);
    }

    const created = await rpc(baseUrl, 'e2e-create', 'session.create', {
      cwd: project,
      agentPreset: 'ecc',
    });
    const sessionId = created.sessionId;
    if (created.agentPreset !== 'ecc') {
      throw new Error(`session mounted preset ${created.agentPreset}`);
    }

    await rpc(baseUrl, 'e2e-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: MISSION }],
    });

    const history = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    const events = (history.events ?? []).map(item => item.event ?? item);

    const toolCallNames = events
      .filter(event => event.type === 'tool/call')
      .map(event => event.data?.name)
      .filter(Boolean);
    const missingCalls = ['create_goal', 'subagent', 'workflow', 'ecc_verify'].filter(name => !toolCallNames.includes(name));
    if (missingCalls.length > 0) {
      throw new Error(`durable log missing tool calls: ${missingCalls.join(', ')}; saw ${toolCallNames.join(', ')}`);
    }

    const goalChanges = events.filter(event => event.type === 'goal/change');
    if (goalChanges.length === 0) {
      throw new Error('durable log missing goal/change events');
    }
    const completedGoal = goalChanges.find(event => event.data?.operation === 'complete');
    if (!completedGoal) {
      throw new Error(`goal was never completed; operations: ${goalChanges.map(event => event.data?.operation).join(', ')}`);
    }
    const goalRoundMessages = events.filter(event => (
      event.type === 'user/message' && event.data?.source?.kind === 'goal'
    ));
    if (goalRoundMessages.length === 0) {
      throw new Error('goal-round driver did not emit an automatic goal round');
    }

    const verifyResults = findDeep(history, value => (
      typeof value === 'string' && value.includes('ecc-keyless-ok')
    ));
    if (verifyResults.length === 0) {
      throw new Error('durable log does not contain ecc_verify pass evidence');
    }

    const reviewResults = findDeep(history, value => (
      typeof value === 'string' && value.includes('REVIEW_PASS')
    ));
    if (reviewResults.length === 0) {
      throw new Error('durable log does not contain subagent review evidence');
    }

    const workflowResults = findDeep(history, value => (
      typeof value === 'string' && value.includes('WF_OK')
    ));
    if (workflowResults.length === 0) {
      throw new Error('durable log does not contain workflow fan-out evidence');
    }

    const finalText = events
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data?.message?.content ?? event.data?.content ?? [])
      .flat()
      .map(block => block?.text ?? '')
      .join('\n');
    if (!finalText.includes('Delivery complete')) {
      throw new Error(`final delivery text missing; got: ${finalText.slice(0, 200)}`);
    }

    // Fork/replay: a child session must replay the completed prefix.
    const forked = await rpc(baseUrl, 'e2e-fork', 'session.fork', { sessionId });
    const forkHistory = await collectHistory(baseUrl, forked.sessionId);
    const forkEvents = (forkHistory.events ?? []).map(item => item.event ?? item);
    const forkCalls = forkEvents
      .filter(event => event.type === 'tool/call')
      .map(event => event.data?.name);
    for (const name of ['create_goal', 'subagent', 'workflow', 'ecc_verify', 'update_goal']) {
      if (!forkCalls.includes(name)) {
        throw new Error(`fork replay missing ${name}; saw ${forkCalls.join(', ')}`);
      }
    }

    // Cold resume: stop the web process, boot a new one over the same durable
    // $DSH_HOME, and submit a follow-up to the same session id.
    await stopWeb(child);
    child = spawnWeb({ port, home, mockUrl: mock.url });
    await waitForApi(baseUrl, 30000);
    await rpc(baseUrl, 'e2e-resume-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Resume and confirm the prior session state survived.' }],
    });
    const resumedHistory = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    const resumedEvents = (resumedHistory.events ?? []).map(item => item.event ?? item);
    const resumedCalls = resumedEvents
      .filter(event => event.type === 'tool/call')
      .map(event => event.data?.name);
    for (const name of ['create_goal', 'subagent', 'workflow', 'ecc_verify', 'update_goal']) {
      if (!resumedCalls.includes(name)) {
        throw new Error(`cold resume lost durable tool call ${name}`);
      }
    }
    const resumedDelivery = resumedEvents
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data?.message?.content ?? event.data?.content ?? [])
      .flat()
      .map(block => block?.text ?? '')
      .join('\n');
    if (!resumedDelivery.includes('Delivery complete')) {
      throw new Error(`cold resume did not deliver; got: ${resumedDelivery.slice(0, 200)}`);
    }

    // Repair-path scenario: the mock model first tries to complete a goal
    // without verification. The completion gate must turn that tool result
    // into an error; the model then runs ecc_verify and retries completion.
    await rpc(baseUrl, 'e2e-cheat-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'CHEAT: try to finish without verification, then repair it.' }],
    });
    const cheatHistory = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    const cheatEvents = (cheatHistory.events ?? []).map(item => item.event ?? item);
    const cheatBlocked = cheatEvents.some(event => (
      event.type === 'tool/result'
      && event.data?.message?.content?.[0]?.isError === true
      && findDeep(event, value => typeof value === 'string' && value.includes('ecc-completion-gate')).length > 0
    ));
    if (!cheatBlocked) {
      throw new Error('completion gate did not block an unverified goal completion');
    }
    const cheatCompleted = cheatEvents.some(event => (
      event.type === 'goal/change'
      && event.data?.operation === 'complete'
      && event.data?.goal?.objective === 'Cheating ECC mission'
    ));
    if (!cheatCompleted) {
      throw new Error('goal was not completed after the model repaired by running ecc_verify');
    }
    const updateGoalAttempts = cheatEvents.filter(event => (
      event.type === 'tool/call' && event.data?.name === 'update_goal'
    )).length;
    if (updateGoalAttempts < 3) {
      throw new Error(`expected one blocked completion plus two successful completions; saw ${updateGoalAttempts}`);
    }

    console.log('DeepSeek Harness keyless lifecycle: PASS');
    console.log(`- mock requests: ${mock.state.requests.length}`);
    console.log(`- tool calls logged: ${toolCallNames.join(', ')}`);
    console.log(`- goal rounds admitted: ${goalRoundMessages.length}`);
    console.log(`- subagent review evidence: ${reviewResults.length} occurrence(s)`);
    console.log(`- workflow fan-out evidence: ${workflowResults.length} occurrence(s)`);
    console.log(`- verification evidence: ${verifyResults.length} occurrence(s)`);
    console.log(`- fork replay tool calls: ${forkCalls.join(', ')}`);
    console.log(`- cold resume tool calls preserved: ${resumedCalls.join(', ')}`);
    console.log(`- completion gate blocked then repaired: ${updateGoalAttempts} update_goal attempts`);
    console.log(`- final delivery: ${finalText.split('\n').find(line => line.includes('Delivery'))}`);
  } finally {
    await stopWeb(child);
    await closeServer(mock.server).catch(() => {});
    if (!parsed.keep) fs.rmSync(tempRoot, { recursive: true, force: true });
    else console.log(`kept artifacts under ${tempRoot}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('DeepSeek Harness keyless lifecycle: FAIL');
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createMockServer,
  findDeep,
  main,
  parseArgs,
};
