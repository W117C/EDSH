/**
 * ecc-plan-control — model-facing entry into DSH plan mode.
 *
 * DSH's plan mode is normally entered by the human `/plan` command. This tool
 * lets the agent enter plan mode itself on a direct user mission, which is
 * what the ECC lifecycle requires for autonomous long-running work. Leaving
 * plan mode still requires either `exit_plan_mode` review approval or the
 * human `/plan off` command, so the human approval boundary is preserved.
 */
export const name = 'ecc-plan-control'
export const inject = ['tools', 'planMode']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'ecc_plan',
    description: 'Enter DSH plan mode for the current session. Use before mutating files for a complex or long-running engineering mission. Once active, inspect the repository, then present a decision-complete plan through exit_plan_mode; only an approved plan or /plan off leaves plan mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        required: ['active', 'queued'],
        additionalProperties: false,
        properties: {
          active: { type: 'boolean' },
          queued: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.active
          ? (value.queued
            ? 'Plan mode queued: it applies from the next request.'
            : 'Plan mode is active.')
          : 'Plan mode could not be activated.',
      }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) {
        throw new Error('ecc_plan requires a calling agent')
      }
      const outcome = ctx.planMode.set(exec.agent, true)
      const current = ctx.planMode.get(exec.agent)
      return {
        active: current.active || current.pending === true,
        queued: outcome === 'queued',
      }
    },
  }))
}
