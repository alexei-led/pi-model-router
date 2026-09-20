# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `balanced`, `cheap`, `deep`). Each profile defines up to four **Tiers** (at least one required):

- **High**: Reserved for architecture, design, complex debugging, and planning. Uses high-reasoning models.
- **Medium**: The default for standard implementation, multi-file edits, and focused fixes.
- **Low**: Used for summaries, changelogs, formatting, and simple read-only lookups.
- **Micro**: Optional exact mechanical lane, with `off` thinking by default. Tier order is `micro < low < medium < high`, derived from `ROUTER_TIERS` in `types.ts`. Each route pair is a tier, canonical model reference and explicit thinking level.

### 2. Custom Provider Implementation

The extension registers a logical provider with `pi.registerProvider`. The selected model stays `router/<profile>`. Generation and classification delegate through `ctx.modelRegistry.streamSimple`; Pi owns authentication, credential-specific URLs, provider dispatch and transcript normalization. The router does not implement a second generation auth stack. The optional Jev advisor has a separate, user-configured HTTPS credential; it never delegates generation.

## Routing Decision Flow

For every request sent to a `router/*` model, the following logic is executed:

1. **Local constraints and continuation**: Compute the safety floor and available pairs. Before any advisor, reuse a validated same-turn tool route when the continuation predicate below holds. An invalid tool continuation routes locally, still without advisor calls.
2. **Local decision**: Otherwise apply the active profile's manual pin, highest matching keyword rule, or local heuristics, in that order. The heuristic path recognizes exact mechanical tasks and applies `phaseBias` to planning/implementation thresholds. Every choice is raised to the local floor if necessary.
3. **Soft budget and availability**: When recorded generation spend reaches `maxSessionBudget`, high requests prefer medium (or low if medium is absent), but cannot undercut the floor. Resolve missing or unsupported routes to eligible configured pairs. Safety wins over budget (`budget-floor-conflict`); absence of an eligible route fails before generation. Classifier and Jev costs are excluded.
4. **Jev (optional)**: For an eligible new user turn, offer only available primary pairs from the active profile. Pins, matched rules, budget gates, mechanical tasks and tool results skip both advisors. Explicit user-level global and profile enablement are required. Duplicate requests for the last advised user turn do not repeat advice.
5. **Classifier fallback (optional)**: If Jev is disabled or supplies no valid choice, call the configured Pi classifier with the remaining shared deadline. Its isolated context excludes the main system prompt/tools and output is limited to 256 tokens. Advice remains `low|medium|high`; below-floor answers are discarded. Errors or expiry retain the already computed local decision.
6. **Revalidation and delegation**: Check the advised pair against the current registry again, then check the actual target before every generation attempt. Delegate through Pi; only explicit configured fallback references authorize another provider/account.

`provider.ts` creates one absolute monotonic deadline (`performance.now() + 1500`)
for an eligible advisory turn. Jev gets the minimum of its configured timeout,
750 ms and remaining time; the classifier receives that same absolute deadline.
The classifier's standalone 10-second default does not extend provider routing.
Neither advisor retries. Caller cancellation stops generation rather than starting
a local fallback.

Local policy in `routing.ts` computes the safety floor before classifier work:
unknown tasks require low, ordinary edits and bounded debugging medium, and
design/security/destructive/migration/concurrency tasks high. Exact mechanical
matches permit micro only without competing risk signals. Pins, rules, budget
and missing-tier resolution cannot undercut this floor. Profiles with no eligible
tier fail with an actionable error before generation. Image support is a hard
capability filter on the concrete target and every fallback, not a tier label.
Existing three-tier profiles and saved snapshots remain valid without migration.
The floor is a conservative keyword policy, not a command-execution security
boundary. Exact effort must be supported by the actual registry model and applicable local
declarations; unsupported effort is rejected, never clamped.

### Continuation predicate

The runtime-only continuation memo records a hash of active-turn context, policy,
config identity, branch ancestry, actual successful decision and generated tool
call IDs. Reuse requires matching user-turn identity, profile, pin/effort/policy,
unchanged config, compatible known branch ancestry, matching assistant
provider/model and tool result IDs, and a still-eligible concrete route.
Reloads, branch switches/rewinds, profile changes, new user turns and stale
capabilities invalidate reuse. No hash, branch metadata or tool IDs enter router
snapshots. Account identity here is the configured provider identity: backend
login changes remain Pi-owned, not attested by the router. Google thought-signature
tool continuations fail plainly if the actual prior model can no longer be used.

### Jev transport and config provenance

`config.ts` parses user and project sources separately. It strips all project
`jev` settings (including profile opt-ins) with a value-free warning before merge.
Only a user-level global enablement, API key and profile opt-in authorize a call.
Projects can still override ordinary local tiers, but cannot enable a new profile
with inherited Jev credentials. All profiles, including work, default to off.

