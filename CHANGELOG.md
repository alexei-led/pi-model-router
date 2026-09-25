# Changelog

## [0.9.1] - 2026-09-25

### Changed

- Unpinned routing skips a route whose context window cannot hold the conversation at 90% fill, so a smaller model no longer silently drops old turns. If no route fits, the largest windows stay eligible and truncation still applies. A pin keeps its tier and truncates as before.
- A tool continuation that cannot reuse its record, for example after a context transform rewrites older history, keeps the model that issued the tool calls in its recorded tier instead of switching to the baseline mid-loop. A pin or budget decision still wins.

## [0.9.0] - 2026-09-24

### Upgrade requirements

- An unsupported thinking effort now runs at the nearest supported level, as in Pi: the next higher level, else the next lower level. Before, the router skipped that model and used its fallback, or found no route. For example, `/router thinking off` now runs `gpt-6-astra` at `minimal` and `claude-opus-5-5` at `low`.
- Only `thinkingLevels` declared on a tier or its model alias limit effort. Undeclared tiers are no longer limited to `low`, `medium`, and `high`, so `xhigh` and `max` run on models that support them.
- A tier whose primary model is ineligible now offers its first eligible fallback to Jev and the Pi classifier. Some profiles that bypassed advice with a single candidate now request advice.

### Changed

- `/router thinking` and Pi's thinking selector name each tier that runs another level, for example `high runs at minimal`.
- Pi's footer and thinking selector show the level that runs, including after a fallback. The router model lists `xhigh` and `max` only when a route runs them.

### Fixed

- Keep `jev`, `classifier`, or `pinned` as the decision source when routing chooses a fallback model on the first attempt. Only a mid-stream fallback reports `fallback`.
- Record a fully failed generation chain in `/router log` with a `[failed]` flag. `/router log` now shows the `[fallback]`, `[budget-limit]`, and `[failed]` flags.
- Keep the base profile, with a warning, when a project configuration overrides it with a non-object value.
- Warn on a `fallbacks` value that is not an array and on fallback entries that are not strings.
- Report Jev probability selection of a fallback-served baseline as a Jev choice. This removes the 0.8.0 known limitation.

## [0.8.0] - 2026-09-24

### Upgrade requirements

- Rename profiles that contain whitespace, have an empty name, or match `pin`, `thinking`, `log`, `widget`, `off`, `reload`, or `help`. These names are now ignored with a warning. Retired command names remain valid profile names.
- Budgets and model capacities must be positive, finite numbers. Invalid values are ignored with a warning.

### Fixed

- Preserve signed Google-family tool continuations by API, including Vertex, Gemini CLI, provider aliases, and text signatures. Do not replay them on another model during fallback.
- Remember the successful fallback when a reused same-turn route fails. Later reuse no longer returns to the failed primary.
- Honor standard `Retry-After` seconds and HTTP dates. Skip retries whose required delay exceeds the remaining advisory budget.
- Keep Jev abstention mass at the actual baseline tier, including when only an explicit generation fallback is eligible in that tier.
- Use own-property lookups for profile state. Profiles such as `constructor`, `toString`, and `hasOwnProperty` no longer inherit false pins or overrides.
- Persist the newest 50 debug decisions when otherwise-identical, zero-cost decisions rotate the history buffer.

### Documentation and release process

- Refresh the README, user guide, architecture, release procedure, and dated usage evidence.
- Clarify that user and project configuration can select the optional Pi classifier. It sends bounded recent text through Pi, separately from Jev approval.
- Generate GitHub release titles from the exact version tag.

### Known limitation

- Diagnostics can label probability-based selection of a fallback-only baseline as abstention and display the selected candidate's probability. Generation still uses the correct baseline.

## [0.7.1] - 2026-09-23

### Fixed

- Count reported generation costs from pre-content errors before trying a fallback, including chains that ultimately fail. Attempts without terminal usage remain unknown rather than claiming a complete request cost.
- Scope advice, single-flight and continuation keys to the caller's Pi session. Identical transcripts from different sessions no longer share routing advice; the provider's original `sessionId` is preserved.
- Refresh generation diagnostics after completion without letting a stale UI prevent state persistence. Reusing a route never reuses old generation counters.

### Added

- Status, widget and decision-log diagnostics for input, output, cache-read/cache-write tokens, model transitions, truncation, attempts and reported catalog cost. Detailed footer mode adds cache counters; compact mode is unchanged.
- Observational stay/switch comparisons using the same measured token workload, including output, under all-cache-read and all-new-input scenarios. Missing/placeholder tariffs and router-truncated contexts suppress estimates. These are list-price scenarios, not predicted savings or billing guarantees; no switching policy changes.
- Allowlisted, branch-safe persistence of generation metrics. No session IDs, prompt text, credentials, physical cache-warmth claims or extra network calls are added.

## [0.7.0] - 2026-09-22

### Behavior change

