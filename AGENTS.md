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
3. Build one eligible candidate per tier: its primary, or its first eligible fallback when the primary is ineligible. One candidate bypasses advice. Other generation fallbacks are not extra candidates.
4. A user-level classifier selection, enablement, active-profile approval for the exact canonical `provider/model` reference, and a registered Pi classifier authorize one bounded recent-context request. Use Pi's `modelRegistry.classify()`; Pi owns provider APIs and authentication. Never implement provider-specific classifier transports in the router. Accept only a validated current candidate: the top option at or above `confidenceThreshold`, otherwise the lowest tier whose cumulative probability reaches `probabilityThreshold` (abstention mass counts for the baseline tier). Invalid advice or transport failure goes directly to baseline, never to a second advisor. The default total deadline is 10 seconds; classification and retries share that deadline.
5. Send bounded text only. Exclude system prompts, raw configuration, credentials, thinking/tool arguments, and image/binary blocks. Selected text can still contain private data; filtering is not redaction. Caller abort never starts baseline generation.
6. Revalidate the actual generation/fallback target and delegate through Pi. Retry only explicit generation fallbacks before visible content, never on cancellation.

`profiles.<name>.baselineTier` optionally names a configured tier. Filter availability, input and (unpinned) context-window fit first; an unsupported effort runs at the nearest supported level, as in Pi, and only declared `thinkingLevels` narrow it. Then prefer that baseline followed by `medium`, `high`, `low`, `micro`. Partial profiles are valid; only no eligible route is an error. Deprecated `rules` and `phaseBias` load with a value-free warning but have no routing effect. Do not restore keyword floors, mechanical detectors, phase inference or a hidden legacy mode.

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
- Keep one fact in one document. Leave archived reports unchanged during current-document updates.
- `docs/architecture.md`: mechanism and module boundaries.
- `docs/research/`: dated experiments behind current defaults.
- `README.md`: project front page and installation.
- `model-router.example.json`: reference configuration.
