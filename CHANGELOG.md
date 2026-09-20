# Changelog

## 0.5.1 — 2026-09-20

- Delegate generation and classification through Pi's native model registry instead of duplicating auth/dispatch logic. Cover keyless and headers-only auth, native providers and credential URLs with in-memory SDK integration tests.
- Retry only before output; preserve aborts and partial output, reject unterminated streams, and record the actual fallback model.
- Use each attempted model's context limit and trim complete turns without discarding system messages or orphaning tool results.
- Resolve classifier choices against partial profiles, bound classifier requests, and reject malformed/error responses.
- Deep-copy and validate persisted state; reset snapshot deduplication across branches.
- Validate rule keywords and malformed profiles; avoid inherited-name lookups and respect non-reasoning tier declarations.
- Reject invalid debug/widget options, fix thinking completions, and avoid success notifications after failed switches.
- Replace sleep-based stream tests with real event streams; share typed fixtures and keep test helpers out of npm artifacts.
- Fail closed on npm registry lookup errors other than a missing version. Document the release and provenance verification procedure.

## 0.5.0 — 2026-09-20

This is the first release of the independently maintained `@alexeiled/pi-model-router` fork.

- Require Pi `0.86.0` or newer and test against the synchronized Pi 0.86.0 packages.
- Upgrade development tooling to TypeScript 7 and Vitest 5.
- Replace Prettier with pinned Biome 2.5.14 for lint, formatting, and import-order checks. Enforce the same read-only checks in CI, releases, and before publishing.
- Preserve the last selected router profile across new Pi sessions.
- Dispatch registered custom-provider streams when Pi exposes a provider-specific stream.
- Accept headers-only authentication used by providers such as Kimi Code OAuth.
- Apply credential-specific provider base URLs when Pi exposes them.
- Keep classifier requests isolated from the main conversation system prompt and tools.
- Ignore the startup thinking-level event emitted by newer Pi versions instead of turning it into a router-wide override.
- Keep the original MIT license and upstream attribution.
