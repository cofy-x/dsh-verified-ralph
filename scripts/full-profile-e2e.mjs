import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  argument,
  assertPnpmVersion,
  dshCommit as DSH_COMMIT,
  dshVersion as DSH_VERSION,
  packageName as CONSUMER_NAME,
  pinnedGitHubDependency,
  repository as CONSUMER_REPOSITORY,
  run,
} from './project.mjs'

const PROVIDER_NAME = 'dsh-as-a-verifier'
const provider = pinnedGitHubDependency(PROVIDER_NAME)
const PROVIDER_REPOSITORY = provider.repository
const PROVIDER_COMMIT = provider.commit

function filesBelow(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesBelow(path))
    else files.push(path)
  }
  return files
}

function parseRenderedResult(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const value = JSON.parse(text.slice(start))
    return value?.runId !== undefined && value?.budget !== undefined ? value : undefined
  } catch {
    return undefined
  }
}

function findVerifiedResult(sessionRoot) {
  for (const path of filesBelow(sessionRoot).filter(candidate => candidate.endsWith('.jsonl'))) {
    const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const calls = new Set(events
      .filter(event => event.type === 'tool/call' && event.data?.name === 'verified_ralph')
      .map(event => event.data.callId))
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      for (const envelope of event.data?.message?.content ?? []) {
        if (envelope.type !== 'tool-result' || !calls.has(envelope.toolCallId) || envelope.isError) continue
        for (const block of envelope.content ?? []) {
          if (block.type !== 'text') continue
          const parsed = parseRenderedResult(block.text)
          if (parsed !== undefined) return parsed
        }
      }
    }
  }
  throw new Error('full profile e2e found no durable verified_ralph result')
}

const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (!apiKey) {
  console.log('full profile e2e skipped: DEEPSEEK_API_KEY is not set')
  process.exit(0)
}

const consumerCommit = argument('--ref')
const evidencePath = resolve(argument('--evidence'))
if (!/^[0-9a-f]{40}$/.test(consumerCommit)) throw new Error('full e2e ref must be an exact commit SHA')
assertPnpmVersion()

const workspace = mkdtempSync(join(tmpdir(), 'dsh-verified-ralph-full-e2e-'))
const launcher = join(workspace, 'launcher')
const project = join(workspace, 'project')
const home = join(workspace, 'home')
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'danger-full-access',
}

const startedAt = Date.now()
try {
  mkdirSync(launcher)
  mkdirSync(project)
  writeFileSync(join(launcher, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.7.0' }, null, 2))
  writeFileSync(join(launcher, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'allowBuilds:',
    `  '@deepseek-ai/dsh-subprocess-local@${DSH_VERSION}': true`,
    "  '@google/genai@1.52.0': true",
    "  'koffi@3.3.1': true",
    "  'node-pty@1.2.0-beta.15': true",
    "  'protobufjs@7.6.6': true",
    '',
  ].join('\n'))
  run('pnpm', ['add', '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: launcher, env })
  const require = createRequire(join(launcher, 'e2e.cjs'))
  const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'))
  const bin = join(dirname(dshManifestPath), dshManifest.bin.dsh)

  run(process.execPath, [bin, '--profile', 'headless', '--dump-config'], { cwd: project, env })
  const profileDir = join(home, 'profiles', 'headless')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'blockExoticSubdeps: false',
    'allowBuilds:',
    `  '${CONSUMER_NAME}@https://codeload.github.com/${CONSUMER_REPOSITORY}/tar.gz/${consumerCommit}': true`,
    `  '${PROVIDER_NAME}@https://codeload.github.com/${PROVIDER_REPOSITORY}/tar.gz/${PROVIDER_COMMIT}': true`,
    '',
  ].join('\n'))
  run(process.execPath, [bin, 'plugin', '--profile', 'headless', 'add', '--save-exact',
    `github:${PROVIDER_REPOSITORY}#${PROVIDER_COMMIT}`, `github:${CONSUMER_REPOSITORY}#${consumerCommit}`], { cwd: project, env })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    packChunks: false',
    '    compression: none',
    '    preparedSessionCacheSize: 64',
    '    writeBatchMaxDelayMs: 5',
    '- id: dsh-as-a-verifier',
    '  config:',
    '    model: deepseek-v4-flash',
    '    nEvaluations: 1',
    '    retryAttempts: 1',
    '    cacheEnabled: false',
    '- id: dsh-verified-ralph',
    '  config:',
    '    maxRounds: 1',
    '    nEvaluations: 1',
    '    completionThreshold: 0',
    '    maxVerifierCalls: 1',
    '    maxVerifierTokens: 1000000',
    '    maxWallTimeMs: 600000',
    '    maxChildTokens: 4096',
    '',
  ].join('\n'))

  const marker = 'verified-ralph-full-e2e-ok'
  const task = [
    'Call verified_ralph exactly once; do not perform the objective in the parent session.',
    `Use maxRounds 1. The immutable objective is: create verified-ralph-e2e.txt in the current workspace with the exact text ${marker}, read it back, and report complete with that read-back as evidence.`,
    'After the tool returns, briefly state its status.',
  ].join(' ')
  run(process.execPath, [bin, '--profile', 'headless', task], { cwd: project, env, timeout: 600_000 })
  if (readFileSync(join(project, 'verified-ralph-e2e.txt'), 'utf8').trim() !== marker) {
    throw new Error('fresh child did not create and verify the expected workspace artifact')
  }

  const result = findVerifiedResult(join(home, 'sessions'))
  if (result.status !== 'verified-complete' || result.verification?.verified !== true) {
    throw new Error(`full profile e2e did not reach verified completion (${String(result.status)})`)
  }
  const profileRequire = createRequire(join(profileDir, 'evidence.cjs'))
  const consumerEntry = profileRequire.resolve(CONSUMER_NAME)
  const consumer = await import(`${pathToFileURL(consumerEntry).href}?e2e=${Date.now()}`)
  const providerManifestPath = profileRequire.resolve(`${PROVIDER_NAME}/package.json`)
  const providerManifest = JSON.parse(readFileSync(providerManifestPath, 'utf8'))
  const consumerManifestPath = profileRequire.resolve(`${CONSUMER_NAME}/package.json`)
  const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, 'utf8'))
  const evidence = consumer.createReleaseEvidence(result, {
    deepseekHarness: { version: DSH_VERSION, commit: DSH_COMMIT },
    provider: { version: providerManifest.version, commit: PROVIDER_COMMIT },
    consumer: { version: consumerManifest.version, commit: consumerCommit },
    endpoint: process.env.DEEPSEEK_BASE_URL === undefined ? 'official' : 'custom',
    model: 'deepseek-v4-flash',
    elapsedMs: Date.now() - startedAt,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  })
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(`full profile e2e passed: ${result.status}; evidence ${evidencePath}`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
