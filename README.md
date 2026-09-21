# dsh-verified-ralph

English | [中文](README.zh.md)

`dsh-verified-ralph` is a standalone DeepSeek Harness function plugin that adds `verified_ralph` alongside the official `ralph` tool. Every round starts a fresh local child over the shared workspace, projects its immutable DSH session into observable trajectory steps, and asks `ctx.verifier` for an independent completion-progress score.

The plugin does not modify DSH core or redefine verifier APIs. It pins a reviewed `dsh-as-a-verifier` commit at build time and requires verifier protocol 1 with offline progress tracking at runtime; see the [compatibility baseline](docs/dsh-compatibility.md). Upstream attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

Install both Git bundles together. Neither package is published to npm:

```sh
dsh plugin --profile web add \
  github:cofy-x/dsh-as-a-verifier \
  github:cofy-x/dsh-verified-ralph
```

The Profile lockfile freezes the resolved commits. Update explicitly, then restart the Profile:

```sh
dsh plugin --profile web update dsh-as-a-verifier dsh-verified-ralph
```

For a reproducible deployment, choose immutable tags from the two repositories' Releases pages:

```sh
VERIFIER_TAG=vX.Y.Z
RALPH_TAG=vX.Y.Z
dsh plugin --profile web add \
  "github:cofy-x/dsh-as-a-verifier#$VERIFIER_TAG" \
  "github:cofy-x/dsh-verified-ralph#$RALPH_TAG"
```

Use the corresponding Headless profile commands when appropriate. Because this Git package deliberately pins another Git package, pnpm 11 callers must opt into that audited dependency edge and both prepare builds:

```yaml
blockExoticSubdeps: false
allowBuilds:
  dsh-verified-ralph@https://codeload.github.com/cofy-x/dsh-verified-ralph/tar.gz/<verified-ralph-commit>: true
  dsh-as-a-verifier@https://codeload.github.com/cofy-x/dsh-as-a-verifier/tar.gz/888fbb8cb39cd981611e52e02b37d0d49fe686b7: true
```

Replace `<verified-ralph-commit>` with the installed commit and copy pnpm's exact content-addressed keys after an update. Package-name-wide build approval is intentionally not used. The bundle inserts only `dsh-verified-ralph`; deployment owns the separate verifier row and credentials.

## Contract

The function plugin exports `name`, `inject`, `Config`, and `apply`, with no default export. It requires `tools`, `subagents`, `systemPrompt`, and `verifier`. Activation fails before registering guidance or tools unless `ctx.verifier.protocolVersion === 1` and `offlineProgressTracking` is available.

```ts
await tools.verified_ralph({
  objective: 'Implement the requested change and prove the relevant checks pass.',
  maxRounds: 8,
  maxVerifierCalls: 16,
  maxWallTimeMs: 900_000,
})
```

Every child receives only the immutable objective, round metadata, shared-workspace instructions, the previous bounded report, and optional fixed verifier correction. The configured provider must support structured output and per-child `agentOptions`, must not inherit parent context, and must return `localAgent`; remote/report-only fallback is forbidden.

After a successful child result, the plugin groups assistant messages, tool calls, and tool results between each `step/start` and `step/end`, then calls `ctx.verifier.track()` on the last completed step. The full task and projected child trajectory are sent to the configured DeepSeek verifier endpoint. Child sessions retain their ordinary prompts and trajectory; the parent retains the canonical final tool result. This plugin adds no custom session events.

Successful statuses are:

- `verified-complete`: the worker reported complete and progress met the completion threshold.
- `blocked`: a worker reported a concrete blocker; `verified` remains false.
- `stagnated`: verifier correction received its full grace period without sufficient gain.
- `budget-limited`: the configured/caller round cap was reached.
- `verifier-call-budget-limited`: the next round cannot fit within the verifier-call ceiling.
- `verifier-token-budget-limited`: metered verifier input plus completion tokens reached the ceiling.
- `time-budget-limited`: the wall-clock deadline cancelled the in-flight child or verifier work and all resources settled.
- `child-token-budget-limited`: a fresh child reached its per-request output-token ceiling.

Child, session, report, verifier, cancellation, or provider failures fail the whole tool call. Completion below threshold is converted into correction, never accepted or silently tied.

## Conservative policy

| Field | Default | Meaning |
| --- | --- | --- |
| `subagentProvider` | `spawn` | Fresh structured local provider |
| `maxRounds` | `256` | Default and deployment ceiling |
| `maxHandoffChars` | `16384` | Serialized worker report ceiling |
| `maxResultChars` | `16384` | Rendered parent text ceiling; canonical data is unchanged |
| `nEvaluations` | `2` | Verifier repeats per round |
| `completionThreshold` | `0.85` | Minimum independently scored completion |
| `stagnationWindow` | `3` | Recent rounds used to detect insufficient gain |
| `minProgressGain` | `0.05` | Gain required to clear stagnation/correction |
| `correctionGraceRounds` | `2` | Full rounds allowed after correction |
| `maxVerifierCalls` | `512` | Deployment/call ceiling; each round reserves `nEvaluations` before starting |
| `maxVerifierTokens` | `8388608` | Metered verifier input + completion tokens; checked before every later round |
| `maxWallTimeMs` | `3600000` | Foreground wall-clock deadline, including cleanup |
| `maxChildTokens` | `32768` | Output-token ceiling applied to every fresh child model request |

A rejected completion immediately issues correction. Otherwise, a full stagnation window whose last-to-first gain is below `minProgressGain` issues correction. A later score at least `minProgressGain` above the pre-correction best clears it; otherwise the run stops after the grace rounds.

The canonical result includes run/status counts, final report, every child id and score, per-round child/verifier usage and policy decision, aggregate usage, threshold, final score, `verified`, and a complete budget limits/consumption/exhaustion envelope. A budget may stop before any score exists, in which case `report` and `finalScore` are `null`. Verifier tokens come from the remote API's authoritative post-request usage; because the API exposes no exact preflight tokenizer, this limit prevents subsequent work but may be crossed by the final accepted evaluation. Calls, child output, rounds, and wall time have preflight or cancellation enforcement.

## Development

```sh
corepack enable pnpm
pnpm install
pnpm run verify:self-contained
pnpm run typecheck
pnpm test
pnpm run build
pnpm run prepare
```

The audited DSH/Node/pnpm and provider baselines are recorded in [docs/dsh-compatibility.md](docs/dsh-compatibility.md). CI runs the keyless suite on Linux and Windows, validates installation from the exact PR commit (including fork PRs), and boots both plugins with the official `ralph` in clean Web and Headless profiles.

The credentialed release gate is `pnpm run test:e2e:full -- --ref <exact-consumer-sha> --evidence <output.json>`. It installs exact Git commits into a temporary Headless profile and exercises the complete parent → `verified_ralph` → real `spawn` child → shared workspace → durable SessionEvent → DeepSeek verifier → policy path. The evidence file uses `dsh-verified-ralph-release-evidence/v1` and contains only exact component identities, endpoint kind, model, usage counters, terminal status, score, budget reason, runtime, and elapsed time. It never includes the API key, objective, prompts, reports, trajectories, tool arguments/results, run id, or child ids.

Releases are Git-only and manual: validate the exact `main` SHA with `release-check`, create an annotated immutable tag, wait for the tag check, then publish a non-draft GitHub Release. Local real-API E2E is required when backend, prompt, or decoder behavior changes.

## Boundaries

No DSH core changes, official `ralph` replacement, remote provider fallback, multimodal verification, background/process-resumable Ralph, currency pricing, UI, or alternate verifier backend are included.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream notices.
