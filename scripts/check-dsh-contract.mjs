import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dshCommit as EXPECTED_COMMIT, dshVersion as EXPECTED_VERSION } from './project.mjs'

const source = process.env.DSH_SOURCE_DIR
if (!source) throw new Error('DSH_SOURCE_DIR must point to the checked-out deepseek-harness release')

async function text(path) {
  return readFile(resolve(source, path), 'utf8')
}

const root = JSON.parse(await text('package.json'))
assert.equal(root.version, EXPECTED_VERSION, 'unexpected deepseek-harness release version')
assert.equal(root.packageManager, 'pnpm@11.7.0', 'unexpected deepseek-harness pnpm baseline')
assert.equal(root.engines?.node, '^22.19.0 || >=24.0.0', 'unexpected deepseek-harness Node baseline')

const subagentTypes = await text('packages/subagent/subagent/src/types.ts')
for (const contract of [
  'readonly outputSchema?: ObjectJsonSchema',
  'readonly agentOptions?: AgentOptions',
  'readonly localAgent: Agent | undefined',
  'readonly result: Promise<SubagentResult>',
  'readonly inheritsParentContext: boolean',
]) assert.match(subagentTypes, new RegExp(contract.replace(/[?*+()[\]{}\\|.^$]/g, '\\$&')), `missing subagent contract: ${contract}`)
for (const capability of ['readonly depthLimit: boolean', 'readonly toolFilter: boolean', 'readonly persona: boolean']) {
  assert.match(subagentTypes, new RegExp(capability), `missing subagent capability: ${capability}`)
}

const subagentService = await text('packages/subagent/subagent/src/index.ts')
assert.match(subagentService, /getProvider\(name: string\): SubagentProvider \| undefined/, 'subagent provider lookup changed')
assert.match(subagentService, /async start\(name: string, request: SubagentStartRequest\): Promise<SubagentRun>/, 'one-shot subagent start changed')

const session = await text('packages/core/session/src/types.ts')
for (const event of ["'step/start'", "'assistant/message'", "'tool/call'", "'tool/result'", "'step/end'"]) {
  assert.match(session, new RegExp(event), `session trajectory event ${event} is missing`)
}
assert.match(session, /'assistant\/message': \{[\s\S]*message: AssistantMessage[\s\S]*stream: AssistantStreamRecord\[\][\s\S]*usage\?: TokenUsage/, 'assistant message projection shape changed')
assert.match(session, /'tool\/call': \{ turn: number; step: number; callId: ToolCallId; name: string; arguments: string \}/, 'tool call projection shape changed')
assert.match(session, /export const SESSION_FORMAT_VERSION = 3/, 'expected audited DSH Session format v3')
const sessionRuntime = await text('packages/core/session/src/index.ts')
assert.match(sessionRuntime, /snapshotEvents\(/, 'immutable Session snapshot API changed')

const agentTypes = await text('packages/core/agent/src/runtime-types.ts')
assert.match(agentTypes, /maxTokens\?: number/, 'per-child output-token ceiling changed')

const tools = await text('packages/core/tools/src/index.ts')
assert.match(tools, /export \{\s*defineTool,/s, 'dsh-tools no longer exports defineTool')

const gitHead = process.env.DSH_SOURCE_COMMIT
if (gitHead !== undefined) assert.equal(gitHead, EXPECTED_COMMIT, 'compatibility checkout is not the audited DSH release commit')
