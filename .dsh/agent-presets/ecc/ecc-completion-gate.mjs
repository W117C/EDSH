/**
 * ecc-completion-gate — runtime interlock for goal completion.
 *
 * DSH's goal tools let the model call `update_goal action: complete`. This
 * plugin adds a `tools/pre-execute` waterfall listener that DENIES that call
 * before the goal mutation runs unless the current goal already has a
 * successful `ecc_verify` tool result after its own creation. A post-execute
 * listener would be too late: tool-goal commits the goal change inside its
 * body, so the interlock must run before execution.
 */
export const name = 'ecc-completion-gate'
export const inject = ['tools', 'systemPrompt']

function completionArguments(args) {
  if (typeof args === 'string') {
    try {
      return completionArguments(JSON.parse(args))
    } catch {
      return undefined
    }
  }
  if (args === null || typeof args !== 'object') return undefined
  if (typeof args.action === 'string') return args
  return undefined
}

function toolResultText(event) {
  const message = event?.data?.message
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => {
      if (block?.type !== 'tool-result' || !Array.isArray(block.content)) return ''
      return block.content
        .filter(part => part?.type === 'text')
        .map(part => part.text ?? '')
        .join('\n')
    })
    .join('\n')
}

function eventSeq(event) {
  return typeof event?.seq === 'number' ? event.seq : 0
}

/** The sequence of the most recent create event for one goal id. */
function goalCreationSeq(events, goalId) {
  let cutoff = -1
  for (const event of events) {
    if (event?.type !== 'goal/change') continue
    const goal = event.data?.goal
    if (event.data?.operation !== 'create') continue
    if (goalId !== undefined && goal?.id !== undefined && goal.id !== goalId) continue
    cutoff = Math.max(cutoff, eventSeq(event))
  }
  return cutoff
}

function hasPassingVerify(events, goalId) {
  const cutoff = goalCreationSeq(events, goalId)
  const verifyCallIds = new Set()
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.name === 'ecc_verify' && eventSeq(event) > cutoff) {
      verifyCallIds.add(event.data.callId)
    }
  }
  if (verifyCallIds.size === 0) return false

  for (const event of events) {
    if (event?.type !== 'tool/result' || eventSeq(event) <= cutoff) continue
    const callId = event.data?.message?.source?.callId
    if (callId === undefined || !verifyCallIds.has(callId)) continue
    const message = event.data?.message
    const content = message?.content?.[0]
    if (content?.isError === true) continue
    const text = toolResultText(event)
    if (text.includes('"ok": true') || text.includes('"ok":true')) return true
  }
  return false
}

const DENY_COMPLETION = {
  kind: 'deny',
  reason: 'Goal completion blocked by ecc-completion-gate: this goal has no successful ecc_verify result after it was created. Run ecc_verify, make every selected check pass, then call update_goal complete again.',
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'update_goal') return next()
    const args = completionArguments(exec.arguments)
    if (args?.action !== 'complete') return next()
    if (exec.agent === undefined || !hasPassingVerify(exec.agent.session.events, args.goal_id)) {
      return DENY_COMPLETION
    }
    return next()
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'ecc:completion-gate',
    order: 121,
    text: 'Goal completion is mechanically blocked until a successful ecc_verify result exists in this session. If update_goal complete fails with a completion-gate message, run ecc_verify first and retry completion with the current goal_id and revision.',
  }))
}
