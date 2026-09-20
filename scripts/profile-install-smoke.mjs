import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  argument,
  assertGitHubRepository,
  assertPnpmVersion,
  dshVersion as DSH_VERSION,
  packageName as CONSUMER_NAME,
  pinnedGitHubDependency,
  repository as DEFAULT_CONSUMER_REPOSITORY,
  run,
} from './project.mjs'

const PROVIDER_NAME = 'dsh-as-a-verifier'
const provider = pinnedGitHubDependency(PROVIDER_NAME)
const PROVIDER_REPOSITORY = provider.repository
const PROVIDER_COMMIT = provider.commit

function countRows(dump, id) {
  return (dump.match(new RegExp(`id: ${id}\\b`, 'g')) ?? []).length
}

const ref = argument('--ref')
const CONSUMER_REPOSITORY = assertGitHubRepository(argument('--repository', { required: false }) ?? DEFAULT_CONSUMER_REPOSITORY)
if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('profile smoke ref must be an exact commit SHA')
assertPnpmVersion()

const workspace = mkdtempSync(join(tmpdir(), 'dsh-verified-ralph-profile-smoke-'))
const launcher = join(workspace, 'launcher')
const home = join(workspace, 'home')
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: '',
}

try {
  mkdirSync(launcher)
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
  run('pnpm', ['add', '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: launcher, env, timeout: 120_000 })
  const require = createRequire(join(launcher, 'smoke.cjs'))
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== DSH_VERSION) throw new Error(`installed DSH ${manifest.version}, expected ${DSH_VERSION}`)
  const bin = join(dirname(manifestPath), manifest.bin.dsh)

  for (const profile of ['web', 'headless']) {
    run(process.execPath, [bin, '--profile', profile, '--dump-config'], { cwd: workspace, env, timeout: 120_000 })
    const profileDir = join(home, 'profiles', profile)
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), [
      'packages:',
      "  - '.'",
      'blockExoticSubdeps: false',
      'allowBuilds:',
      `  '${CONSUMER_NAME}@https://codeload.github.com/${CONSUMER_REPOSITORY}/tar.gz/${ref}': true`,
      `  '${PROVIDER_NAME}@https://codeload.github.com/${PROVIDER_REPOSITORY}/tar.gz/${PROVIDER_COMMIT}': true`,
      '',
    ].join('\n'))
    run(process.execPath, [bin, 'plugin', '--profile', profile, 'add', '--save-exact',
      `github:${PROVIDER_REPOSITORY}#${PROVIDER_COMMIT}`, `github:${CONSUMER_REPOSITORY}#${ref}`], { cwd: workspace, env, timeout: 120_000 })
    const lockfile = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    for (const identity of [`codeload.github.com/${PROVIDER_REPOSITORY}/tar.gz/${PROVIDER_COMMIT}`, `codeload.github.com/${CONSUMER_REPOSITORY}/tar.gz/${ref}`]) {
      if (!lockfile.includes(identity)) throw new Error(`${profile} profile lockfile omitted ${identity}`)
    }
    const dump = run(process.execPath, [bin, '--profile', profile, '--dump-config'], { cwd: workspace, env, timeout: 120_000 })
    for (const id of [PROVIDER_NAME, CONSUMER_NAME, 'tool-ralph']) {
      const rows = countRows(dump, id)
      if (rows !== 1) throw new Error(`${profile} profile contains ${rows} ${id} rows`)
    }
    const help = run(process.execPath, [bin, '--profile', profile, '--help'], { cwd: workspace, env, timeout: 120_000 })
    if (!help.includes(`dsh --profile ${profile}`)) throw new Error(`${profile} profile did not reach its app help`)
  }
  console.log(`${CONSUMER_NAME} profile smoke passed on DSH ${DSH_VERSION} for ${ref} with provider ${PROVIDER_COMMIT}`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
