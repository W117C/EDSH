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
const path = require('path');
const {
  assertDshAvailable,
  collectHistory,
  installDshPreset,
  reservePort,
  rpc,
  spawnDshWeb,
  stopDshWeb,
  tempProject,
  waitForApi,
  waitForTurnEnd,
} = require('./lib/dsh-test-runtime');
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

/** Local OpenAI/DeepSeek-compatible chat-completions SSE mock. */
function createMockServer() {
  const state = {
    requests: [],
    createGoalSeen: false,
    verifySeen: false,
    cheatUpdateAttempts: 0,
    cheatVerifyStarted: false,
    cheatReviewStarted: false,
    buildStep: 0,
    buildReviewStarted: false,
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
      const buildGoalResult = toolText.match(
        /\{"goal":\{"id":"([^"]+)","revision":(\d+),"objective":"Build ECC mission"/
      );
      const buildGoalId = buildGoalResult?.[1];
      const buildGoalRevision = Number(buildGoalResult?.[2]);
      const hasGoalRound = userText.includes('<goal_round>');
      const hasVerifyResult = toolText.includes('ecc-keyless-ok');
      const cheatMode = userText.includes('CHEAT');
      const buildMode = userText.includes('BUILD_MISSION');

      let text = null;
      let toolCall = null;

      if (systemText.includes('Create a concise title')) {
        text = 'Keyless mission';
      } else if (userText.includes('Adversarially review')) {
        text = 'REVIEW_PASS';
      } else if (userText.includes('Workflow reviewer')) {
        text = 'WF_OK';
      } else if (buildMode && buildGoalId === undefined) {
        toolCall = {
          name: 'create_goal',
          arguments: { objective: 'Build ECC mission', max_goal_rounds: 1 },
        };
        state.createGoalSeen = true;
      } else if (buildMode && !hasGoalRound) {
        text = 'Goal armed; the build mission will now execute and verify a real artifact.';
      } else if (buildMode && state.buildStep === 0) {
        toolCall = {
          name: 'bash',
          arguments: {
            command: 'printf "built-ok\\n" > artifact.txt',
            description: 'write build artifact',
          },
        };
        state.buildStep = 1;
      } else if (buildMode && state.buildStep === 1) {
        toolCall = { name: 'ecc_verify', arguments: {} };
        state.buildStep = 2;
      } else if (buildMode && state.buildStep === 2 && !state.buildReviewStarted) {
        toolCall = {
          name: 'subagent',
          arguments: {
            description: 'review build',
            prompt: 'Adversarially review the build mission artifact.',
            run_in_background: false,
          },
        };
        state.buildReviewStarted = true;
      } else if (buildMode && state.buildStep === 2 && state.buildReviewStarted && hasVerifyResult) {
        toolCall = {
          name: 'update_goal',
          arguments: {
            goal_id: buildGoalId,
            revision: buildGoalRevision,
            action: 'complete',
          },
        };
        text = DELIVERY;
        state.buildStep = 3;
      } else if (userText.includes('PLAN_TEST') && !assistantCalls.includes('ecc_plan')) {
        toolCall = { name: 'ecc_plan', arguments: {} };
      } else if (userText.includes('PLAN_TEST') && !assistantCalls.includes('exit_plan_mode')) {
        toolCall = {
          name: 'exit_plan_mode',
          arguments: {
            plan: '# Keyless plan\n\nInspect the repository, verify the gate, and deliver evidence.',
          },
        };
      } else if (userText.includes('PLAN_TEST')) {
        text = 'PLAN_APPROVED';
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
      } else if (cheatMode && state.cheatVerifyStarted && !state.cheatReviewStarted) {
        toolCall = {
          name: 'subagent',
          arguments: {
            description: 'review repair',
            prompt: 'Adversarially review the repaired verification evidence.',
            run_in_background: false,
          },
        };
        state.cheatReviewStarted = true;
      } else if (cheatMode && state.cheatReviewStarted && state.cheatUpdateAttempts === 1) {
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
            run_in_background: false,
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

async function answerPlanReviews(baseUrl, sessionId, signal) {
  const stats = { seen: 0, answered: 0 };
  const url = new URL('/api/events.mux', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);

  const answer = async (rpcId, payload) => {
    if (payload.sessionId !== sessionId) return;
    const question = (payload.questions ?? []).find(item => item.intent?.kind === 'plan-review');
    if (question === undefined) return;
    stats.seen += 1;
    const approve = question.intent.approve;
    const answerResponse = await fetch(`${baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: {
          ok: true,
          value: {
            sessionId,
            answer: {
              answers: [{ id: question.id, selected: [approve] }],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const receipt = await answerResponse.json();
    if (receipt.accepted === true) stats.answered += 1;
  };

  const answerTasks = [];
  await new Promise((resolve, reject) => {
    const abort = () => socket.close();
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => {});
    socket.addEventListener('message', event => {
      let envelope;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (envelope.type !== 'server-request') return;
      const payload = envelope.payload;
      if (payload?.type === 'question/requested') {
        answerTasks.push(answer(envelope.rpcId, payload));
      }
    });
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, { once: true });
    socket.addEventListener('error', event => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) resolve();
      else reject(new Error(event.message || 'events.mux WebSocket failed'));
    }, { once: true });
  });
  await Promise.all(answerTasks);

  return stats;
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

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  assertDshAvailable();

  const mock = await startMock();
  const { tempRoot, project } = tempProject([
    { name: 'keyless', command: 'node -e "console.log(\'ecc-keyless-ok\')"', timeoutMs: 30000 },
  ]);
  const home = path.join(tempRoot, 'home');
  installDshPreset(home);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = spawnDshWeb({
    port,
    home,
    extraEnv: {
      DEEPSEEK_BASE_URL: mock.url,
      DEEPSEEK_API_KEY: 'test-key',
    },
  });

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
    await stopDshWeb(child, port);
    child = spawnDshWeb({
      port,
      home,
      extraEnv: {
        DEEPSEEK_BASE_URL: mock.url,
        DEEPSEEK_API_KEY: 'test-key',
      },
    });
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

    // Plan-mode scenario: the model enters plan mode with ecc_plan, the next
    // request is assembled under DSH's plan-mode policy, the model submits
    // exit_plan_mode, and this harness answers the plan-review question with
    // Approve over the mux SSE channel.
    const planAnswerController = new AbortController();
    const planAnswers = answerPlanReviews(baseUrl, sessionId, planAnswerController.signal);
    await rpc(baseUrl, 'e2e-plan-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'PLAN_TEST: enter plan mode and inspect.' }],
    });
    const planHistory = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    planAnswerController.abort();
    const planAnswerStats = await planAnswers;
    const planEvents = (planHistory.events ?? []).map(item => item.event ?? item);
    if (!planEvents.some(event => event.type === 'tool/call' && event.data?.name === 'ecc_plan')) {
      throw new Error('durable log missing ecc_plan tool call');
    }
    if (!planEvents.some(event => event.type === 'tool/call' && event.data?.name === 'exit_plan_mode')) {
      throw new Error('durable log missing exit_plan_mode tool call');
    }
    const activePlanEvents = planEvents.filter(event => (
      event.type === 'plan/mode' && event.data?.active === true
    ));
    if (activePlanEvents.length === 0) {
      throw new Error('durable log missing active plan/mode event');
    }
    if (!planEvents.some(event => event.type === 'plan/mode' && event.data?.active === false)) {
      throw new Error('durable log missing plan/mode exit after approval');
    }
    const planPolicyRequest = mock.state.requests.some(request => (
      JSON.stringify(request.messages ?? []).includes('You are in plan mode')
    ));
    if (!planPolicyRequest) {
      throw new Error('no model request carried the DSH plan-mode policy');
    }
    if (planAnswerStats.answered < 1) {
      throw new Error(`plan review was not answered; stats: ${JSON.stringify(planAnswerStats)}`);
    }

    // Build mission: the mock model drives a REAL shell write through DSH's
    // bash tool, then ecc_verify runs a real check against that artifact.
    await rpc(baseUrl, 'e2e-build-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'BUILD_MISSION: create the artifact and verify it.' }],
    });
    const buildHistory = await waitForTurnEnd(baseUrl, sessionId, parsed.timeoutMs);
    const buildEvents = (buildHistory.events ?? []).map(item => item.event ?? item);
    const buildArtifact = path.join(project, 'artifact.txt');
    if (!fs.existsSync(buildArtifact) || fs.readFileSync(buildArtifact, 'utf8').trim() !== 'built-ok') {
      throw new Error('build mission did not produce artifact.txt with built-ok');
    }
    if (!buildEvents.some(event => event.type === 'tool/call' && event.data?.name === 'bash')) {
      throw new Error('build mission did not log a real bash tool call');
    }
    if (!buildEvents.some(event => (
      event.type === 'goal/change'
      && event.data?.operation === 'complete'
      && event.data?.goal?.objective === 'Build ECC mission'
    ))) {
      throw new Error('build mission goal was not completed');
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
    console.log(`- plan mode entries: ${activePlanEvents.length}`);
    console.log(`- plan review approvals: ${planAnswerStats.answered}`);
    console.log(`- build artifact: ${buildArtifact}`);
    console.log(`- final delivery: ${finalText.split('\n').find(line => line.includes('Delivery'))}`);
  } finally {
    await stopDshWeb(child, port);
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
