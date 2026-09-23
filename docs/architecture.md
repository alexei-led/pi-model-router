# Architecture

How the router works and where its boundaries are. Operator-facing Jev
configuration and diagnostics are in [jev-advisor.md](jev-advisor.md); the
experiments behind the defaults are in [research/](research/).

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
4. **Jev (optional)**: User-level global enablement, active-profile opt-in and a key authorize one request. Accept only a validated current candidate ID: the top option when confidence clears `confidenceThreshold`, otherwise the lowest tier whose cumulative probability clears `probabilityThreshold`. Abstention, invalid advice, HTTP failure or timeout means eligible baseline directly, never a classifier cascade.
5. **Classifier-only compatibility path (optional)**: When Jev is not active (disabled, not opted in or missing a key), a configured Pi classifier can advise `micro|low|medium|high` semantically. Its isolated bounded recent context excludes the main system prompt/tools and output is limited to 256 tokens. Failure/uncertainty means baseline. Without either advisor, use baseline directly.
6. **Revalidation and delegation**: Revalidate after advice and before every generation/fallback attempt. Only explicit configured generation fallbacks authorize cross-provider alternatives; no implicit profile/account switch.

`provider.ts` gives Jev an absolute monotonic deadline using `jev.timeoutMs`
(default 1500 ms, validated against Node's timer range, without a product-level cap).
The adapter gets the minimum of that configured
timeout and the remaining budget, including request and response-body time. The
separate classifier-only path gets `classifierModel.timeoutMs` (default
10 s); it does not share a deadline with Jev. The Jev adapter retries a
documented transient status (`408`, `429`, `5xx`) up to `jev.retry.maxAttempts`
times with exponential backoff from `jev.retry.backoffMs`, honoring
`Retry-After`, only when a full round trip still fits inside the same deadline;
permanent statuses, malformed bodies and cancellation never retry. The classifier never
retries. Caller cancellation stops
generation rather than starting a local fallback. Same-turn Jev callers share one
in-flight request and its original deadline; only the final departing waiter aborts
the transport. A bounded per-turn decision cache (`MAX_TURN_CACHE_ENTRIES`) reuses the actual validated route,
not merely its advisor label. Policy/config/capability changes invalidate cached
advice; unsuccessful generation attempts release it for retry.

Image support and exact effort are hard capability filters on the concrete target
and every fallback, not tier labels. Local declarations may restrict but cannot
grant registry capabilities; unsupported effort is rejected, never clamped.
Profiles without an eligible route fail with an actionable error. Thinking
overrides preserve route coverage and reject changes atomically if no route remains.
Internal Pi thinking-display updates track their expected events across delayed
handler delivery, so they do not become user overrides for every tier.

Legacy `rules` and `phaseBias` remain loadable but have no routing effect and emit
a fixed value-free deprecation warning. There is no hidden keyword mode, safety
floor, task-size scoring or phase inference. Persisted phase labels describe tiers;
they do not feed local selection. Semantic advice and confidence are probabilistic,
not a security or tool-permission boundary.

### Continuation predicate

The bounded runtime-only continuation map retains up to `MAX_TURN_CACHE_ENTRIES` interleaved turns and records a hash of active-turn context, policy,
config identity, branch ancestry, actual successful decision and generated tool
call IDs. The turn hash includes `options.sessionId`, falling back to Pi's native
session-manager ID when absent; identical transcripts in different caller sessions
do not share advice or continuation records. The original `sessionId` is forwarded
to the concrete provider unchanged. It is not an authentication claim and is never
persisted in router diagnostics. Reuse requires matching user-turn identity, profile, pin/effort/policy,
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
It sends at most four primary route choices, plus `uncertain`. `JevRequest` carries
Pi context internally; the adapter invokes `buildJevContext` after authorization
and serializes only its allowlisted `currentRequest`, `recentDialogue` and
`recentToolEvidence` fields. System/tool definitions never cross this boundary.
Selection/serialization consume the same absolute advisory deadline as transport.

`context.ts` selects the state deterministically: the current request first,
then up to `context.previousTurns` prior user turns with their last non-empty
text replies, then the last tool result of the immediately previous turn when
the configured `toolResults` policy admits it. Every section has its own
estimated-token ceiling under the global `maxStateTokens` budget; long text is
kept as a head/tail excerpt with an explicit `truncated` flag. Intermediate
narration and text-empty assistant messages do not consume dialogue slots, and
an older failure is not recovered after a later successful result. No keyword
scoring, failure-text parsing, summarizer or extra advisor call is used. System
prompts, raw config, credentials, thinking, tool-call arguments and image/binary
blocks are never extracted; the selected text itself is not redacted.

Token counts are local estimates (ASCII/4, non-ASCII UTF-8 bytes/2, a 10%
margin, plus 400 tokens of fixed request headroom for the structured JSON
question). TypeSafe publishes no tokenizer or count endpoint. A serialized
request above 28000 estimated tokens is rejected before transport, leaving room
below Jev's 32k state-plus-question limit. The estimate and the server-reported
`usage.input_tokens` are both retained as numeric diagnostics. Calibration data:
[research/jev-context-selection.md](research/jev-context-selection.md).

The question is one Choice. Its instructions are a structured object that
focuses on `currentRequest` and names the other state fields; each tier is a
structured option (`covers`, `notFor`, `examples`, `useWhen` for high) plus its
concrete route, and `uncertain` allows abstention. A single Choice is used
deliberately: parallel Noul questions separated the extremes but changed no
route in the recorded experiments
([research/jev-routing-policy.md](research/jev-routing-policy.md)).

Candidate IDs encode the tuple `(tier, canonical model reference, thinking)` with
escaped components, so same-model tiers and separator-containing IDs cannot
collide. Responses are capped at 64 KiB and must contain `answers.route` with a
known `choice`, `type: "choice"`, valid confidence and a probability map over
known options only (omitted options count as zero; the sum may deviate by the
two-decimal rounding of each option; `choice` must carry the top probability).
Unknown IDs, `uncertain`, invalid distributions, HTTP errors, malformed data and
timeouts return no advice. A Choice below `confidenceThreshold` is resolved in
`selectRoute`: the lowest tier whose cumulative probability from micro upward
reaches `probabilityThreshold` is selected, with abstention mass assigned to the
local baseline tier supplied by `provider.ts`. Only a candidate that exists in
the request can be returned. The detailed adapter also returns an allowlisted
outcome, local timing, validated choice/confidence/probability, the acted-on tier
and basis, cumulative route probability, both thresholds, request limits, HTTP
status, attempt count, a local response-issue code and recognized Jev version
labels. These distinguish a fast rejection from a timeout and name the failing
local check without retaining remote text. Raw response fields never become a
decision. Registry identity, effort and input validation remain local authority;
natural-language intent is not locally validated.

Credential rendering is operator-owned (see
[jev-advisor.md](jev-advisor.md#storing-the-key)). The extension reads the
rendered user JSON, never runs secret lookup commands and does not require an
environment variable.

### Generation economics

`economics.ts` is observational and never feeds route selection. Each terminal
attempt is accounted before retry decisions, so a billed pre-content error is not
lost when falling back. Unreported usage is not invented. Per-decision counters
refer to the last terminal attempt; its attempt count and reported cost span the
delegation chain. Cached routing decisions clear old generation metrics before a
new request. Final UI refresh cannot prevent persistence if the UI has torn down.

For a successful cross-model response with valid positive input/output/read rates,
the shadow compares the current registry models on an identical measured workload:

```text
I = usage.input + usage.cacheRead + usage.cacheWrite
O = usage.output
allRead(model) = (I * cacheReadRate + O * outputRate) / 1e6
allNew(model)  = (I * max(inputRate, cacheWriteRate) + O * outputRate) / 1e6
```

Pi's three input counters are disjoint. The `max` handles catalogs with zero
separate cache-write pricing. These are scenarios, not a forecast, break-even
horizon, billing cap or quality comparison. They omit provider-specific retention,
long-context pricing and different output lengths on alternative models. Invalid,
missing and zero placeholder rates suppress shadow estimates. Costs from terminal
usage are reported catalog/list-price values, not verified subscription charges.

The previous model comes from the current transcript, not a restored last-decision
snapshot. No physical warmth state or TTL is guessed or persisted. Router-side
truncation suppresses shadow comparison; compaction and branch changes cannot
resurrect a cached-prefix claim because none is stored. Same-model transitions may
include effort changes and do not assert cache preservation. Pi owns wire-level
effort updates, cache keys and provider-specific transcript conversion. The router
still strips logical-provider credentials/headers instead of forwarding arbitrary
hint headers. Native classifier and external Jev usage remain separate from these
generation metrics; no request class is inferred from prompt text.

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/routing.ts`: Eligible baseline, pin/budget policy and live model/input/effort capability validation.
- `extensions/economics.ts`: Validated generation counters and hypothetical catalog-cost comparisons; no routing policy or cache warmth state.
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
jev-fallback | classifier | classifier-fallback`. The footer distinguishes local
baseline, skipped advice (with a closed `bypassReason`: pinned, budget,
single-candidate, tool-continuation, no-user-turn, turn-advised), accepted
advice and rejected advice. `ui.statusLine`
selects compact (default) or detailed display without affecting routing. Widget
and debug output retain full validated metrics.
Obsolete source codes and old free-form explanations map to non-rendered `legacy`
without dropping unrelated pins, costs or settings; unknown persisted codes are
rejected. Continuations clear per-call advisor latency/error/classifier fields but
retain the original nested Jev metrics, including request-start time, with an explicit
reuse marker. Debug mode persists the last 50 decisions through the existing
branch-safe state snapshots; no extra transcript message or external log is needed.
Nested metrics, including generation counters and shadow costs, are copied
field-by-field on save/restore. Generation diagnostics contain only local transition
codes, truncation flags, numeric counters/costs and the previous canonical model
reference. Context metrics include
only numeric current/history/tool sizes, included turns/results and truncation
counts; selected text is never persisted as router diagnostics. A local UUID is generated
only when an HTTP request is attempted; it is shared across waiters and route reuse.
`/router log` deduplicates these IDs within the retained 50-decision window,
not across session lifetime. Entries without IDs are excluded. Debug-off stops
collection while preserving existing history and the latest decision. No key, endpoint, task text,
raw response, rule explanation or remote reasoning enters router state/debug/UI. Pi's own conversation storage is outside this boundary.

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
