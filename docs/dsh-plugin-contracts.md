# Standalone DSH Plugin Contracts

This package is a function plugin: one ESM namespace exports `name`, `inject`, `Config`, and `apply`, with no default export. Required services belong in `inject`; every registration and live operation belongs to its Cordis fiber or calling tool signal.

`dsh-verified-ralph` is a consumer of the generic `ctx.verifier` service and must not redefine verifier contracts. It may compose public `ctx.subagents`, `ctx.tools`, and `ctx.systemPrompt` seams without patching DSH core. Model-visible inputs are carried by ordinary child session messages and final tool results, not hidden mutable process state or downstream custom session events.

The profile bundle inserts only this plugin row. The verifier provider remains a separately installed row so deployments own its credentials and backend configuration. Git installation must build from repository-local configuration and exact declared dependencies. pnpm 11 consumers must explicitly set `blockExoticSubdeps: false` for the pinned verifier edge and allow both prepare scripts by their exact content-addressed codeload keys; package-name-wide approval and floating Git refs are not accepted substitutes.
