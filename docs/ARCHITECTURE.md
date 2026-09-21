# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, it selects a configured model/effort pair using optional semantic advice or a deterministic eligible baseline. No prompt words, language, punctuation, word count or inferred phase choose a local tier.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `balanced`, `cheap`, `deep`). Each profile defines up to four **Tiers** (at least one required):

Tier order is `micro < low < medium < high`, derived from `ROUTER_TIERS` in `types.ts`. These are configured model/effort choices, not task guarantees or permission levels. Each route pair is a tier, canonical model reference and explicit thinking level. `micro` defaults to `off` thinking; both semantic advisors can select all four tiers. Partial profiles, including low-only, are valid.

An explicit `profiles.<name>.baselineTier` must name a configured tier. Without it, prefer `medium`, `high`, `low`, `micro`. At request time filter by live availability, input and exact effort, then prefer the baseline followed by that fixed order. Missing default medium is not an error. Explicit generation fallbacks retain their configured order and exact alias metadata; they are not extra Jev candidates. Already-normalized model references are parsed directly, not resolved through aliases again.

### 2. Custom Provider Implementation

The extension registers a logical provider with `pi.registerProvider`. The selected model stays `router/<profile>`. Generation and classification delegate through `ctx.modelRegistry.streamSimple`; Pi owns authentication, credential-specific URLs, provider dispatch and transcript normalization. Pi also owns tool execution permissions. The router does not implement a second generation auth stack, inspect private auth storage or attest which backend login is behind a provider. The optional Jev advisor has a separate, user-configured HTTPS credential; it never delegates generation.

## Routing Decision Flow

For every request sent to a `router/*` model, the following logic is executed:

1. **Validation and continuation**: Validate config/registry and handle caller cancellation. Reuse a validated same-turn tool route before any advisor. Invalid continuations select a compatible local route, without advice.
2. **Pin or budget**: Manual pins skip advisors, use only their configured tier and fail actionably if it has no eligible route. Words never raise or lower a pin. Otherwise, above `maxSessionBudget`, skip advisors and prefer the eligible baseline within medium-or-lower tiers if any; retain an eligible configured baseline otherwise. Report the fixed `budget` reason. This is a soft generation-cost policy, not a billing cap; advisor costs are excluded.
3. **Primary candidates**: Build eligible primary model/effort candidates from the active profile. Exactly one candidate bypasses advisors without transmitting task text.
4. **Jev (optional)**: User-level global enablement, active-profile opt-in and a key authorize one request. Accept only a validated current candidate ID. Failure, uncertainty, invalid advice or timeout means eligible baseline directly, never a classifier cascade.
5. **Classifier-only compatibility path (optional)**: When Jev is not active (disabled, not opted in or missing a key), a configured Pi classifier can advise `micro|low|medium|high` semantically. Its isolated bounded recent context excludes the main system prompt/tools and output is limited to 256 tokens. Failure/uncertainty means baseline. Without either advisor, use baseline directly.
6. **Revalidation and delegation**: Revalidate after advice and before every generation/fallback attempt. Only explicit configured generation fallbacks authorize cross-provider alternatives; no implicit profile/account switch.

`provider.ts` gives Jev an absolute monotonic deadline (`performance.now() + 1500`).
Jev gets the minimum of its configured timeout, 750 ms and remaining time. The
separate classifier-only path retains a 10-second bound; it does not share a
fallback deadline with Jev. Neither advisor retries. Caller cancellation stops
generation rather than starting a local fallback. Bounded per-turn advisor guards
avoid duplicate calls and release unsuccessful generation attempts for retry.

Image support and exact effort are hard capability filters on the concrete target
and every fallback, not tier labels. Local declarations may restrict but cannot
grant registry capabilities; unsupported effort is rejected, never clamped.
Profiles without an eligible route fail with an actionable error. Thinking
overrides preserve route coverage and reject changes atomically if no route remains.

Legacy `rules` and `phaseBias` remain loadable but have no routing effect and emit
a fixed value-free deprecation warning. There is no hidden keyword mode, safety
floor, task-size scoring or phase inference. Persisted phase labels describe tiers;
they do not feed local selection. Semantic advice and confidence are probabilistic,
not a security or tool-permission boundary.

### Continuation predicate

The bounded runtime-only continuation map retains up to 16 interleaved turns and records a hash of active-turn context, policy,
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
It sends at most four primary route choices, plus `uncertain`, and bounded recent
text as `untrustedTaskSummary`. `context.ts` reserves space for the latest user
request and shares the remaining `maxStateChars` budget (at most 12000) across up
to five recent user/assistant/tool messages. It labels roles, truncates
deterministically and performs no keyword scoring or summarizer call. Tiny budgets
prioritize request text over labels. System prompts, raw config, credentials from
config, thinking, tool-call arguments and image/binary blocks are not extracted.
Conversation text, including bounded tool output, is not redacted and may contain
private data or secrets: profile opt-in is approval to send it externally. Short,
multilingual and imperfect replies are data for the advisor, not local branches.