`jev.ts` uses built-in fetch for one TypeSafe System One Choice request with
`Authorization: Bearer`, redirects disabled and injected transport/clock in tests.
It sends at most four primary route choices, plus `uncertain`, and the latest user
text truncated to at most 12000 characters as `untrustedTaskSummary`. The text is
not redacted: profile opt-in is approval to send it externally. It sends no whole
transcript, tool output, system prompt, model cards or configuration.

Candidate IDs encode the tuple `(tier, canonical model reference, thinking)` with
escaped components, so same-model tiers and separator-containing IDs cannot
collide. Responses are capped at 64 KiB and must contain `answers.route` with a
known `choice`, `type: "choice"`, valid confidence and a complete probability
map. Unknown IDs, `uncertain`, low confidence, invalid distributions, HTTP errors,
malformed data and timeouts return no advice. Only a locally mapped candidate ID,
confidence and latency leave the adapter; raw response fields never become a
decision. Registry, effort, image and floor validation remain local authority.

chezmoi/1Password rendering is operator-owned (see [README](../README.md)). The
extension reads the rendered user JSON, never runs secret lookup commands and
does not require an environment variable. Render with a private chezmoi template,
keep the output out of Git and verify mode `0600` before storing a key.

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/routing.ts`: Local floor/allowed predicate, tier selection, heuristics, phase bias and live model/effort capability validation.
- `extensions/classifier.ts`: Isolated, bounded classifier request and response parsing.
- `extensions/jev.ts`: Bounded external Choice transport, collision-safe candidate IDs and strict safe-advice parsing; no provider or session knowledge.
- `extensions/context.ts`: Small message/text extraction helpers shared by routing and classification.
- `extensions/config.ts`: Loads, merges, validates and normalizes the JSON configuration.
- `extensions/commands.ts`: Registers all `/router` subcommands and their autocompletions.
- `extensions/ui.ts`: Manages the status line and the optional state widget.
- `extensions/state.ts`: Handles session-persisted state and snapshots.
- `extensions/types.ts`: Centralized interface and type definitions.

The dependency direction is one-way: `index` wires lifecycle; `provider` owns advisor order/deadlines and Pi delegation and calls `routing`, `classifier` and `jev`. The adapter imports only `config` validation and `types` contracts, not provider/state/UI. `routing` owns policy and uses Pi's capability helpers, `context`, `config` and `types`; state/UI never import Jev. No production import cycle or new runtime dependency is introduced.

## State & Persistence

Branch-specific router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches.
- Track accumulated generation costs.

Snapshots are deeply copied at save and restore boundaries. Optional persisted fields are validated before use; malformed entries are skipped. Snapshot deduplication resets when the branch/session is restored.

At the actual `pi.appendEntry('router-state', ...)` boundary, decisions and debug
history copy only declared local fields. `RoutingReasonCode` is the closed union
`pinned | custom-rule | micro-mechanical | continuation | classifier | jev |
heuristic | fallback | budget-floor-conflict | legacy`. Old free-form explanations
are omitted and mapped to `legacy`, which is not rendered; unknown persisted
codes are rejected. Numeric routing latency and the fixed error classes
`advisor-unavailable` and `deadline` are the only advisor diagnostics. No key,
endpoint, task text, raw response, rule explanation or remote reasoning enters
router state/debug/UI. Pi's own conversation storage is outside this boundary.

The last explicitly selected router profile is also stored in `~/.pi/agent/model-router-state.json`. An explicit startup `--model` selection takes precedence over both cross-session and branch state. Otherwise, a resumed session's branch-specific `router-state` entry wins; a fresh startup or `/new` session uses the cross-session profile when Pi starts on the router provider and that profile is still configured.

## Reliability: Fallback Chains

Each tier can define `fallbacks`. Retry is allowed only before content is emitted. Cancellation never starts another attempt. Once content is visible, a failure is surfaced rather than concatenating another model's answer. Every stream must produce a terminal `done` or `error`; early exhaustion becomes an error so callers' `result()` promises settle. Status records the actual fallback target.

Capacity checks use the actual attempt's model, not always the tier's primary. Truncation drops complete old user turns and preserves system messages plus the latest tool chain. The character-based estimate cannot guarantee a fit for images, tool schemas or an oversized active turn; provider overflow errors remain possible.

## Tests and Boundaries

Pure routing/config/state tests use real local functions. Provider tests use real Pi event streams and wait for completion, not arbitrary sleeps. In-memory `ModelRuntime` integration tests cover native custom providers, keyless/header-only auth and credential URLs without network calls. Jev tests use synthetic documentation-derived HTTP fixtures, never live credentials. Provider tests cover shared-deadline wall time, continuation identities, prompt injection, capability changes and disabled/valid/timed-out Jev paths; index tests exercise the actual append-entry boundary. Test helpers and fixtures stay under `extensions/test/` and are excluded from npm artifacts.

The architecture fitness gate is the existing strict typecheck, Biome (including
import cycles), full tests and scoped import inspection; no archfit configuration
is required. Validate with `npm test`, `npm run tsc`, `npm run lint`,
`npm run check`, `npm run build` and `npm run pack:dry`. The build uses the current
`noEmit` TypeScript config: the published extension remains TypeScript source.
