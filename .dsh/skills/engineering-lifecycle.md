---
name: engineering-lifecycle
description: Native DeepSeek Harness operating procedure for the ECC Agent Engineering System. Use for any non-trivial software engineering task that must go from requirements through planning, execution, testing, review, repair, verification, and delivery with logged evidence.
whenToUse: non-trivial feature work, defect repair, refactoring, or multi-file engineering missions on DeepSeek Harness.
---

# ECC-DSH Engineering Lifecycle

This skill is the loadable companion to the `ecc:engineering-system` prompt
section in the `ecc` preset. Read it when the task is complex or when a phase
gate is unclear.

## Phase gates

| Phase | Entry evidence | Exit gate |
| --- | --- | --- |
| Requirements | User objective; ambiguity list | Objective, success criteria, constraints, non-goals stated |
| Plan | Code inspection: read, grep, glob, non-mutating checks | Decision-complete plan; plan mode approved or todo_write plan recorded |
| Execute | Approved/recorded plan | Small verified increments; changed files match plan |
| Test | Targeted tests | Tests added/updated; targeted suite passes; failures read |
| Review | Fresh subagent/workflow reviewer | CRITICAL/HIGH findings triaged; fixes verified |
| Repair | Failed review or test evidence | Fix implemented; relevant tests pass |
| Verify | Review passed; tests green | `ecc_verify` all selected checks pass; acceptance evidence collected |
| Deliver | All gates above | Delivery report with run evidence and remaining risks |

## DSH-native machinery

- `create_goal` / `get_goal` / `update_goal`: persist one long-running
  objective; the host goal-round driver continues it between turns. Always
  read-before-update with the exact `goal_id` and `revision`.
- `todo_write`: implementation step tracking after a plan exists.
- `exit_plan_mode`: present a decision-complete plan when plan mode is active;
  do not mutate files before approval.
- `subagent` / `subagent_fork`: fresh or forked child agents for review and
  independent reasoning. Use a fresh `spawn` child for adversarial review.
- `workflow`: JavaScript orchestration for multi-file audits, parallel review,
  and multi-source verification. Scripts run in the worker-thread engine with
  `agent(prompt, opts)`, `pipeline`, and `parallel`; no filesystem or network.
- `ecc_verify`: execute the repository-owned verification gate
  (`.ecc/dsh-verify.json`). The model cannot inject commands through it.

## Verification evidence

For every completed task, the delivery report must list the exact verification
commands run, their observed pass/fail state, and any failing or skipped
surfaces. Never claim a result from memory. The session log is the
authoritative evidence trail.

## Multi-file review template

When a change spans several files, use the `workflow` tool with a script like
this (the `meta` object is a separate parameter, not part of the script body):

```js
const files = args.files;
const findings = await parallel(files.map(file => () => agent(
  `Review ${file} adversarially against the task requirements and the repository conventions. ` +
  `Return a JSON object: {file, verdict: "ok"|"issues", findings: [{severity, title, evidence}]}.`,
  { label: `review-${file}`, schema: {
    type: "object",
    required: ["file", "verdict", "findings"],
    properties: {
      file: { type: "string" },
      verdict: { enum: ["ok", "issues"] },
      findings: { type: "array", items: { type: "object" } },
    },
    additionalProperties: false,
  } },
)));
const verdict = await agent(
  `Adjudicate these file-review findings. Drop duplicates, promote only actionable issues, and return {verdict, acceptedFindings, rejectionReason?}.`,
  { label: "adjudicate", schema: { type: "object", required: ["verdict"], properties: {
    verdict: { enum: ["approved", "changes-required"] },
    acceptedFindings: { type: "array", items: { type: "object" } },
    rejectionReason: { type: "string" },
  }, additionalProperties: false } },
);
return { findings: findings.filter(Boolean), adjudication: verdict };
```

Respect the workflow engine's schema subset: use only `type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, and exact-one
`oneOf`. Never add `pattern`, `format`, numeric bounds, or `required: true`
inside a property schema.
