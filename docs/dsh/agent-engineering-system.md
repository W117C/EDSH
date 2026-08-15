# ECC Agent Engineering System for DeepSeek Harness

Status: adapter foundation verified against DeepSeek Harness 0.1.0-rc.6
(2026-08-16). Full end-to-end model-task acceptance still requires a
`DEEPSEEK_API_KEY` and is tracked as the next phase.

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

ECC therefore contributes a thin agent-plane preset plus two pieces DSH lacks:

1. a mandatory phase protocol (`ecc-lifecycle.mjs`);
2. a repository-owned deterministic verification gate (`ecc_verify` +
   `.ecc/dsh-verify.json`).

## Layout

| Path | Responsibility |
| --- | --- |
| `.dsh/agent-presets/ecc/agent.cordis.yml` | ECC preset; base rows name-pinned to DSH `standard` 0.1.0-rc.6 |
| `.dsh/agent-presets/ecc/ecc-lifecycle.mjs` | Phase protocol prompt section and `/ecc-goal` command |
| `.dsh/agent-presets/ecc/ecc-verify.mjs` | `ecc_verify` tool; model can select only declared checks |
| `.dsh/skills/engineering-lifecycle.md` | Loadable phase-gate skill, discovered by DSH |
| `.ecc/dsh-verify.json` | The verification commands, reviewed and committed as code |
| `scripts/dsh-validate-preset.js` | Deterministic structural validation |
| `scripts/dsh-install.js` | Standalone installer / verifier |
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
- `./install.sh --target dsh --dry-run` and a real temp-home install: PASS.
- `npm run dsh:smoke`: PASS twice in a row; boots an isolated `dsh web`,
  discovers `ecc`, and mounts it through `session.create`.
- Live `dsh web` boot with the installed `ecc` preset: preset discovered in
  `agentPreset.list` and `session.create { agentPreset: 'ecc' }` succeeded
  after the tool schema was corrected to DSH's enforced JSON Schema subset.
- `skill.list` for an `ecc` session returns `engineering-lifecycle` alongside
  the project's existing `.agents/skills` catalog.
- Opt-in MCP rows also mount cleanly: `session.create` succeeds with
  `ECC_DSH_MCP_CONTEXT7=1`, with `ECC_DSH_MCP_CODEGRAPH=1`, and with both
  enabled together.

## Next phases

1. Real-API smoke with `DEEPSEEK_API_KEY`: one end-to-end goal round using
   `create_goal`, plan, execute, `subagent` review, `ecc_verify`, and delivery.
2. Add a reusable `workflow` template skill for multi-file adversarial review.
3. Exercise resume/replay after an interrupted `ecc` session.
4. Promote the compliance matrix row from Adapter-backed to Native after the
   end-to-end smoke passes.
5. Add a drift check that compares this preset with the locally installed DSH
   `standard` preset when a `dsh` binary is available.
