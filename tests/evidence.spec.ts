import { describe, expect, it } from 'vitest'
import { createReleaseEvidence } from '../src/evidence.ts'
import type { VerifiedRalphResult } from '../src/types.ts'

const sha = '1'.repeat(40)

const result: VerifiedRalphResult = {
  runId: 'secret-run-id',
  status: 'verified-complete',
  roundsStarted: 1,
  agentsStarted: 1,
  report: { status: 'complete', summary: 'private trajectory text', evidence: ['secret-key-value'], nextSteps: [], blocker: '' },
  progress: [{
    round: 1,
    childId: 'private-child-id',
    score: 0.91,
    verifierCalls: 1,
    usage: { calls: 1, inputTokens: 10, cachedInputTokens: 2, uncachedInputTokens: 8, outputTokens: 3, reasoningTokens: 1, cacheHitRate: 0.2 },
    childUsage: { inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2, totalTokens: 25 },
    decision: 'verified-complete',
  }],
  usage: { calls: 1, inputTokens: 10, cachedInputTokens: 2, uncachedInputTokens: 8, outputTokens: 3, reasoningTokens: 1, cacheHitRate: 0.2 },
  verification: { completionThreshold: 0.85, finalScore: 0.91, verified: true },
  budget: {
    limits: { rounds: 2, verifierCalls: 4, verifierTokens: 1000, wallTimeMs: 60_000, childTokensPerRequest: 1000 },
    consumed: { rounds: 1, verifierCalls: 1, verifierTokens: 13, wallTimeMs: 100, childTokens: 25 },
    exhausted: null,
  },
}

describe('release evidence', () => {
  it('keeps only allowlisted identities, counters, status, and timing', () => {
    const evidence = createReleaseEvidence(result, {
      generatedAt: '2026-08-31T00:00:00.000Z',
      deepseekHarness: { version: '0.1.5-rc.2', commit: sha },
      provider: { version: '0.2.7', commit: sha },
      consumer: { version: '0.2.1', commit: sha },
      endpoint: 'official',
      model: 'deepseek-v4-flash',
      elapsedMs: 1234,
      runtime: { node: 'v24.0.0', platform: 'linux', arch: 'x64' },
    })
    expect(evidence).toMatchObject({
      schema: 'dsh-verified-ralph-release-evidence/v1',
      verifier: { endpoint: 'official', model: 'deepseek-v4-flash', calls: 1 },
      run: { status: 'verified-complete', finalScore: 0.91, verified: true, elapsedMs: 1234 },
    })
    const serialized = JSON.stringify(evidence)
    for (const forbidden of ['secret-run-id', 'private-child-id', 'private trajectory text', 'secret-key-value']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('rejects mutable refs and malformed timing', () => {
    expect(() => createReleaseEvidence(result, {
      deepseekHarness: { version: '0.1.5-rc.2', commit: 'main' },
      provider: { version: '0.2.7', commit: sha },
      consumer: { version: '0.2.1', commit: sha },
      endpoint: 'official', model: 'deepseek-v4-flash', elapsedMs: -1,
      runtime: { node: 'v24', platform: 'linux', arch: 'x64' },
    })).toThrow()
  })
})
