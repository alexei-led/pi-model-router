# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `balanced`, `cheap`, `deep`). Each profile defines up to three **Tiers** (at least one required):

- **High**: Reserved for architecture, design, complex debugging, and planning. Uses high-reasoning models.
- **Medium**: The default for standard implementation, multi-file edits, and focused fixes.
- **Low**: Used for summaries, changelogs, formatting, and simple read-only lookups.

### 2. Custom Provider Implementation

The extension registers a logical provider with `pi.registerProvider`. The selected model stays `router/<profile>`. Both generation and classification delegate through `ctx.modelRegistry.streamSimple`; Pi owns authentication, credential-specific URLs, provider dispatch and transcript normalization. The router does not implement a second auth stack.

## Routing Decision Flow

For every request sent to a `router/*` model, the following logic is executed:

1. **Budget Check**: When recorded generation spend reaches `maxSessionBudget`, high-tier requests are downgraded to medium (or low when medium is missing). This is a soft routing policy, not a spending cap: a high-only profile has no cheaper tier, and classifier costs are not included.
2. **Manual Pin**: If the user has pinned a tier via `/router pin` or `/router fix`, that tier is used.
3. **Custom Rules**: Keyword-based rules defined in the config are checked against the user prompt.
4. **LLM Classifier (Optional)**: When not pinned, rule-matched or over budget, the classifier can replace the heuristic decision. It receives isolated text context, a 256-token output limit, cancellation and a 10-second timeout signal. Errors and incomplete responses retain the heuristic choice; selected tiers are resolved against the configured profile.
5. **Heuristics (Fallback)**: If the classifier is off or fails, a fast local heuristic (keyword/length/tool-use analysis) is used.
6. **Biased Stickiness**: The `phaseBias` setting modulates thresholds to keep the router in a consistent phase (e.g., staying in `high` tier during a multi-turn planning session).

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/routing.ts`: Core decision logic, heuristics, and the LLM classifier.
- `extensions/config.ts`: Loads, merges, and normalizes the JSON configuration.
- `extensions/commands.ts`: Registers all `/router` subcommands and their autocompletions.
- `extensions/ui.ts`: Manages the status line and the optional state widget.
- `extensions/state.ts`: Handles session-persisted state and snapshots.
- `extensions/types.ts`: Centralized interface and type definitions.

## State & Persistence

Branch-specific router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches.
- Track accumulated generation costs.

Snapshots are deeply copied at save and restore boundaries. Optional persisted fields are validated before use; malformed entries are skipped. Snapshot deduplication resets when the branch/session is restored.

The last explicitly selected router profile is also stored in `~/.pi/agent/model-router-state.json`. An explicit startup `--model` selection takes precedence over both cross-session and branch state. Otherwise, a resumed session's branch-specific `router-state` entry wins; a fresh startup or `/new` session uses the cross-session profile when Pi starts on the router provider and that profile is still configured.

## Reliability: Fallback Chains

Each tier can define `fallbacks`. Retry is allowed only before content is emitted. Cancellation never starts another attempt. Once content is visible, a failure is surfaced rather than concatenating another model's answer. Every stream must produce a terminal `done` or `error`; early exhaustion becomes an error so callers' `result()` promises settle. Status records the actual fallback target.

Capacity checks use the actual attempt's model, not always the tier's primary. Truncation drops complete old user turns and preserves system messages plus the latest tool chain. The character-based estimate cannot guarantee a fit for images, tool schemas or an oversized active turn; provider overflow errors remain possible.

## Tests and Boundaries

Pure routing/config/state tests use real local functions. Provider tests use real Pi event streams and wait for completion, not arbitrary sleeps. In-memory `ModelRuntime` integration tests cover native custom providers, keyless/header-only auth and credential URLs without network calls. Test helpers stay under `extensions/test/` and are excluded from npm artifacts. Local production imports are acyclic; `index.ts` owns session lifecycle and wires the modules together.
