# Pi Model Router: Core Mandates

## Project Overview

The `pi-model-router` is an extension-first model router for the Pi coding agent. It registers a custom logical provider (`router`) that exposes profiles as models (for example, `router/auto`). For each turn, it selects a configured model/effort pair through optional semantic advice or a deterministic eligible baseline. Prompt words, language, punctuation, length, and inferred phase must not determine a local tier.

## Architectural Principles

- **Extension-first:** Implement all functionality as a Pi extension. Do not modify Pi core.
- **Custom provider:** Use `pi.registerProvider` to hook into the model lifecycle. Keep the logical model stable while the underlying model changes.
- **Modular design:**
  - `extensions/types.ts`: interfaces and type definitions.
  - `extensions/config.ts`: configuration loading, normalization, and merging.
  - `extensions/routing.ts`: eligible baseline, pin/budget policy, model/input validation, and effort mapping.
  - `extensions/modes.ts`: routing mode resolution, effective switch policy, and the pure cost/quality route transform.
  - `extensions/escalation.ts`: repeated-failure detection and the bounded one-tier escalation hold.
  - `extensions/context.ts`: bounded recent-text extraction without intent scoring.
  - `extensions/choice.ts`: provider-neutral choice rubric, candidate identity, and strict validation.
  - `extensions/classifier.ts`: bounded typed classification through Pi's public model registry.
  - `extensions/provider.ts`: custom `router` provider registration and delegation stream.
  - `extensions/state.ts`: session-persisted state and snapshotting.
  - `extensions/ui.ts`: status line and widget rendering.
  - `extensions/commands.ts`: commands and completions.
  - `extensions/index.ts`: entry point and orchestration.

## Routing Decision Logic

Four tiers (`micro`, `low`, `medium`, `high`) are model/effort choices, not security or tool-permission boundaries. Pi owns tool permissions and request-time authentication. Validate provider/model identity without inspecting private auth storage or claiming backend-login attestation.

1. Validate configuration, live capabilities, and caller cancellation. Reuse a validated same-turn tool route, or select a compatible local route without an advisor for an invalid continuation.
2. Honor an explicit pin within its configured tier; reject an ineligible pin. Otherwise, above the soft generation budget, skip advisors and prefer an eligible baseline among medium-or-lower tiers if any. Exclude advisor costs from the generation budget.
3. Build an immutable prevalidated route matrix. `activityRouting` accepts only `on`/`off`, default on; off excludes activity cells. Sparse `profiles.<name>.activities` cells (`code`, `debug`, `explore`, `plan`, `review`, `ops`, `docs`) inherit raw generic declarations, replace explicit fallback lists, and re-normalize target/alias metadata. Each tier has one representative: an eligible generic cell first, otherwise the first eligible activity cell in fixed activity order. Generic-first baseline preference applies within the budget-filtered pool. Pins remain generic-only. Other generation fallbacks are not extra candidates.
4. A user-level classifier selection, enablement, active-profile approval for the exact canonical `provider/model` reference, and a registered Pi classifier authorize bounded classification. Initial user requests await one Pi `modelRegistry.classify()` operation. Valid tool continuations may start one nonblocking review every `advisor.reviewEveryRequests` requests (default 4; 0 disables). A review never delays generation and may affect only the immediately following request; expire it after that request. Fence it by session owner, user turn, branch, config/policy, and the current eligible matrix. Steering, reload, shutdown, cancellation, pins, budgets, invalid continuation, and Google thought-signature constraints prevent stale/incompatible application. Failed, uncertain, expired, or stale background advice retains the eligible incumbent; initial advice failures use the local baseline. Ask tier and activity independently in one operation only when eligible candidates differ; activity-only for one tier with distinct plans; one effective plan bypasses. Invalid/uncertain activity uses generic at the selected tier, otherwise baseline. Never multiply distributions. Accept only a validated current matrix candidate: top option at/above `confidenceThreshold`, otherwise lowest tier whose cumulative probability reaches `probabilityThreshold` (abstention mass counts for baseline). Use Pi's public classifier contract; Pi owns provider APIs and auth. Never implement provider-specific classifier transports. Default deadline is 10 seconds; classification and retries share it.
5. Send bounded text only: current user goal, recent current-loop assistant text and permitted text tool results, plus configured previous dialogue. Exclude system prompts, raw configuration, credentials, thinking/tool arguments, and image/binary blocks. `advisor.context.currentLoopMessages` bounds current-loop messages (default 8); `toolResults` and token limits further bound evidence. Selected text can still contain private data; filtering is not redaction. Caller abort never starts baseline generation.
6. Only a current prevalidated matrix cell may generate. Carry its immutable ordered attempts through generation, actual fallback recording, same-turn advice and continuation caches. Revalidate the actual generation/fallback target and delegate through Pi. Retry only explicit generation fallbacks before visible content, never on cancellation.

