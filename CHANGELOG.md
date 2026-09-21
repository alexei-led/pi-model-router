# Changelog

## 0.6.1 — 2026-09-21

- Add compact human-readable route provenance to the Pi footer, widget and `/router status`: `🧭 Jev ✓` means Jev selected the route, `🧭 Jev ↪ base` means Jev ran but the local baseline was used, and no marker means Jev was not involved.
- Track closed route-guidance outcomes across Jev, classifier, bypass and baseline paths, including reusable tool continuations and explicit generation fallbacks without persisting remote text or credentials.
- Keep the normal footer uncluttered for turns without external route guidance; retain latency only as a short widget/status diagnostic.
- Add regression coverage for UI rendering, persistence compatibility, advisor fallback, continuation inheritance and privacy boundaries.

## 0.6.0 — 2026-09-21

- Add the optional `micro` tier with `off` thinking by default; all four tiers are configured model/effort choices, not security permissions. Existing three-tier and partial profiles remain supported.
- Replace keyword routing, task-size heuristics and phase inference with an eligible deterministic baseline. Add optional per-profile `baselineTier`; otherwise prefer medium, high, low, micro after capability filtering. Deprecated `rules` and `phaseBias` still load but are ignored with a value-free warning; remove them from configuration.
- Honor pins without prompt-derived promotion. Keep a soft generation-cost budget that prefers eligible medium-or-lower tiers for unpinned requests; advisor costs are excluded. Revalidate input and exact effort for every generation/fallback target.
- Add opt-in Jev System One Choice advice with user-only credentials, explicit profile privacy approval, bounded recent user/assistant/tool text, validated primary candidate IDs and no retry. Failure/uncertainty goes directly to baseline, not a classifier cascade.
- Cap Jev at 750 ms within the remaining 1500 ms advisory budget. The separate optional Pi classifier path retains its 10-second bound and supports all four tiers. Pins, budget policy, single candidates and tool continuations bypass advisors; caller abort prevents generation.
- Reuse validated bounded per-turn routes across interleaved tool continuations without private authentication APIs. Pi owns authentication and tool permissions; provider identity is not backend-login attestation.
- Persist only allowlisted decision metadata and closed reason codes; map obsolete sources to legacy, preserving pins/cost/settings. Keep advisor secrets, request text and raw responses out of router state and UI.
- Document private chezmoi/1Password rendering, external-data approval, deprecated configuration, fallback limits and verification boundaries. No work profile is enabled automatically.

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
