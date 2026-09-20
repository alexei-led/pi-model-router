# Changelog

## Unreleased

- Add the optional `micro` mechanical tier with `off` thinking by default; existing three-tier configs and saved sessions remain supported.
- Enforce local safety floors, image capabilities and exact model thinking support across pins, rules, budgets, advisor choices and fallback targets. Profiles without an eligible route now fail before generation rather than lowering safety.
- Add opt-in Jev System One Choice advice with user-only credentials and profile enablement, bounded task text, validated local route IDs and no routing retry.
- Share a 1500 ms routing deadline between Jev (at most 750 ms) and the Pi classifier; optional advisor failures retain local routing. Reuse validated same-turn tool routes before advisor calls.
- Persist only allowlisted decision metadata and closed reason codes; discard legacy free-form explanations and keep advisor secrets, request text and raw responses out of router state and UI.
- Document private chezmoi/1Password rendering, external-data approval, fallback limits and verification boundaries.

## 0.5.2 — 2026-09-20

- Fix context trimming so preserved system instructions count toward the actual token estimate.
- Display the thinking level used by the completed route, not a pending profile override.
- Separate classifier, context extraction and pure routing modules; share one runtime state adapter across provider and commands.
- Validate raw configuration at the boundary and enable strict TypeScript indexing, optional-property and unused-code checks.
- Add focused Biome async-safety, import-order, cycle and Node import rules.
- Use Vitest worker threads for the small suite; remove arbitrary test sleeps and obvious test comments while preserving the full assertion set.
- Align package metadata, architecture documentation and release instructions.

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