`profiles.<name>.baselineTier` optionally names a configured tier. Filter availability, input and (unpinned) context-window fit first; an unsupported effort runs at the nearest supported level, as in Pi, and only declared `thinkingLevels` narrow it. Then prefer that baseline followed by `medium`, `high`, `low`, `micro`. Partial profiles are valid; only no eligible route is an error. `switchPolicy` defaults to a 5-request horizon, 0.5 cost sensitivity and 0.9 strong-advice threshold. Exact model alias metadata `effortCacheSharing` is `shared`, `separate` or `unknown` (default unknown); never infer cache sharing from provider/model names. Same-model effort changes marked shared have no cache rebuild penalty; unknown metadata does not forbid them. Cross-model switches compare estimated cold first input and a bounded warm-read horizon. Strong classifier evidence may override cost. These are catalog scenarios, not billing/cache-hit guarantees. Deprecated `rules` and `phaseBias` load with a value-free warning but have no routing effect. Do not restore keyword floors, mechanical detectors, phase inference or a hidden legacy mode.

Routing mode `cost | balanced | quality` (default `balanced`) resolves as session override, project file, profile, default. It transforms matrix cells before advice: cost uses a cheaper lower-tier model that fits the context, otherwise one effort step down (not below `low`); quality raises effort one step, otherwise uses the next tier (never `high` over budget). `balanced`, `micro`, pins, and effort overrides keep the configured pair. Policy precedence is `switchPolicy`, then the mode patch, then a Settings-tab session edit. The mode is part of the advice fence. The same tool failure twice with an `edit`/`write` between, in one user turn, raises the route one tier for `escalationHoldTurns` user turns in every mode. Project files may set only routes, `activityRouting`, `ui`, and `mode`.

Reconsider each new task/user-role steering message and periodically review valid tool-loop continuations. Only the next request may consume a fresh bounded review result. Native session ownership and request epochs fence replacement/reload/shutdown. Fresh SDK sessions require fresh extension/provider runtimes; never restore foreign-owner state on a new fork. Native pi-subagents auto-integration/shared inherited providers remain unsupported until a public contract supplies fresh runtime guarantees, native caller binding, effective physical model scope and inherited thinking ceilings. Do not treat transport session IDs, cycling scope or current effort as that contract.

Classifier configuration and exact per-profile approvals belong only in user configuration. Ignore project-level classifier selection, tuning, enablement, and approval settings. Pi's registered text-capable classifier catalog is the source of available models. Do not attach conversation images, even when a Pi classifier can accept images.

## Coding Standards

- **TypeScript:** Use strict TypeScript. Never use `any`; prefer specific types or `unknown`.
- **Functions:** Use arrow functions (`const myFunc = () => ...`) instead of function declarations.
- **Imports:** Prefer top-level static imports.
- **State:** Persist router state via `pi.appendEntry` with the custom `router-state` entry type for branch-safe behavior.
- **Errors:** Preserve explicit fallback order, capability validation, nearest-level effort mapping, cancellation, and no retry after visible content. Never persist provider explanations or secret-bearing configuration; retain only allowlisted local reason codes and numeric diagnostics.

## Documentation Reference

- `docs/user-guide.md`: profiles, commands, diagnostics, and migration.
- `docs/classifier-advisor.md`: classifier configuration, Pi registry behavior, and privacy.
- `docs/evaluation.md`: dated usage evidence, cost assumptions, and aggregate data.
- `docs/release-guide.md`: maintainer checks and publication procedure.
- `docs/decision-matrix.md`: generated routing decision table; regenerate it with its test, never edit it by hand.
- Keep one fact in one document. Leave archived reports unchanged during current-document updates.
- `docs/architecture.md`: mechanism and module boundaries.
- `docs/research/`: dated experiments behind current defaults.
- `README.md`: project front page and installation.
- `model-router.example.json`: reference configuration.
