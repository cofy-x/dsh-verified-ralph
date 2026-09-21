/** Host-side verified Ralph orchestration over public subagent and verifier seams. @module dsh-verified-ralph/runner */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { VerifierUsage } from 'dsh-as-a-verifier'
import type { ResolvedConfig } from './config.ts'
import { decidePolicy, type CorrectionState } from './policy.ts'
import { buildRoundPrompt, correctionMessage } from './prompt.ts'
import { projectChildUsage, projectSessionSteps } from './projection.ts'
import { readReport, REPORT_SCHEMA } from './report.ts'
import type {
  RalphRoundReport,
  VerifiedRalphBudget,
  VerifiedRalphBudgetKind,
  VerifiedRalphChildUsage,
  VerifiedRalphResult,
  VerifiedRalphRound,
  VerifiedRalphStatus,
} from './types.ts'

export interface VerifiedRalphArgs {
  readonly objective: string
  readonly maxRounds?: number
  readonly maxVerifierCalls?: number
  readonly maxVerifierTokens?: number
  readonly maxWallTimeMs?: number
  readonly maxChildTokens?: number
}

function resolveCeiling(value: number | undefined, ceiling: number, field: string): number {
  const resolved = value ?? ceiling
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`verified Ralph ${field} must be a positive safe integer`)
  if (resolved > ceiling) throw new TypeError(`verified Ralph ${field} ${resolved} exceeds deployment ceiling ${ceiling}`)
  return resolved
}

interface RunLimits {
  readonly rounds: number
  readonly verifierCalls: number
  readonly verifierTokens: number
  readonly wallTimeMs: number
  readonly childTokens: number
}

function resolveLimits(args: VerifiedRalphArgs, config: ResolvedConfig): RunLimits {
  return {
    rounds: resolveCeiling(args.maxRounds, config.maxRounds, 'maxRounds'),
    verifierCalls: resolveCeiling(args.maxVerifierCalls, config.maxVerifierCalls, 'maxVerifierCalls'),
    verifierTokens: resolveCeiling(args.maxVerifierTokens, config.maxVerifierTokens, 'maxVerifierTokens'),
    wallTimeMs: resolveCeiling(args.maxWallTimeMs, config.maxWallTimeMs, 'maxWallTimeMs'),
    childTokens: resolveCeiling(args.maxChildTokens, config.maxChildTokens, 'maxChildTokens'),
  }
}

