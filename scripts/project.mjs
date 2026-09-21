import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
export const packageName = manifest.name
export const pnpmVersion = manifest.packageManager?.match(/^pnpm@(.+)$/u)?.[1]
export const dshVersion = '0.1.5-rc.2'
export const previousDshVersion = '0.1.5-rc.1'
export const dshCommit = 'fb2c4b9e698e30edb738bca4cf0618587db7d203'

export function githubRepository(url) {
  const match = /^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/u.exec(url ?? '')
  if (match === null) throw new Error(`package repository is not a canonical GitHub URL: ${String(url)}`)
  return match[1]
}

export const repository = githubRepository(manifest.repository?.url)

export function pinnedGitHubDependency(name) {
  const spec = manifest.dependencies?.[name]
  const match = /^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git#([0-9a-f]{40})$/u.exec(spec ?? '')
  if (match === null) throw new Error(`${name} must be pinned to an exact GitHub commit`)
  return Object.freeze({ name, repository: match[1], commit: match[2], spec })
}

export function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  if (required) throw new Error(`missing ${name}`)
  return undefined
}

export function run(command, args, options = {}) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export function assertPnpmVersion(cwd = root) {
  if (pnpmVersion === undefined) throw new Error('packageManager must pin an exact pnpm version')
  const actual = run('pnpm', ['--version'], { cwd }).trim()
  if (actual !== pnpmVersion) {
    throw new Error(`pnpm ${pnpmVersion} is required; PATH resolves pnpm ${actual}. Enable Corepack or install the declared version.`)
  }
}

export function assertGitHubRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error(`invalid GitHub repository: ${value}`)
  return value
}
