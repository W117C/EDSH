# ECC for DeepSeek Harness (DSH)

This directory is the native DeepSeek Harness surface for the ECC Agent
Engineering System. It does not fork DSH and it does not replace the agent
loop: it composes DSH's durable goal driver, plan mode, subagents, dynamic
workflows, skills, and session log into a repeatable engineering system, then
adds the three missing pieces — a mandatory phase protocol, a
repository-owned verification gate, and an enforced completion interlock.

## What is native here

| Path | Role |
| --- | --- |
| `agent-presets/ecc/agent.cordis.yml` | Full agent-plane composition, based on the shipped `standard` preset (DSH 0.1.0-rc.6) |
| `agent-presets/ecc/ecc-lifecycle.mjs` | Loads the requirements → plan → execute → test → review → repair → verify → deliver protocol and the `/ecc-goal` command |
| `agent-presets/ecc/ecc-verify.mjs` | Registers `ecc_verify`, which runs only commands declared in `.ecc/dsh-verify.json` |
| `agent-presets/ecc/ecc-completion-gate.mjs` | Blocks `update_goal complete` until the current goal has an independent review and its own passing `ecc_verify` result |
| `agent-presets/ecc/ecc-plan-control.mjs` | Model-facing `ecc_plan` entry into DSH plan mode |
| `skills/engineering-lifecycle.md` | Loadable companion skill for the phase gates |
| `../.ecc/dsh-verify.json` | Repository-owned verification commands; edit and commit as code |

DSH discovers project-local skills under `<git-root>/.dsh/skills`
automatically through the `standard` preset's `skill-filesystem` row. The ECC
preset keeps that row unchanged, so the same surface works when this repo is
opened with `dsh web`.

## Install into the DSH home

From this repository:

```bash
./install.sh --target dsh
```

This copies `.dsh/` into `$DSH_HOME` (`~/.dsh` by default), making `ecc`
appear in the agent preset picker. Select it, or set it as the default:

```yaml
# ~/.dsh/settings.yaml
agent-presets:
  default: ecc
```

Re-run the installer after pulling an ECC update.

Validate without booting DSH:

```bash
npm run dsh:validate
npm run dsh:install -- --check
npm run dsh:drift
```

With the `dsh` binary on PATH, run the live roster + mount smoke:

```bash
npm run dsh:smoke
```

Run the keyless full-lifecycle test (local mock DeepSeek SSE server; no API
key and no real model traffic):

```bash
npm run dsh:e2e
```

With `DEEPSEEK_API_KEY` set, run the real-model acceptance test:

```bash
npm run dsh:real-e2e
```

Or reuse an already-running `dsh web` whose credentials are configured (the
script never reads or copies that process's key):

```bash
npm run dsh:real-e2e -- --base-url http://127.0.0.1:3080
```

## Use

In `dsh web` or `dsh tui`:

- Select the **ECC Engineering System** preset.
- Type `/ecc-goal <objective>` to queue a mission with the full phase protocol.
- For large fan-outs, the model can use DSH's `workflow` tool; the phase
  protocol tells it when.
- The model must call `ecc_verify` and pass every declared check before
  claiming completion. A human can also run the gate directly:

```bash
node -e "const c=require('./.ecc/dsh-verify.json'); console.log(c.checks.map(x=>x.command).join(' && '))"
```

## Optional retrieval bridges

Two MCP rows ship disabled by default:

- Context7 (external library docs): `ECC_DSH_MCP_CONTEXT7=1` and optional
  `CONTEXT7_API_KEY`.
- CodeGraph (project symbol graph): run `codegraph init` once, then
  `ECC_DSH_MCP_CODEGRAPH=1`.

## Drift policy

DSH is a developer preview. The preset base is pinned to `0.1.0-rc.6` and
`scripts/dsh-validate-preset.js` checks that every upstream row this preset
reuses still exists with the expected package name. When upstream changes a
row name or config contract, update the preset and the pinned version in the
same commit.
