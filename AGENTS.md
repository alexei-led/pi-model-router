# Pi Model Router: Core Mandates

## Project Overview
The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, it selects a configured model/effort pair through optional semantic advice or a deterministic eligible baseline. Prompt words, language, punctuation, length and inferred phase must not determine a local tier.

## Architectural Principles
- **Extension-First**: All functionality must be implemented as a `pi` extension without modifying `pi` core.
- **Custom Provider**: Use `pi.registerProvider` to hook into the model lifecycle. The logical model (e.g., `router/auto`) should remain stable while the underlying model changes transparently.
- **Modularized Design**: Strictly follow the modular structure defined in Phase 3:
  - `extensions/types.ts`: All interfaces and type definitions.
  - `extensions/config.ts`: Configuration loading, normalization, and merging.
  - `extensions/routing.ts`: Eligible baseline, pin/budget policy and model/input/effort validation.
  - `extensions/context.ts`: Bounded recent text extraction, without intent scoring.
  - `extensions/classifier.ts`: Optional Pi semantic classifier compatibility path.
  - `extensions/jev.ts`: Bounded external Choice transport and strict candidate validation.
  - `extensions/provider.ts`: Custom `router` provider registration and delegation stream.
  - `extensions/state.ts`: Session-persisted state management and snapshotting.
  - `extensions/ui.ts`: UI status line and widget rendering logic.
  - `extensions/commands.ts`: CLI command registrations and completions.
  - `extensions/index.ts`: Main entry point (orchestrator).

## Routing Decision Logic
Four tiers (`micro`, `low`, `medium`, `high`) are model/effort choices, not security or tool-permission boundaries. Pi owns tool permissions and per-request authentication; validate provider/profile identity without inspecting private auth storage or claiming backend-login attestation.

1. Validate config, live capabilities and caller cancellation. Reuse a validated same-turn tool route, or select a compatible local route without advisors for an invalid continuation.
2. Honor an explicit pin within its configured tier; reject an ineligible pin. Otherwise, above the soft generation budget, skip advisors and prefer an eligible baseline among medium-or-lower tiers if any. Advisor costs are excluded.
3. Build eligible primary candidates; one candidate bypasses advisors. Explicit ordered generation fallbacks are not extra Jev candidates.
4. User-level Jev enablement, active-profile privacy opt-in and a key authorize one bounded recent-context request. Accept only a validated current candidate. Failure/uncertainty goes directly to baseline, never a second advisor. Jev is capped at 750 ms and remaining time in a 1500 ms advisory budget.
5. When Jev is not active, the optional Pi classifier may advise any of the four tiers under its separate 10-second bound. Failure or no advisor means baseline. Caller abort never starts baseline generation.
6. Revalidate the actual generation/fallback target and delegate through Pi. Retry only explicit fallbacks before visible content, never on cancellation.

`profiles.<name>.baselineTier` optionally names a configured tier. Filter availability/input/effort first, then prefer that baseline followed by `medium`, `high`, `low`, `micro`. Partial profiles are valid; only no eligible route is an error. Deprecated `rules` and `phaseBias` load with a value-free warning but have no routing effect. Do not restore keyword floors, mechanical detectors, phase inference or a hidden legacy mode.

Bounded advisor text can include recent tool output and private data. Exclude system prompts, raw config, config credentials, thinking/tool arguments and binary blocks; never claim transcript-text redaction. All project-level Jev settings are ignored. Work-profile privacy opt-in is operator-owned, not an implementation step.

## Coding Standards
- **TypeScript**: Strictly adhere to TypeScript. NEVER use the `any` type; prefer specific types or `unknown`.
- **Functions**: Always use arrow functions (`const myFunc = () => ...`) instead of function statements (`function myFunc() ...`) for consistency and lexical scoping.
- **Imports**: Use top-level static imports over inline `import()` or `require()` calls for consistency and cleaner ESM code.
- **State Management**: Persist router state via `pi.appendEntry` with a custom `router-state` entry type to ensure branch-safe behavior.
- **Error Handling**: Preserve explicit fallback order, capability/effort validation, cancellation and no retry after visible content. Never persist remote explanations or secret-bearing configuration; retain only allowlisted local reason codes and diagnostics.

## Documentation Reference
- `docs/ARCHITECTURE.md`: Detailed architectural deep dive.
- `README.md`: Usage and installation guide.
- `model-router.example.json`: Reference for configuration structure.
