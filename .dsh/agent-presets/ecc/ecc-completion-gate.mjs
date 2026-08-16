/**
 * ecc-completion-gate — runtime interlock for goal completion.
 *
 * DSH's goal tools let the model call `update_goal action: complete`. This
 * plugin adds a `tools/pre-execute` waterfall listener that DENIES that call
 * before the goal mutation runs unless the current goal already has a
 * successful `ecc_verify` tool result AND a settled independent subagent
 * review after its own creation. A post-execute listener would be too late:
 * tool-goal commits the goal change inside its body, so the interlock must
 * run before execution.
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

function hasIndependentReview(events, goalId) {
  const cutoff = goalCreationSeq(events, goalId)
  // Background continuable children settle through an injected notice.
  if (events.some(event => (
    event?.type === 'user/message'
    && eventSeq(event) > cutoff
    && event.data?.source?.kind === 'subagent-settled'
  ))) {
    return true
  }
  // Foreground children settle through the subagent tool result itself.
  const reviewCallIds = new Set()
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.name === 'subagent' && eventSeq(event) > cutoff) {
      reviewCallIds.add(event.data.callId)
    }
  }
  for (const event of events) {
    if (event?.type !== 'tool/result' || eventSeq(event) <= cutoff) continue
    const callId = event.data?.message?.source?.callId
    if (callId === undefined || !reviewCallIds.has(callId)) continue
    const content = event.data?.message?.content?.[0]
    if (content?.isError !== true) return true
  }
  return false
}

function denialReason(hasVerify, hasReview) {
  if (!hasVerify && !hasReview) {
    return 'Goal completion blocked by ecc-completion-gate: this goal has neither a successful ecc_verify result nor an independent subagent review after it was created. Run a fresh subagent review and ecc_verify first, then call update_goal complete again.'
  }
  if (!hasReview) {
    return 'Goal completion blocked by ecc-completion-gate: this goal has a passing ecc_verify result but no independent subagent review after it was created. Delegate a fresh adversarial review, wait for its settlement, then call update_goal complete again.'
  }
  return 'Goal completion blocked by ecc-completion-gate: this goal has no successful ecc_verify result after it was created. Run ecc_verify, make every selected check pass, then call update_goal complete again.'
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'update_goal') return next()
    const args = completionArguments(exec.arguments)
    if (args?.action !== 'complete') return next()
    if (exec.agent === undefined) {
      return { kind: 'deny', reason: 'Goal completion blocked by ecc-completion-gate: no calling agent.' }
    }
    const hasVerify = hasPassingVerify(exec.agent.session.events, args.goal_id)
    const hasReview = hasIndependentReview(exec.agent.session.events, args.goal_id)
    if (!hasVerify || !hasReview) {
      return { kind: 'deny', reason: denialReason(hasVerify, hasReview) }
    }
    return next()
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'ecc:completion-gate',
    order: 121,
    text: 'Goal completion is mechanically blocked until the current goal has both a settled independent subagent review and a successful ecc_verify result. If update_goal complete fails with a completion-gate message, perform the missing phase first and retry with the current goal_id and revision.',
  }))
}
