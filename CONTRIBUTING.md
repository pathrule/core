# Contributing to Pathrule Core

Thanks for considering a contribution! This repo is the open core of Pathrule. The paid product
consumes the **same package**, so improvements you land here ship to every edition automatically.

## Getting set up

```bash
git clone https://github.com/pathrule/core
cd core
pnpm install          # Node >= 20.11, pnpm 9 (corepack enable)
pnpm typecheck
pnpm test
```

`pnpm test` runs the `KnowledgeBackend` contract suite against both the in-memory reference
backend and the real SQLite `LocalBackend` (`:memory:`). If the two diverge, it fails. New
backend behavior belongs in that suite (`packages/core/src/backend/contract-suite.ts`) so parity
stays locked.

## What makes a good PR

- **Keep the one-way dependency rule.** `@pathrule/core` imports nothing cloud: no Supabase, no
  billing, no auth. CI enforces this; if your change needs a cloud capability, it belongs behind
  the `KnowledgeBackend` seam as an optional capability (see `routeIntent` / `semanticCandidates`
  for the pattern: key-gated, `null` when absent, graceful fallback).
- **Deterministic by default.** The local edition must work with zero keys and zero network.
  LLM/embedding-powered paths are optional adapters, never requirements.
- **Contract-test it.** Behavior changes need an assertion in the contract suite; shape changes
  to backend results are breaking for every edition, so call them out in the PR description.
- **Match the local style.** Comment the _why_, keep modules single-purpose, run
  `pnpm exec prettier --write` on touched files.

## How a PR reaches the product

This repo is synced one-way from our monorepo. We import your PR into the monorepo (preserving
authorship), run the full cross-edition release gate (cloud parity suite, edition guardrails,
secret scanners), and the next sync reflects it here. Your change ships in the next `@pathrule/cli`
release, local and cloud editions alike.

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/) instead of a CLA. Every commit must be signed
off, certifying you have the right to submit the work under Apache-2.0:

```bash
git commit -s -m "fix: …"
```

which adds a `Signed-off-by: Your Name <you@example.com>` trailer. PRs with unsigned commits
can't be merged.

## Reporting issues

- **Bugs / feature requests:** open a GitHub issue with repro steps (OS, Node version, AI client).
- **Security issues:** please do NOT open a public issue. Email security@pathrule.io instead.

## License

By contributing, you agree your contributions are licensed under [Apache-2.0](LICENSE).
