<!-- Thanks for contributing to Pathrule Core! Please complete the checklist below. -->

## What this changes

<!-- One or two sentences. Link any related issue, e.g. "Closes #123". -->

## Type

<!-- Pick one. This mirrors Conventional Commits; your PR title should match, e.g. "fix(local-backend): ...". -->

- [ ] `fix`: bug fix (no API change)
- [ ] `feat`: new capability
- [ ] `perf` / `refactor`: behavior-preserving change
- [ ] `docs` / `test` / `chore`
- [ ] Breaking change (describe the migration below)

## Contributor checklist

- [ ] **DCO sign-off**: every commit is signed off (`git commit -s`). PRs with unsigned commits cannot be merged. See [CONTRIBUTING.md](CONTRIBUTING.md).
- [ ] **Tests pass**: `pnpm install && pnpm typecheck && pnpm test` is green locally.
- [ ] **Behavior is contract-tested**: backend behavior changes have an assertion in the `KnowledgeBackend` contract suite (`packages/core/src/backend/contract-suite.ts`), so the in-memory reference and the SQLite backend stay in parity.
- [ ] **No cloud coupling**: `@pathrule/core` imports nothing cloud (no Supabase, billing, auth, or network requirement). New cloud-style capabilities go behind the `KnowledgeBackend` seam as optional, key-gated methods that degrade gracefully.
- [ ] **Deterministic by default**: the change works with zero API keys and zero network; any LLM or embedding path is an optional adapter, never a requirement.
- [ ] **Conventional title**: the PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): summary`).
- [ ] **Shape changes flagged**: if a backend result shape changed, I called it out above (it is breaking for every edition).

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, things you are unsure about. -->
