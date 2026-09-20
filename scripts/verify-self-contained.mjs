import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinnedGitHubDependency } from './project.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ignored = new Set(['.git', 'lib', 'node_modules'])
const extensions = new Set(['.js', '.json', '.md', '.mjs', '.ts', '.yaml', '.yml'])
const failures = []
const files = []
const inside = target => {
  const value = relative(root, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      try { if (!inside(realpathSync(full))) failures.push(`${relative(root, full)}: symlink leaves repository`) }
      catch { failures.push(`${relative(root, full)}: broken symlink`) }
    } else if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(full)
  }
}
walk(root)
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  if (extname(file) === '.md') {
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const value = match[1].trim().replace(/^<|>$/gu, '')
      if (value.startsWith('#') || /^[a-z][a-z+.-]*:/iu.test(value)) continue
      const target = resolve(dirname(file), value.split('#')[0])
      if (!inside(target) || !existsSync(target)) failures.push(`${relative(root, file)}: broken link ${value}`)
    }
  }
}
for (const required of [
  '.github/workflows/ci.yml',
  '.github/workflows/release-check.yml',
  'src/index.ts',
  'src/config.ts',
  'src/runtime.ts',
  'src/invariant.ts',
  'docs/dsh-plugin-contracts.md',
  'scripts/git-install-smoke.mjs',
  'scripts/project.mjs',
  'scripts/verify-release.mjs',
  'tests/plugin.spec.ts',
]) {
  if (!existsSync(join(root, required))) failures.push(`missing ${required}`)
}
const provider = pinnedGitHubDependency('dsh-as-a-verifier')
const workspaceConfig = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
const exactProviderBuildKey = `dsh-as-a-verifier@https://codeload.github.com/${provider.repository}/tar.gz/${provider.commit}: true`
if (!workspaceConfig.includes('blockExoticSubdeps: false')) failures.push('pnpm workspace must permit the pinned Git dependency edge')
if (!workspaceConfig.includes(exactProviderBuildKey)) failures.push('pnpm workspace does not authorize the exact provider archive')
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`self-contained repository verified (${files.length} text files)`)