function usageTotal(rows: readonly VerifiedRalphRound[]): VerifierUsage {
  const values = rows.reduce((total, row) => ({
    calls: total.calls + row.usage.calls,
    inputTokens: total.inputTokens + row.usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + row.usage.cachedInputTokens,
    outputTokens: total.outputTokens + row.usage.outputTokens,
    reasoningTokens: total.reasoningTokens + row.usage.reasoningTokens,
  }), { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
  return {
    ...values,
    uncachedInputTokens: values.inputTokens - values.cachedInputTokens,
    cacheHitRate: values.inputTokens === 0 ? 0 : values.cachedInputTokens / values.inputTokens,
  }
}

function childUsageTotal(rows: readonly VerifiedRalphRound[]): VerifiedRalphChildUsage {
  return rows.reduce<VerifiedRalphChildUsage>((total, row) => ({
    inputTokens: total.inputTokens + row.childUsage.inputTokens,
    cacheReadTokens: total.cacheReadTokens + row.childUsage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + row.childUsage.cacheWriteTokens,
    outputTokens: total.outputTokens + row.childUsage.outputTokens,
    reasoningTokens: total.reasoningTokens + row.childUsage.reasoningTokens,
    totalTokens: total.totalTokens + row.childUsage.totalTokens,
  }), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 })
}

function verifierTokens(usage: VerifierUsage): number {
  return usage.inputTokens + usage.outputTokens
}

function budgetStatus(kind: Exclude<VerifiedRalphBudgetKind, 'rounds'>): VerifiedRalphStatus {
  switch (kind) {
    case 'verifier-calls': return 'verifier-call-budget-limited'
    case 'verifier-tokens': return 'verifier-token-budget-limited'
    case 'wall-time': return 'time-budget-limited'
    case 'child-tokens': return 'child-token-budget-limited'
  }
}

function budgetSnapshot(
  limits: RunLimits,
  progress: readonly VerifiedRalphRound[],
  roundsStarted: number,
  startedAt: number,
  exhausted: VerifiedRalphBudgetKind | null,
): VerifiedRalphBudget {
  const verifier = usageTotal(progress)
  const child = childUsageTotal(progress)
  return {
    limits: {
      rounds: limits.rounds,
      verifierCalls: limits.verifierCalls,
      verifierTokens: limits.verifierTokens,
      wallTimeMs: limits.wallTimeMs,
      childTokensPerRequest: limits.childTokens,
    },
    consumed: {
      rounds: roundsStarted,
      verifierCalls: verifier.calls,
      verifierTokens: verifierTokens(verifier),
      wallTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      childTokens: child.totalTokens,
    },
    exhausted,
  }
}

function terminalResult(
  runId: string,
  status: VerifiedRalphStatus,
  report: RalphRoundReport | null,
  progress: readonly VerifiedRalphRound[],
  config: ResolvedConfig,
  limits: RunLimits,
  roundsStarted: number,
  agentsStarted: number,
  startedAt: number,
  exhausted: VerifiedRalphBudgetKind | null = null,
): VerifiedRalphResult {
  const finalScore = progress.at(-1)?.score
  return {
    runId,
    status,
    roundsStarted,
    agentsStarted,
    report,
    progress,
    usage: usageTotal(progress),
    verification: {
      completionThreshold: config.completionThreshold,
      finalScore: finalScore ?? null,
      verified: status === 'verified-complete',
    },
    budget: budgetSnapshot(limits, progress, roundsStarted, startedAt, exhausted),
  }
}

/** Run one foreground sequence of fresh local children and gate every terminal decision. */
export async function runVerifiedRalph(
  ctx: Context,
  config: ResolvedConfig,
  args: VerifiedRalphArgs,
  parent: Agent,
  signal: AbortSignal,
): Promise<VerifiedRalphResult> {
  const objective = args.objective.trim()
  if (objective.length === 0) throw new TypeError('verified Ralph objective must be non-empty')
  const limits = resolveLimits(args, config)
  const provider = ctx.subagents.getProvider(config.subagentProvider)
  if (provider === undefined) throw new Error(`subagent provider "${config.subagentProvider}" is not registered`)
  if (!provider.capabilities.outputSchema) throw new Error(`subagent provider "${config.subagentProvider}" does not support structured output`)
  if (!provider.capabilities.agentOptions) throw new Error(`subagent provider "${config.subagentProvider}" does not support child token limits`)
  if (provider.inheritsParentContext) throw new Error(`subagent provider "${config.subagentProvider}" inherits parent context; verified Ralph requires fresh children`)

  const startedAt = performance.now()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('verified Ralph wall-time budget exhausted')), limits.wallTimeMs)
  const runSignal = AbortSignal.any([signal, deadline.signal])
  const runId = randomUUID()
  const progress: VerifiedRalphRound[] = []
  const scores: number[] = []
  let previous: RalphRoundReport | undefined
  let correction: CorrectionState | undefined
  let correctionText: string | undefined
  let roundsStarted = 0
  let agentsStarted = 0

  const execute = async (): Promise<VerifiedRalphResult> => {
    try {
      for (let round = 1; round <= limits.rounds; round += 1) {
      runSignal.throwIfAborted()
      const aggregate = usageTotal(progress)
      if (aggregate.calls + config.nEvaluations > limits.verifierCalls) {
        return terminalResult(runId, budgetStatus('verifier-calls'), previous ?? null, progress, config, limits, roundsStarted, agentsStarted, startedAt, 'verifier-calls')
      }
      if (verifierTokens(aggregate) >= limits.verifierTokens) {
        return terminalResult(runId, budgetStatus('verifier-tokens'), previous ?? null, progress, config, limits, roundsStarted, agentsStarted, startedAt, 'verifier-tokens')
      }
      roundsStarted += 1
      const run = await ctx.subagents.start(config.subagentProvider, {
        label: `Verified Ralph round ${round}`,
        prompt: [{ type: 'text', text: buildRoundPrompt(objective, round, limits.rounds, previous, correctionText) }],
        parent,
        signal: runSignal,
        agentOptions: { maxTokens: limits.childTokens },
        outputSchema: REPORT_SCHEMA,
      })
      agentsStarted += 1
      try {
        if (run.localAgent === undefined) {
          throw new Error(`subagent provider "${config.subagentProvider}" returned no localAgent; remote/report-only verification is forbidden`)
        }
        const childResult = await run.result
        if (childResult.stopReason === 'max-tokens') {
          return terminalResult(runId, budgetStatus('child-tokens'), previous ?? null, progress, config, limits, roundsStarted, agentsStarted, startedAt, 'child-tokens')
        }
        if (childResult.stopReason !== 'completed') {
          const detail = childResult.diagnostic === undefined ? '' : `: ${childResult.diagnostic}`
          throw new Error(`verified Ralph round ${round} child ended with ${childResult.stopReason}${detail}`)
        }
        const report = readReport(childResult.structured, config.maxHandoffChars)
        const events = run.localAgent.session.snapshotEvents()
        const steps = projectSessionSteps(events)
        const childUsage = projectChildUsage(events)
        const tracked = await ctx.verifier.track({
          problem: objective,
          steps,
          checkpointSteps: [steps.length],
          nEvaluations: config.nEvaluations,
          signal: runSignal,
        })
        scores.push(tracked.final)
        const policy = decidePolicy({
          round,
          score: tracked.final,
          scores,
          report,
          ...(correction === undefined ? {} : { correction }),
          atBudget: round === limits.rounds,
        }, config)
        correction = policy.correction
        correctionText = policy.issueCorrection ? correctionMessage(tracked.final, config.completionThreshold) : undefined
        const row: VerifiedRalphRound = {
          round,
          childId: String(run.id),
          score: tracked.final,
          verifierCalls: tracked.verifierCalls,
          usage: tracked.usage,
          childUsage,
          decision: policy.decision,
        }
        progress.push(row)
        previous = report
        if (policy.terminal !== undefined) {
          const exhausted = policy.terminal === 'budget-limited' ? 'rounds' : null
          return terminalResult(runId, policy.terminal, report, progress, config, limits, roundsStarted, agentsStarted, startedAt, exhausted)
        }
      } finally {
        await run.dispose()
      }
      }
      throw new Error('verified Ralph exhausted its loop without a terminal policy decision')
    } catch (error) {
      if (deadline.signal.aborted && !signal.aborted) {
        return terminalResult(runId, budgetStatus('wall-time'), previous ?? null, progress, config, limits, roundsStarted, agentsStarted, startedAt, 'wall-time')
      }
      throw error
    }
  }

  try {
    const result = await execute()
    return {
      ...result,
      budget: {
        ...result.budget,
        consumed: {
          ...result.budget.consumed,
          wallTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
