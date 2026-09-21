import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import semver from 'semver'
import { dshVersion as CURRENT_DSH_RELEASE, previousDshVersion as PREVIOUS_DSH_RELEASE } from './project.mjs'

const DSH_PEERS = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-util-values',
]

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
for (const name of DSH_PEERS) {
  const range = pkg.peerDependencies?.[name]
  assert.equal(typeof range, 'string', `missing peer dependency ${name}`)
  assert.equal(semver.satisfies(CURRENT_DSH_RELEASE, range), true, `${name} must accept the current DSH release`)
  assert.equal(semver.satisfies(PREVIOUS_DSH_RELEASE, range), false, `${name} must reject releases older than the audited baseline`)
  assert.equal(semver.satisfies('0.2.0', range), false, `${name} must not silently accept the next minor contract`)
}

for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} must be optional because DSH profiles supply runtime peers through module fallback`)
}

assert.equal(semver.satisfies('22.19.0', pkg.engines.node), true, 'Node 22.19.0 must remain the minimum compatibility target')
assert.equal(semver.satisfies('24.0.0', pkg.engines.node), true, 'Node 24 must be supported')
assert.equal(semver.satisfies('22.18.0', pkg.engines.node), false, 'Node releases below 22.19.0 must be rejected')
