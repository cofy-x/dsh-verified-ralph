# dsh-verified-ralph

[English](README.md) | 中文

`dsh-verified-ralph` 是独立的 DeepSeek Harness function plugin，在官方 `ralph` 之外新增 `verified_ralph`。每个 Round 都启动共享工作区上的全新本地 child，将其不可变 DSH session 投影为可观察轨迹，再通过 `ctx.verifier` 独立评分任务完成进展。

插件不修改 DSH core，也不重新定义 verifier API。构建时固定经过审核的 `dsh-as-a-verifier` commit，运行时要求 verifier protocol 1 与离线 progress tracking；详见[兼容性基线](docs/dsh-compatibility.md)。上游归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安装

同时安装两个 Git bundle；二者都不发布到 npm：

```sh
dsh plugin --profile web add \
  github:cofy-x/dsh-as-a-verifier \
  github:cofy-x/dsh-verified-ralph
```

Profile lockfile 会固定解析出的 commit。升级需显式执行，并在完成后重启 Profile：

```sh
dsh plugin --profile web update dsh-as-a-verifier dsh-verified-ralph
```

需要稳定复现的部署应从两个仓库的 Releases 页面选择不可移动的 tag：

```sh
VERIFIER_TAG=vX.Y.Z
RALPH_TAG=vX.Y.Z
dsh plugin --profile web add \
  "github:cofy-x/dsh-as-a-verifier#$VERIFIER_TAG" \
  "github:cofy-x/dsh-verified-ralph#$RALPH_TAG"
```

Headless 使用对应 profile。由于本 Git package 有意固定依赖另一个 Git package，pnpm 11 调用方需要显式允许这条已审计的依赖边和两次 prepare 构建：

```yaml
blockExoticSubdeps: false
allowBuilds:
  dsh-verified-ralph@https://codeload.github.com/cofy-x/dsh-verified-ralph/tar.gz/<verified-ralph-commit>: true
  dsh-as-a-verifier@https://codeload.github.com/cofy-x/dsh-as-a-verifier/tar.gz/888fbb8cb39cd981611e52e02b37d0d49fe686b7: true
```

将 `<verified-ralph-commit>` 替换为实际安装的 commit；升级后复制 pnpm 输出的精确内容寻址键。这里有意不使用包名级的宽泛构建授权。bundle 只插入 `dsh-verified-ralph`；verifier row 与凭据由部署单独管理。

## 合同

插件导出 `name`、`inject`、`Config`、`apply`，没有 default export；必需服务为 `tools`、`subagents`、`systemPrompt`、`verifier`。除非 `ctx.verifier.protocolVersion === 1` 且提供 `offlineProgressTracking`，插件会在注册 guidance 和工具前直接拒绝加载。

```ts
await tools.verified_ralph({
  objective: '实现需求并证明相关检查通过。',
  maxRounds: 8,
  maxVerifierCalls: 16,
  maxWallTimeMs: 900_000,
})
```

每个 child 只接收不可变 objective、Round 信息、共享工作区说明、上一轮有界 report 和可选的固定 verifier 纠偏。provider 必须支持 structured output 与逐 child `agentOptions`、不得继承 parent context，并且必须返回 `localAgent`；禁止远程或 report-only 降级。

child 成功结束后，插件按 `step/start`—`step/end` 聚合 assistant message、tool call 和 tool result，再调用 `ctx.verifier.track()` 评分最后一个完成 step。完整任务和投影后的 child 轨迹会发送到配置的 DeepSeek verifier endpoint。child session 保存普通 prompt/轨迹，parent 保存规范化最终工具结果；插件不增加自定义 session event。

成功状态：

- `verified-complete`：worker 报告完成且独立分数达到阈值。
- `blocked`：worker 报告具体 blocker，`verified` 保持 false。
- `stagnated`：完整纠偏宽限期后仍未取得足够进展。
- `budget-limited`：达到部署或调用 Round 上限。
- `verifier-call-budget-limited`：下一轮无法容纳在 verifier call ceiling 内。
- `verifier-token-budget-limited`：verifier 实际 input + completion token 已达到上限。
- `time-budget-limited`：墙钟期限取消进行中的 child/verifier，并等待资源收敛。
- `child-token-budget-limited`：fresh child 达到单次请求 output token ceiling。