Candidate IDs encode the tuple `(tier, canonical model reference, thinking)` with
escaped components, so same-model tiers and separator-containing IDs cannot
collide. Responses are capped at 64 KiB and must contain `answers.route` with a
known `choice`, `type: "choice"`, valid confidence and a complete probability
map. Unknown IDs, `uncertain`, low confidence, invalid distributions, HTTP errors,
malformed data and timeouts return no advice. Only a locally mapped candidate ID,
confidence and latency leave the adapter; raw response fields never become a
decision. Registry identity, effort and input validation remain local authority;
natural-language intent is not locally validated.

chezmoi/1Password rendering is operator-owned (see [README](../README.md)). The
extension reads the rendered user JSON, never runs secret lookup commands and
does not require an environment variable. Render with a private chezmoi template,
keep the output out of Git and verify mode `0600` before storing a key.

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/routing.ts`: Eligible baseline, pin/budget policy and live model/input/effort capability validation.
- `extensions/classifier.ts`: Isolated, bounded classifier request and response parsing.
- `extensions/jev.ts`: Bounded external Choice transport, collision-safe candidate IDs and strict safe-advice parsing; no provider or session knowledge.
- `extensions/context.ts`: Bounded recent advisor context and generation text/input extraction helpers.
- `extensions/config.ts`: Loads, merges, validates and normalizes the JSON configuration.
- `extensions/commands.ts`: Registers all `/router` subcommands and their autocompletions.
- `extensions/ui.ts`: Manages the status line and the optional state widget.
- `extensions/state.ts`: Handles session-persisted state and snapshots.
- `extensions/types.ts`: Centralized interface and type definitions.

The dependency direction is one-way: `index` wires lifecycle; `provider` owns advisor order/deadlines and Pi delegation and calls `routing`, `classifier` and `jev`. The adapter imports only `config` validation and `types` contracts, not provider/state/UI. `routing` owns prompt-independent policy and uses Pi's capability helpers, `config` and `types`; state/UI never import Jev. No production import cycle or new runtime dependency is introduced.

## State & Persistence

Branch-specific router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches.
- Track accumulated generation costs.

Snapshots are deeply copied at save and restore boundaries. Optional persisted fields are validated before use; malformed entries are skipped. Snapshot deduplication resets when the branch/session is restored.

At the actual `pi.appendEntry('router-state', ...)` boundary, decisions and debug
history copy only declared local fields. `RoutingReasonCode` is the closed union
`baseline | pinned | continuation | classifier | jev | fallback | budget | legacy`.
`AdvisorOutcome` separately records route guidance as `none | bypassed | jev |
jev-fallback | classifier | classifier-fallback`; only the informative Jev or
classifier outcomes render in the footer and widget, so ordinary baseline turns
return to the normal status text.
Obsolete source codes and old free-form explanations map to non-rendered `legacy`
without dropping unrelated pins, costs or settings; unknown persisted codes are
rejected. Continuation decisions clear stale advisor latency/error/classifier fields. Numeric routing latency and the fixed error classes
`advisor-unavailable` and `deadline` are the only advisor diagnostics. No key,
endpoint, task text, raw response, rule explanation or remote reasoning enters
router state/debug/UI. Pi's own conversation storage is outside this boundary.

The last explicitly selected router profile is also stored in `~/.pi/agent/model-router-state.json`. An explicit startup `--model` selection takes precedence over both cross-session and branch state. Otherwise, a resumed session's branch-specific `router-state` entry wins; a fresh startup or `/new` session uses the cross-session profile when Pi starts on the router provider and that profile is still configured.

## Reliability: Fallback Chains

Each tier can define `fallbacks`. Retry is allowed only before content is emitted. Cancellation never starts another attempt. Once content is visible, a failure is surfaced rather than concatenating another model's answer. Every stream must produce a terminal `done` or `error`; early exhaustion becomes an error so callers' `result()` promises settle. Status records the actual fallback target.

Capacity checks use the actual attempt's model, not always the tier's primary. Truncation drops complete old user turns and preserves system messages plus the latest tool chain. The character-based estimate cannot guarantee a fit for images, tool schemas or an oversized active turn; provider overflow errors remain possible.

## Tests and Boundaries

Pure routing/config/state tests use real local functions. Provider tests use real Pi event streams and wait for completion, not arbitrary sleeps. In-memory `ModelRuntime` integration tests cover native custom providers, keyless/header-only auth and credential URLs without network calls. Jev tests use synthetic documentation-derived HTTP fixtures, never live credentials. Provider tests cover Jev remaining-deadline bounds, the separate classifier bound, direct baseline fallback, all four semantic tiers, continuation identities, prompt injection, capability changes and disabled/valid/timed-out Jev paths; index tests exercise the actual append-entry boundary. Test helpers and fixtures stay under `extensions/test/` and are excluded from npm artifacts.

The architecture fitness gate is the existing strict typecheck, Biome (including
import cycles), full tests and scoped import inspection; no archfit configuration
is required. Validate with `npm test`, `npm run tsc`, `npm run lint`,
`npm run check`, `npm run build` and `npm run pack:dry`. The build uses the current
`noEmit` TypeScript config: the published extension remains TypeScript source.
