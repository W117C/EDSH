# ECC-DSH Acceptance Evidence

Recorded: 2026-08-16

This page is the durable acceptance record for the native DeepSeek Harness
Agent Engineering System. The acceptance run used the operator's already
running `dsh web`; the harness never read or copied that process's
credentials.

## Real DeepSeek model run

Command:

```bash
npm run dsh:real-e2e -- --base-url http://127.0.0.1:3080
```

Result:

```text
DeepSeek Harness real-model e2e: PASS (reused running dsh web)
- session: session-af64bfb5-4f3d-4be0-8990-13dd55d0f7ff
- artifact: ecc-real-smoke.txt
- verification evidence: real-ecc-ok
- delivery phrase: REAL_DELIVERY_OK
```

Durable session-log review confirmed the same facts independently:

- `ecc-real-smoke.txt` appears in the session history;
- `ecc_verify` is logged and its result contains `real-ecc-ok`;
- the final assistant message contains `REAL_DELIVERY_OK`;
- the running web process stayed alive and was not restarted.

## Keyless full lifecycle

Command: `npm run dsh:e2e`

Covered phases:

- `create_goal` and the automatic goal round;
- `ecc_plan` -> plan-mode policy -> `exit_plan_mode` -> approved plan;
- foreground independent `subagent` review;
- two-agent `workflow` fan-out;
- repository-owned `ecc_verify` with real session-cwd test execution;
- completion-gate repair path: blocked completion, added verification and
  review, successful retry;
- real `bash` code production (`app.js`) verified by a real `node` test;
- `session.fork` replay and cold web-process resume.

## Regression gate

`npm test` on a clean HOME: 3925/3925 passed.

Structural gates:

- `npm run dsh:validate`: PASS
- `npm run dsh:drift`: PASS
- `npm run dsh:smoke`: PASS
- `npm run harness:adapters -- --check`: PASS
- `npm pack` publish-surface: PASS

## Compliance state

DeepSeek Harness is recorded as `Native` in
`docs/architecture/harness-adapter-compliance.md`.