child、session、report、verifier、取消或 provider 失败都会让整个工具失败。低于阈值的完成声明只会触发纠偏，绝不会被接受或静默视为平局。

## 保守策略

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `subagentProvider` | `spawn` | 全新 structured 本地 provider |
| `maxRounds` | `256` | 默认值与部署 ceiling |
| `maxHandoffChars` | `16384` | worker report 序列化上限 |
| `maxResultChars` | `16384` | parent 渲染文本上限，不改变 canonical data |
| `nEvaluations` | `2` | 每 Round verifier repeats |
| `completionThreshold` | `0.85` | 独立完成阈值 |
| `stagnationWindow` | `3` | 停滞检测窗口 |
| `minProgressGain` | `0.05` | 清除停滞/纠偏所需增益 |
| `correctionGraceRounds` | `2` | 纠偏后的完整宽限 Round 数 |
| `maxVerifierCalls` | `512` | 部署/调用上限；每轮开始前预留 `nEvaluations` |
| `maxVerifierTokens` | `8388608` | verifier 实际 input + completion token；后续每轮前检查 |
| `maxWallTimeMs` | `3600000` | 包含清理在内的前台墙钟期限 |
| `maxChildTokens` | `32768` | 每个 fresh child 模型请求的 output token ceiling |

被拒绝的完成声明会立即触发纠偏；否则当完整窗口首尾增益低于 `minProgressGain` 时触发。后续分数达到纠偏前最佳值加 `minProgressGain` 会清除纠偏，否则在宽限 Round 后停止。

canonical result 包含运行状态与计数、最终 report、每个 child id/分数、逐轮 child/verifier usage 与策略决策、聚合 usage、阈值、最终分数、`verified`，以及完整预算 limit/consumption/exhaustion envelope。预算可能在首个分数前终止，此时 `report` 与 `finalScore` 为 `null`。Verifier token 来自远端 API 请求完成后的权威 usage；API 没有提供可精确预检的 tokenizer，因此它会阻止后续工作，但最后一个已接受 evaluation 可能越过 token ceiling。调用数、child output、Round 与墙钟均有预检或取消边界。

## 开发

```sh
corepack enable pnpm
pnpm install
pnpm run verify:self-contained
pnpm run typecheck
pnpm test
pnpm run build
pnpm run prepare
```

已审核的 DSH/Node/pnpm 与 provider 基线记录在 [docs/dsh-compatibility.md](docs/dsh-compatibility.md)。CI 在 Linux、Windows 上运行 keyless suite，从 PR 的精确 commit 验证安装（包括 fork PR），并在干净的 Web、Headless Profile 中同时启动两个插件与官方 `ralph`。

带凭据的发布门禁为 `pnpm run test:e2e:full -- --ref <exact-consumer-sha> --evidence <output.json>`。它把精确 Git commit 安装进临时 Headless Profile，并执行完整 parent → `verified_ralph` → 真实 `spawn` child → 共享工作区 → durable SessionEvent → DeepSeek verifier → policy 链路。evidence 使用 `dsh-verified-ralph-release-evidence/v1`，仅包含精确组件身份、endpoint 类型、模型、usage 计数、终止状态、分数、预算原因、运行环境和耗时；绝不包含 API key、objective、prompt、report、轨迹、工具参数/结果、run id 或 child id。

发布保持人工、仅 Git：先用 `release-check` 验证精确 `main` SHA，再创建不可移动的 annotated tag；tag 检查通过后发布非 draft 的 GitHub Release。backend、prompt 或 decoder 行为变化时，必须运行本地真实 API E2E。

## 边界

不修改 DSH core，不替换官方 `ralph`，不支持远程 provider 降级、多模态、后台/进程恢复 Ralph、货币价格预算、UI 或其他 verifier backend。

## 许可

[MIT](LICENSE)。上游声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
