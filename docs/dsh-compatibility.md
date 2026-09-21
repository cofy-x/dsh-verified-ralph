# DSH and verifier compatibility baseline

`dsh-verified-ralph` 0.2.2 was audited against DeepSeek Harness
`dsh-v0.1.5-rc.2` at commit
`fb2c4b9e698e30edb738bca4cf0618587db7d203`, and against
`dsh-as-a-verifier` 0.2.7 at merge commit
`933887b40653cce24b8197441700ce947f36ce4e`.

The audit confirms that the one-shot fresh-agent seam still exposes provider
capabilities (including the newer depth, tool-filter, and persona flags),
`inheritsParentContext`, structured output, `localAgent`, a settling result
promise, and explicit disposal. The Session v3 projection still
receives balanced step boundaries plus durable assistant message settlements,
tool calls, and tool results in the fields consumed by `projectSessionSteps`.
Embedded assistant streams and failed attempt settlements remain durable DSH
evidence but are not duplicated into verifier trajectory text.

The provider remains verifier protocol 1 and advertises offline progress
tracking. The consumer pins its exact merge commit and its Git-install smoke
loads both built packages, rejects a default export, and checks protocol and
capability compatibility before accepting the installation.

The DSH release still supports Node `^22.19.0 || >=24.0.0` and uses pnpm 11.7.0.
Node 24 is the primary build, Git-install, and release-check runtime. CI also
runs the complete suite on the exact minimum Node 22.19.0 on Linux and Windows.

Development dependencies, profile/full E2E launchers, and the read-only source
check all use the published `0.1.5-rc.2` release. This release is the minimum
DSH peer version; older prereleases are no longer part of the compatibility
promise. The exact source commit remains pinned so a future DSH update must be reviewed deliberately.

All Harness-facing peers are optional in the package manifest. DSH profiles
supply them through the runtime module fallback rather than installing a second
copy into each profile, so a clean profile installation must also pass
`pnpm peers check` without manufacturing duplicate runtime dependencies.
