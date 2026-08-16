# ECC Agent Engineering System for DeepSeek Harness

Status: verified against DeepSeek Harness 0.1.0-rc.6 (2026-08-16). The full
create_goal -> goal-round -> ecc_verify -> goal-complete -> delivery path is
exercised keylessly against the real DSH runtime with a mock model. Real
model acceptance and adversarial subagent/workflow review still require a
`DEEPSEEK_API_KEY` and are tracked as the next phases.

## Objective

Upgrade DeepSeek Harness (DSH) from a model connector into a native agent
engineering system where one agent can go from a requirement to a delivered,
verified result with minimal human intervention:

requirements -> plan -> execute -> test -> review -> repair -> verify -> deliver.

## Design decision: compose DSH, do not fork it

DSH is fully plugin-composed. It already owns the hard, durable machinery:

- append-only session log with resume/fork/replay;
- plan mode with user-approved `exit_plan_mode`;
- persisted goals plus the goal-round continuation driver;
- fresh and forked in-process subagents;
- the worker-thread dynamic workflow engine (`agent` / `pipeline` / `parallel`);
- filesystem skill discovery and the model-facing skill loader;
- the MCP client bridge;
- sandbox policy, approval, compaction, and telemetry.

ECC therefore contributes a thin agent-plane preset plus three pieces DSH
lacks:

1. a mandatory phase protocol (`ecc-lifecycle.mjs`);
2. a repository-owned deterministic verification gate (`ecc_verify` +
   `.ecc/dsh-verify.json`);
3. an enforced completion interlock (`ecc-completion-gate.mjs`) that blocks
   `update_goal complete` until the current goal has both a settled
   independent subagent review and a passing `ecc_verify` result after its
   own creation.

## Layout

| Path | Responsibility |
| --- | --- |
| `.dsh/agent-presets/ecc/agent.cordis.yml` | ECC preset; base rows name-pinned to DSH `standard` 0.1.0-rc.6 |
| `.dsh/agent-presets/ecc/ecc-lifecycle.mjs` | Phase protocol prompt section and `/ecc-goal` command |
| `.dsh/agent-presets/ecc/ecc-verify.mjs` | `ecc_verify` tool; model can select only declared checks |
| `.dsh/agent-presets/ecc/ecc-completion-gate.mjs` | Blocks goal completion without a current-goal independent review and `ecc_verify` pass |
| `.dsh/agent-presets/ecc/ecc-plan-control.mjs` | Model-facing `ecc_plan` entry into DSH plan mode |
| `.dsh/skills/engineering-lifecycle.md` | Loadable phase-gate skill, discovered by DSH |
| `.ecc/dsh-verify.json` | The verification commands, reviewed and committed as code |
| `scripts/dsh-validate-preset.js` | Deterministic structural validation |
| `scripts/dsh-install.js` | Standalone installer / verifier |
| `scripts/dsh-drift-check.js` | Compares reused rows with the locally installed DSH `standard` preset |
| `scripts/dsh-smoke.js` | Live roster + mount smoke |
| `scripts/dsh-keyless-e2e.js` | Keyless full-lifecycle test with a mock DeepSeek SSE model |
| `scripts/dsh-real-e2e.js` | Real DeepSeek acceptance test; skips without `DEEPSEEK_API_KEY` |
| `scripts/lib/dsh-test-runtime.js` | Shared isolated-process/API/teardown runtime for the three DSH test harnesses |
| `scripts/lib/install-targets/dsh-home.js` | `./install.sh --target dsh` adapter |

## Verification model

`ecc_verify` has no command parameter. The model can ask for a named check or
run all checks; command text lives only in `.ecc/dsh-verify.json`. This keeps
the gate auditable in git and prevents prompt-defined shell execution.

The default gate for this repository runs:

1. `npm run harness:adapters -- --check`
2. `node tests/run-all.js`

## Runtime evidence collected

- `scripts/dsh-validate-preset.js`: PASS.
- `npm run dsh:drift`: PASS against the locally installed DSH 0.1.0-rc.6
  `standard` preset; 29 reused rows match by id, package name, and config.
- `./install.sh --target dsh --dry-run` and a real temp-home install: PASS.
- `npm run dsh:smoke`: PASS repeatedly; boots an isolated `dsh web`,
  discovers `ecc`, and mounts it through `session.create`.
- `npm run dsh:e2e`: PASS keylessly. A local mock DeepSeek SSE server drives
  the real DSH loop through `create_goal` -> automatic goal round -> fresh
  `subagent` review -> two-agent `workflow` fan-out -> `ecc_verify` ->
  `update_goal complete` -> delivery text. It then asserts `session.fork`
  replay and a cold web-process restart over the same durable `$DSH_HOME`;
  the restarted session still contains every tool call and can take a new
  prompt. A second CHEAT scenario tries `update_goal complete` before
  verification: the completion gate blocks it, the mock model repairs by
  running `ecc_verify`, and the retry completes. A third PLAN_TEST scenario
  calls the model-facing `ecc_plan` tool, verifies that the next request
  carries DSH's plan-mode policy, submits `exit_plan_mode`, and answers the
  plan-review question with Approve through DSH's WebSocket mux channel;
  `plan/mode` active -> inactive lands in the durable session log. A fourth
  BUILD_MISSION scenario executes a real `bash` write through DSH, then
  `ecc_verify` runs a real `node` test against the resulting `app.js` in the
  agent session cwd, and the goal completes — so the harness exercises real
  code production and test verification, not only orchestration.
- Live `dsh web` boot with the installed `ecc` preset: preset discovered in
  `agentPreset.list` and `session.create { agentPreset: 'ecc' }` succeeded
  after the tool schema was corrected to DSH's enforced JSON Schema subset.
- `skill.list` for an `ecc` session returns `engineering-lifecycle` alongside
  the project's existing `.agents/skills` catalog.
- Opt-in MCP rows also mount cleanly: `session.create` succeeds with
  `ECC_DSH_MCP_CONTEXT7=1`, with `ECC_DSH_MCP_CODEGRAPH=1`, and with both
  enabled together.
- Process safety: `dsh:smoke` and `dsh:e2e` launch their web servers in a
  fresh process group, then also clean up any daemonized child through the
  exact reserved listening port; both were run while a separate user-owned
  `dsh web` process stayed alive and untouched.

## Next phases

1. Run `npm run dsh:real-e2e` with `DEEPSEEK_API_KEY` to execute the
   implemented real-model acceptance path (the current environment has no
   key, so the script reports SKIP).
2. Promote the compliance matrix row from Adapter-backed to Native after the
   end-to-end model smoke passes.