- A Choice below `confidenceThreshold` is not discarded. The router selects the lowest tier whose cumulative probability reaches `probabilityThreshold` (default 0.8). Abstention mass counts for the baseline tier when that tier has a primary candidate. Version 0.8.0 corrects fallback-only baseline handling.
- Each Jev tier is a structured Choice option with `covers`, `notFor` and `examples`. The instructions are a structured object that names the state fields.
- The router retries one transient Jev status (`408`, `429`, `5xx`) inside the existing total budget. This version handles `retry-after-ms`; standard `Retry-After` seconds and HTTP dates are corrected in 0.8.0. Permanent statuses and cancellation are not retried.
- The response validator accepts omitted zero-mass options and two-decimal rounding.
- The request token estimate adds 400 tokens of headroom instead of 200.

### Removed

- The `low-confidence` outcome. Debug output shows `selected`, `basis`, `route-p` and `route-threshold` instead.
- The `/router` verbs `status`, `profile`, `fix`, `disable`, `debug`, `?` and per-tier `thinking`. A removed verb prints its replacement and does nothing.

### Added

- `jev.probabilityThreshold`, `jev.retry.maxAttempts`, `jev.retry.backoffMs` and `classifierModel.timeoutMs`. Defaults are unchanged.
- The `/router` verbs `off`, `log [on|off|clear]` and argument-free `widget`. Top-level completion lists verbs and profile names.
- A skipped advisor records `bypassReason` and the footer shows it: `advice skipped: pinned high`, `over budget`, `only high eligible`, `tool turn`.
- An `invalid-response` names the failing local check. Remote text is not retained.

### Documentation

- `docs/README.md` is the index. `docs/jev-advisor.md` holds the Jev guide. `docs/research/` holds dated experiment reports. `docs/archive/` holds superseded reports. File names are lowercase.
- Parallel Noul questions were tested and not added. See `docs/research/jev-routing-policy.md`.

## [0.6.5] - 2026-09-22

- The router now sends structured Jev state for the current request, recent dialogue, and optional tool evidence.
- Long excerpts keep their beginning and end. The router does not create a summary.
- The configuration now uses estimated-token budgets only. Character-budget keys are not accepted.
- The defaults select two prior turns, 500 dialogue tokens, and 250 tokens from the last native-error result.
- Empty tool-call messages do not consume dialogue slots. A successful result prevents reuse of an older error.
- A conservative multilingual estimate replaces character limits. Debug output compares local estimates with Jev `usage.input_tokens`.
- The router rejects a request above 28000 estimated tokens. This value is below Jev's 32k state-and-question limit.
- The generation context and the Pi classifier are unchanged.
- All 528 tests pass. The validation report includes live turns, controlled replays, multilingual calibration, and known limits.

## [0.6.4] - 2026-09-21

- Prefer quality-first Jev advice: use frontier reasoning when it can materially improve correctness or reduce rework, not only when weaker models are incapable. Keep straightforward tasks on micro/low; confidence thresholds and deterministic safeguards are unchanged.
- Explain footer outcomes directly: selected tier, low confidence → baseline, no tier chosen → baseline, or timeout → baseline. Hide abstention scores in compact mode; label them explicitly in widget/debug output.
- Add `/router debug stats`: unique HTTP requests, advised tiers, outcome rates and median latency within retained history. Local request IDs prevent shared calls, cached routes and tool continuations from inflating counts.
- Fix debug history retention (50, not 12) and stop collecting new history when debug is off. Preserve the latest route and existing history; clear/reset and resume remain branch-safe.
- Document opt-in `baselineTier: "high"` for quality-first fallback. Confident micro/low choices, pins, capabilities and budget policy still apply. Existing profiles are not rewritten automatically.
- Validate 24 real prompts through Pi/agterm: 10 Astra and 14 Luna generations, including repeated simple → complex → simple transitions, follow-ups, low-confidence fallback and abstention. Publish the task corpus and validation report.

## [0.6.3] - 2026-09-21

- Share same-turn Jev requests and original deadlines; reuse the actual advised route instead of reverting to baseline. One cancelled waiter no longer cancels its peers.
- Describe tier capabilities and focus Jev on the latest user request, without adding local task heuristics, extra context or lower confidence thresholds.
- Distinguish low confidence, uncertainty, HTTP/network errors, invalid responses and deadlines. Retain validated choice, confidence, probability, request timing and reuse provenance in branch-safe session/debug snapshots.
- Add `ui.statusLine`: informative `compact` default and opt-in `detailed`. Widget/status/debug expose full Jev metrics without credentials, request text or remote explanations.

## 0.6.2 - 2026-09-21

- Increase the default Jev timeout from 750 ms to 1500 ms. User-level `jev.timeoutMs` now sets the total advisory budget without the previous hidden 750 ms cap or an arbitrary upper cap. Positive finite values within Node's timer range are accepted, including 4000 and 5000 ms. Existing explicit shorter timeouts remain valid.
- Fix delayed Pi thinking-display events being mistaken for user changes and overriding every routing tier. Internal display updates now preserve configured per-tier effort; explicit user overrides still apply.
- Keep privacy opt-in, confidence validation, caller cancellation, and direct baseline fallback unchanged. No additional advisory requests or retries.
- Add regression coverage for delayed valid Jev responses, configurable deadlines, internal thinking events, and Astra/Luna candidate selection. Align configuration examples and operator documentation.

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
