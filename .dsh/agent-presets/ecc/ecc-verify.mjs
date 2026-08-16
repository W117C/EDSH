/**
 * ecc-verify — deterministic verification tool for the ECC-DSH preset.
 *
 * Executes ONLY commands declared in the repository's `.ecc/dsh-verify.json`.
 * The model can choose which declared check to run; it can never supply a
 * shell command through this tool. This keeps the verification surface
 * reviewable in git instead of model- or prompt-defined.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const name = 'ecc-verify'
export const inject = ['tools', 'shell', 'systemPrompt']

const MAX_OUTPUT_CHARS = 12000
const DEFAULT_TIMEOUT_MS = 180000

function tailText(value) {
  const text = String(value ?? '')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(-MAX_OUTPUT_CHARS)
}

function sessionCwd(exec) {
  // The gate belongs to the project the agent is working in, not to the
  // process launch directory of `dsh web`/`dsh tui`.
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

async function loadConfig(exec) {
  const path = resolve(sessionCwd(exec), '.ecc', 'dsh-verify.json')
  const raw = await readFile(path, 'utf8')
  const config = JSON.parse(raw)

  if (config === null || typeof config !== 'object' || !Array.isArray(config.checks)) {
    throw new Error(`invalid verification config at ${path}: expected { "checks": [...] }`)
  }

  for (const check of config.checks) {
    if (
      check === null
      || typeof check !== 'object'
      || typeof check.name !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(check.name)
      || typeof check.command !== 'string'
      || check.command.trim().length === 0
    ) {
      throw new Error(`invalid verification config at ${path}: each check needs a kebab-case name and a non-empty command`)
    }
  }

  return config
}

function selectChecks(config, requested) {
  if (requested === undefined || requested === null || requested === '') return config.checks
  const names = new Set(config.checks.map(check => check.name))
  if (!names.has(requested)) {
    throw new Error(`unknown verification check "${requested}"; available checks: ${[...names].join(', ')}`)
  }
  return config.checks.filter(check => check.name === requested)
}

async function runCheck(ctx, check, signal, workdir) {
  const request = {
    command: check.command,
    workdir,
    timeoutMs: Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0
      ? check.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    stdoutMaxBytes: 262144,
    signal,
  }
  const result = await ctx.shell.run(ctx.shell.resolve(request))
  return {
    name: check.name,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: tailText(result.stdout.text),
    stderr: tailText(result.stderr.text),
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'ecc_verify',
    description: 'Run the repository-owned verification gate from .ecc/dsh-verify.json and return pass/fail evidence. Call this before claiming any engineering task is complete; call it with "check" to rerun one declared check after a fix. This tool never accepts a shell command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check: {
          type: 'string',
          description: 'Optional check name from .ecc/dsh-verify.json. Omit to run every declared check.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['ok', 'selected', 'checks'],
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          selected: { type: 'array', items: { type: 'string' } },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'exitCode', 'timedOut', 'aborted', 'stdout', 'stderr'],
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                aborted: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const config = await loadConfig(exec)
      const checks = selectChecks(config, args?.check)
      const workdir = sessionCwd(exec)
      const results = []
      for (const check of checks) {
        results.push(await runCheck(ctx, check, exec.signal, workdir))
      }
      const ok = results.every(check => (
        check.exitCode === 0 && !check.timedOut && !check.aborted
      ))
      return {
        ok,
        selected: results.map(check => check.name),
        checks: results,
      }
    },
  }))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'ecc:verify-gate',
    order: 120,
    text: 'Before reporting any engineering task as complete, run ecc_verify and make every selected check pass. Never claim a check passed from memory or from an earlier run; cite the ecc_verify result you just received.',
  }))
}
