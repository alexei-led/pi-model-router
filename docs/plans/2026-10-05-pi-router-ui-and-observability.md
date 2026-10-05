# Pi Router: native UI, configuration editing, and trustworthy usage

Status: ready for execution, not started.
Scope: this repository only. No changes to Claude Router.
Execution: sequential tasks through pi-plan-exec, one writer.
Baseline inspected: Pi Router 0.9.2, commit `cc40b920`, Pi dependencies 1.0.2.

## Goal

Deliver the useful parts of Claude Router's UX as a native Pi extension:
compact status/band, an interactive router screen, safe configuration drafts,
and session statistics that distinguish observed usage from estimates.

Improve routing observability and shadow cost comparisons without changing
which model the existing routing policy selects.

## Inputs and evidence

- [Research and recommendations](../research/2026-10-05-claude-router-transfer.md):
  UI transfer, switching constraints, cost coverage, and implementation order.
- [HTML prototype](../prototypes/router-ui.html):
  interaction reference, not production code or a source of real model prices.
- [Architecture](../architecture.md):
  eligibility, advisor, continuation, fallback, state, and privacy contracts.
- [User guide](../user-guide.md) and [Jev guide](../jev-advisor.md):
  existing command/configuration behavior.
- [Cost method](../evaluation.md#cost-method):
  observed catalog costs versus hypothetical scenarios.
- [Provider](../../extensions/provider.ts), [economics](../../extensions/economics.ts),
  [state](../../extensions/state.ts), [UI](../../extensions/ui.ts),
  [commands](../../extensions/commands.ts), [config](../../extensions/config.ts).
- Pi version-matched docs: extensions, tui, custom-provider, session-format,
  settings, and models. Inspect installed examples and exported declarations
  before implementation. Do not use newer APIs absent from the minimum peer version.

Research sections 1–2 motivate tasks 5–7.
Sections 3–4 motivate tasks 1–4 and 9.
Sections 5–6 motivate tasks 6–8 and 10–11.
The confirmed Claude credits-cap defect is outside this plan.

## Explicit scope decisions

### In scope

- Native Pi status and widget, with width-aware detail.
- Router screen: Now, Config, Advisor, Stats, Events.
- Reuse current profile, pin, thinking, off, reload, and log actions.
- Generation observations independent of the debug-history switch and cap.
- Requested/proposed/actual separation and honest unknown-cost coverage.
- Branch and session-file statistics with explicit source labels.
- Safe user/project configuration viewer and staged file editing.
- Tier-aware, retention-explicit shadow calculations using Pi pricing.
- Regression tests, mandatory real Pi testing in agterm with the local/dev
  package installed and configured, UI/UX acceptance, and current user docs.

### Out of scope

- Claude extension fixes, migration, or runtime dependencies.
- New routing heuristics, cross-turn hysteresis, failure-based escalation,
  inferred task phase, model ranking from prompt length, or different defaults.
- Migration to `registerVirtualModel`, replacing the custom-provider architecture.
- Cache warming requests, guessed TTLs, prefix-affinity claims, or hard billing caps.
- Invoice/subscription accounting, cross-session analytics, scanning other agents'
  sessions, or automatic collection of child-process/subagent usage.
- Browser dashboard, React/Ink, custom footer/editor replacement, or a new daemon.
- Automatic Jev consent, displaying/editing API keys, or project-owned Jev settings.
- Publishing, version bumps, remote pushes, or dependency upgrades.

## Contracts that every task must preserve

1. Keep `router/<profile>` selected and delegate through Pi's registry.
   Pi owns authentication, provider request conversion, and tool permissions.
2. Preserve eligibility, explicit pin validation, soft generation budget,
   one candidate per tier, advisor deadlines/acceptance, and baseline fallback.
3. Reuse only a validated actual same-turn tool route.
   Keep Google continuation compatibility and explicit fallback order.
4. Caller abort never starts baseline or retry. No retry after visible content.
5. No semantic inference in local UI/stats/economics code.
   Shadow economics must not influence model selection.
6. Preserve `maxSessionBudget` semantics and existing accumulated-cost policy.
   Show it as a soft router generation budget, not a host total or hard cash limit.
7. No raw prompts, tool arguments/results, thinking, advisor explanations,
   credentials, endpoints, or arbitrary provider errors in new persisted metadata.
8. Use static imports, arrow functions, strict types, and no `any`.
   Do not add runtime dependencies for UI, stats, or file editing.
9. Keep module ownership. Types in `types.ts`; persistence/aggregation in
   `state.ts`; calculations in `economics.ts`; policy in `routing.ts`;
   configuration IO/merge in `config.ts`; UI in `ui.ts`; commands in
   `commands.ts`; wiring in `index.ts`. If UI requires splitting, use private
   `extensions/ui/` components behind `ui.ts`, not a generic UI framework.
10. Update only current docs. Research/archive reports remain historical evidence.

## Resolved implementation choices

### Commands and compatibility

Keep `/router` as its existing textual status command.
Add `/router-ui [now|config|advisor|stats|events]` for the screen and
`/router-stats [branch|session]` for text statistics.
No global shortcut by default.

Do not add `config`, `stats`, or `screen` to the reserved profile names.
They are valid existing profile names. The prototype's proposed
`/router config` and `/router stats` are deliberately superseded by these
collision-free commands.

In interactive mode, use `ctx.ui.custom`. Outside interactive mode,
return the equivalent text view without calling a component factory.
`hasUI` alone is insufficient to distinguish RPC from interactive mode.

### State and observation records

Keep existing `router-state` snapshots and restoration behavior.
Add a versioned, discriminated observation record under the same custom entry
type via `pi.appendEntry('router-state', data)`. Snapshot readers must reject
observation records, and observation readers must ignore legacy snapshots.

Record one generation observation per delegated invocation, containing its
bounded explicit-fallback attempts. Give each observation a locally generated
opaque ID. Each started attempt has an ordinal and a terminal classification,
even if it throws without usage. A skipped ineligible target is not an attempt.
The observation and its ID are created once, not recreated during UI refresh.

Keep proposed route immutable. Record actual attempted target/effort separately,
including fallback and provider-reported identity where available.
Do not infer backend account or resolve model aliases by arbitrary string prefix.

Store only allowlisted numeric usage/cost components, optional 1h-write subset,
local outcome/reason codes, route identity, profile/tier, request kind, and
advisor request ID/diagnostics needed for dedupe. No turn hashes, branch paths,
raw transcripts, or remote error text.

New observations do not contain growing session arrays and do not enlarge
the 50-entry debug ring. Old sessions remain readable; missing historical
observations remain missing, not reconstructed as complete evidence.

### Accounting sources and scope

Maintain two projections, never sum them into an invented grand total:

| Projection | Source | Meaning |
| --- | --- | --- |
| Pi-recorded usage | Native assistant/tool/usage/compaction/summary entries | Host-observed catalog cost, including non-router activity present in this session file |
| Router generations | New router observations | Started attempts, including failures intercepted before forwarding, with their own coverage |
| Router budget | Existing accumulated cost/state | Existing soft generation-budget policy, unchanged |
| Router events | Existing bounded debug history | Recent diagnostic detail, not lifetime statistics |

The same successful generation can occur in both first and second projections.
Show them side by side with an overlap warning, never add them.
Do not call private session-manager mutators or manufacture native usage entries.

Default scope is the active branch. Session scope means all unique entries in
the current session file, including abandoned branches, not all files or children.
Deduplicate by entry/observation identity, not timestamp or model name.
Compaction does not erase previous physical entries. Session switches must
invalidate cached projections. No cross-file fork reconciliation.

Coverage describes included attempts and known/unknown components.
A sum of known costs with missing usage must be marked partial.
A zero cost with unknown pricing is not proof of free generation.
Read share is `cacheRead / (input + cacheRead + cacheWrite)`;
zero denominator is unknown, not 0% or 100%.

Advisor diagnostics are counted by unique local request IDs; continuations,
shared callers and repeated snapshots are not new advice.
Show HTTP attempts separately when known. Records without IDs cannot establish
a full request total. Advisor fees stay unknown unless actually reported.

### Config drafts

Use the actual agent directory from Pi, not a hard-coded home directory.
Show user/project/default/session provenance per editable leaf.
Never serialize the effective merged config back to a source file.

Drafts retain base values of only edited allowlisted fields.
Before save, reread the chosen raw file, preserve untouched fields, and
reject an edited-field conflict. Preview the exact field patch and destination.
Confirm only after validation; cancel has no side effects.
If the file changes again after preview, require a fresh preview/confirmation.

Refuse symlink destinations and managed source files where management is known.
Use a same-directory restrictive temporary file and atomic replacement,
clean up failed temporary writes, preserve appropriate existing permissions,
and serialize saves within this extension.
Recheck file identity/content before replacement. Atomic rename prevents torn
writes but does not provide cross-process compare-and-swap. Document that limit.
Do not claim universal race-free writes against arbitrary external editors.

Editable fields: existing profile baseline, tier model/effort/fallbacks,
existing soft budget, debug and status-line settings, and bounded Jev tuning.
Jev tuning writes only to user config. Credentials and privacy enablement remain
read-only in this release. Never copy user Jev fields into project config.
No bulk export of raw config. Adding/deleting profiles and editing model
capability declarations are not required for this editor.

## Mandatory agterm acceptance environment

This is a release acceptance requirement, not an optional demonstration.
Run the actual Pi CLI in a dedicated agterm session with this execution
worktree's local package installed. HTML previews, in-memory component tests,
RPC runs and generic PTY recordings cannot replace this gate.

Read the agterm skill, reference and installed Pi CLI/package docs before launch.
Check `AGTERM_ENABLED=1`, `agtermctl` availability, the explicit socket,
and the serving app/version. If the session is not inside agterm, or the app
cannot realize a visible terminal, leave the acceptance items unchecked and
report the exact environment/permission blocker. Do not silently switch hosts
or terminals.

Create a disposable fixture project and isolated `PI_CODING_AGENT_DIR`.
Use the same config directory for package installation and the Pi process.
Install the package from the absolute execution-worktree path with
`pi install --local <execution-worktree>` while in the fixture project.
Verify `pi list`, project trust, the loaded source/version and no duplicate
published Router package. A command exit alone is not load evidence.

Write explicit test user/project `model-router.json` files in that sandbox.
Configure fixture profiles, real candidate model identities, ordered fallbacks,
budget, widget and status preferences. Keep Jev disabled until testing its
authorized fixture transport; do not copy personal settings/auth.json or give
a work profile privacy consent. Load test providers only for deterministic
failure/abort/usage cases. Retain the normal provider path for a real backend
round trip.

Run two required tracks:

1. **Deterministic installed-extension scenarios.** The actual Pi host renders
   and drives the installed Router while test providers/fixtures supply known
   responses, cache counters, fallback errors and deadlines.
2. **Real-backend smoke.** Use an operator-approved local backend or remote
   provider/model through Pi's normal registry, with explicit minimal prompts
   and read-only tool use. Confirm permission and a small spending/request
   budget before paid calls. Credentials use Pi's normal approved auth flow,
   never copied into fixtures, command lines, screenshots or reports.
   Missing backend/auth/approval is a blocker for this track, not a synthetic
   pass. Live Jev calls are not required and must not be activated implicitly.

Launch a new agterm session using `session new --command`, with an explicit
workspace/window and recorded session ID. The command must set sandbox config,
cwd, session storage and the dev package context. Confirm the node is realized
and its foreground is Pi using `tree --json`. Send input only to that exact
session/pane after confirming Pi owns it. Never use `--target active`, inject
a launch command into an existing prompt, or replace the execution session.

Use `session text` for terminal buffers and tree readback for UI mutations.
Use supported, explicitly scoped macOS capture for visual evidence when
available. Buffer text alone cannot prove correct colors, clipping or focus.
If screenshot/accessibility permissions are missing, record the blocker and
arrange direct visual inspection rather than inventing screenshot evidence.
Avoid global agterm theme/settings changes; test Pi themes and resize only the
dedicated test window. Restore any changed window geometry.

The test Pi is a test subject, not a parallel implementation worker.
Do not let it modify the execution checkout or another session's files.
Its tools/config saves target only the disposable fixture project.

Keep a durable sanitized acceptance report under
`docs/testing/2026-10-05-pi-router-agterm-acceptance.md` and small scoped captures
under `docs/assets/router-agterm/` if appropriate. Record tested commit,
Pi/agterm versions, dev package source, terminal dimensions, setup commands,
scenario/input/expected/observed results, visual inspection, backend request
count and cost coverage. Do not check in raw session JSONL, auth, whole-desktop
captures, private paths or large ANSI logs. Preserve local raw test evidence
outside the package and reference its sanitized findings.

After failed UX/function checks, fix the production code and repeat the affected
flows in the same installed dev session after reload/restart. Recheck the other
core flows if shared rendering/actions changed. Keep failures and retest results
in the report, not only the final green screenshot.

## Execution and gates

Before launch, make this plan and the research/prototype available in the
execution branch. They are currently uncommitted artifacts.
Do not silently commit, stash, discard, or copy unrelated work.
Prefer the controller's isolated-worktree mode after the operator prepares a
clean tracked starting point.

From Pi, not from a shell:

```text
/exec status
/exec docs/plans/2026-10-05-pi-router-ui-and-observability.md
```

Select the required subagent review backend, with no implicit fallback.
Freeze these required checks in the controller's launch configuration:

```sh
npm run check
npm test
```

The plan text does not configure the controller automatically.
Use focused tests while working, then required checks for each accepted task.
Do not repeat passing checks unless code changed or a new concern needs testing.

No implementation has started. Plan validation is separate from the later
production checks. Record implementation/test evidence in the controller's
durable progress artifacts, not only temporary terminal output.

All tasks below declare sequential dependencies because they share ownership.
Do not manually launch implementation/review children outside the controller.
After launch, change checkbox markers only. Scope/structure changes require
controller-managed review before resuming.

## Task 1: Establish routing and accounting characterization fixtures

dependsOn: []

Files: `extensions/test/fixtures.ts`, `provider.test.ts`, `state.test.ts`,
`ui.test.ts`, `commands.test.ts`, `host.test.ts`, `index.test.ts`.

- [ ] Run the current baseline checks and record actual results without treating the earlier 662-test result as current evidence.
- [ ] Add reusable synthetic fixtures for successful generation, charged pre-content failure then fallback, thrown stream without usage, abort, truncated context, shared advice, tool continuation, and unknown pricing.
- [ ] Characterize existing route selection across pin, budget, advisor timeout/abstention, capability loss, unsupported effort, and Google continuation without changing production behavior.
- [ ] Add legacy snapshot, branch rewind/fork, session-switch and duplicate-entry fixtures for subsequent observation/stats tests, including profiles named config, stats, screen, and ui.
- [ ] Verify fixture assertions use disjoint input/read/write counters and distinguish final-attempt tokens from all-attempt costs; run focused tests and required checks.

## Task 2: Capture allowlisted per-request generation observations

dependsOn: [1]

Files: `types.ts`, `provider.ts`, `state.ts`, `index.ts` and their tests.

- [ ] Define the observation/snapshot discriminants, schema version, local identity, request-kind classification, immutable proposed route, actual attempts and component-level coverage according to the contracts above.
- [ ] Capture every started attempt, including charged errors, exhausted fallbacks, abort and missing terminal usage, with no duplicate capture on done/error/finally or same-turn route reuse.
- [ ] Persist observations independently of debug mode and the retained-history limit using the router-state entry type; keep existing snapshots and budget accumulation unchanged.
- [ ] Update strict validators/copying/restoration so malformed observations cannot become snapshots, old snapshots still restore, and future unsupported observation versions report an evidence gap instead of corrupting state.
- [ ] Test proposed versus actual fallback, per-attempt model/effort and cost, cacheWrite1h subset bounds, duplicate terminal events, concurrent completion order, reload/resume and debug-off collection.
- [ ] Prove UI rendering/persistence failures do not cause generation retries or alter routing/cancellation; run focused tests and required checks.

## Task 3: Build branch and session-file statistics with explicit coverage

dependsOn: [2]

Files: `state.ts`, `economics.ts`, `types.ts`, `index.ts` and tests.

- [ ] Implement pure projections for Pi-recorded native usage and router observations, with explicit branch/session-file scope and no addition of overlapping totals.
- [ ] Aggregate host usage from all applicable entry kinds using the installed Pi contract; aggregate router attempts, failures, local reasons, model/tier/effort distributions and observed cache-read share independently.
- [ ] Deduplicate advisor request IDs and report unique requests, HTTP attempts, outcomes and latency samples without treating reused decisions or ID-less legacy diagnostics as full coverage.
- [ ] Report known component sums plus unknown counts, generation-budget scope, evidence start/legacy gaps, and future cache state as unknown; do not silently count absent tariffs as free.
- [ ] Test more than 50 observations, log off/clear, compaction, branch rewind, forked history, session replacement, duplicate IDs, zero denominators, missing usage and unknown prices.
- [ ] Keep full-tree scans out of per-token rendering; rebuild on scope/session changes and update only at terminal/lifecycle boundaries; run focused tests and required checks.

## Task 4: Add version-correct shadow pricing without routing changes

dependsOn: [3]

Files: `economics.ts`, `types.ts`, `state.ts`, `economics.test.ts`,
`provider.test.ts`.

- [ ] Use Pi's public cost calculation API for synthetic same-workload scenarios, including price tiers and supported cache-write retention splits, rather than duplicating provider-specific multipliers.
- [ ] Keep reported historical cost unchanged; identify shadow pricing as current-catalog scenarios and label all-read, ordinary input/write assumptions and retention explicitly.
- [ ] Suppress unsupported or incomparable scenarios for missing tariffs, invalid counters, failed final attempts or context truncation; retain unknown instead of inventing a bound.
- [ ] Distinguish physical-model switches from effort-only changes; neither is proof of cache loss or preservation. Do not expose a predicted payback or measured-savings number.
- [ ] Add price-threshold boundary, 1h-write subset, zero/unknown tariff, differing-provider and effort-only tests; assert identical routing outputs with and without shadow data, then run required checks.

## Task 5: Replace verbose widgets with a compact native status band

dependsOn: [4]

Files: `ui.ts`, optional private `ui/` components, `ui.test.ts`,
`index.ts`, `types.ts`.

- [ ] Build a typed presentation model from current routing state and projections, separating latest observed generation from configured controls for future requests.
- [ ] Keep keyed setStatus and setWidget integration without replacing Pi's header/footer/editor. Preserve widget on/off and existing compact/detailed status preferences.
- [ ] Render route/effort, short local reason, observed cache metrics and scoped cost/coverage with priority-based omission at narrow widths; keep errors and actual route ahead of secondary detail.
- [ ] Cover waiting, choosing, off, pinned, selected, continuation, fallback, budget, advisor failure and unknown-usage states without leaking a previous profile or parent session route.
- [ ] Use Pi semantic themes and visible terminal widths; test 40/60/80/120 columns, Unicode/wide model labels, resize, light/dark invalidation, and bounded height.
- [ ] Ensure terminal observation events, not polling or stats scans during render, trigger updates; test coexistence with another keyed widget/status and run required checks.

## Task 6: Implement the keyboard-first router screen and text commands

dependsOn: [5]

Files: `ui.ts`, optional private `ui/` components, `commands.ts`,
`index.ts`, `commands.test.ts`, `ui.test.ts`, `index.test.ts`.

- [ ] Register /router-ui with tab completion and /router-stats with scope completion, retaining /router and all existing subcommands and valid profile names.
- [ ] Implement Now, Config, Advisor, Stats and Events tabs using public Pi components, a temporary overlay where space permits, and an ordinary custom screen on narrow terminals.
- [ ] Populate Now with actual/proposed/requested/effective facts, Stats with labeled source/scope/coverage, Advisor with bounded allowlisted diagnostics, and Events with retained local reasons; use explicit empty/loading/legacy states.
- [ ] Implement scoped arrow/number/tab navigation and Esc completion, readable focus and scrolling, with mouse only as optional enhancement; release subscriptions/focus on close, reload, shutdown and session replacement.
- [ ] Use ctx.mode to keep component factories out of RPC/print paths and emit equivalent text views there; test invalid arguments, commands during generation and repeated open/close.
- [ ] Keep existing profiles called config/stats/screen/ui usable and prove no default global key steals prompt input; run focused tests and required checks.

## Task 7: Connect session controls and a provenance-aware config viewer

dependsOn: [6]

Files: `config.ts`, `types.ts`, `commands.ts`, `ui.ts`,
`index.ts`, existing config/commands/UI tests.

- [ ] Expose allowlisted effective config values with user/project/default/session origin without exposing raw config, credentials or private provider auth.
- [ ] Show tier model/effort/fallbacks, baseline and budget, current registry eligibility, requested-to-effective effort and configured versus active profile separately.
- [ ] Reuse the current profile/pin/thinking/off/widget/log/reload action paths from UI, extracting shared handlers rather than duplicating policy or directly mutating provider internals.
- [ ] Preserve persistent profile-scoped pin semantics, not Claude's one-turn pins; show last actual route unchanged until a new observation, and explain continuation reuse rather than promising a next-request switch.
- [ ] Show Jev user enablement, profile opt-in and key-presence status only through existing public config facts; do not enable privacy settings or read private auth storage.
- [ ] Test merged-leaf provenance, inherited fallbacks, missing profiles, unsupported effort, mid-stream control changes and restored sessions; run focused tests and required checks.

## Task 8: Implement staged, validated, conflict-aware configuration saves

dependsOn: [7]

Files: `config.ts`, `types.ts`, `ui.ts`, `commands.ts`,
`config.test.ts`, `ui.test.ts`, `commands.test.ts`.

- [ ] Implement allowlisted drafts and per-field diffs against a base, with an explicit user/project target, discard, reset-to-inherited where valid, and no writes while merely browsing or changing session controls.
- [ ] Add controls for existing tier model/effort/ordered fallbacks, baseline, budget, debug/status settings and user-only bounded Jev tuning; keep credentials and privacy enablement read-only.
- [ ] Reread raw file before validation and preview, preserve unrelated edits, reject overlapping edited-field conflicts and unsafe keys, and validate the patched raw file plus effective routing config without silently dropping invalid edits.
- [ ] Require explicit confirmation of a sanitized diff and path; a changed file after preview requires renewed confirmation. Refuse symlink/known-managed targets and project Jev edits.
- [ ] Implement serialized same-directory atomic replacement with safe permissions, temporary-file cleanup and structured value-free errors; reload only after successful save and preserve current runtime on failure.
- [ ] Test cancel/no-op, malformed JSON, external edits before and after preview, disjoint merge, overlapping conflict, permission/write/rename failures, missing file, symlink and user/project privacy boundaries.
- [ ] Verify the concrete provider remains registered and valid after reload, fallbacks retain order and no capabilities are granted by UI edits; run focused tests and required checks.

## Task 9: Expose switch diagnostics for later policy evaluation

dependsOn: [8]

Files: `state.ts`, `economics.ts`, `types.ts`, `ui.ts`, related tests.

- [ ] Add a Stats subsection for observed new-user-request model switches, tool continuations, effort-only changes and pre-content fallbacks, with explicit denominators and unknown request-kind counts.
- [ ] Display candidate-versus-actual local reasons and optional same-workload price scenarios without outputting prompt text, remote explanations or a recommendation to ignore eligibility/pins.
- [ ] Separate requested tier changes from actual model switches, including two tiers mapped to one model; count no predecessor/unknown history as unknown rather than a switch.
- [ ] Test reset/branch/session scope boundaries and ensure an advisor request reused across multiple calls does not inflate switch/advice counts.
- [ ] Prove no new policy fields, votes, TTL state, cache warming requests or route decisions are introduced; run focused tests and required checks.

## Task 10: Install and configure the dev package in a dedicated agterm Pi session

dependsOn: [9]

Files: `host.test.ts`, `index.test.ts`, synthetic test fixtures,
a minimal reproducible fixture/launcher under `extensions/test/` or `scripts/`,
and `docs/testing/2026-10-05-pi-router-agterm-acceptance.md`.

- [ ] Add host integration tests for terminal lifecycle, streaming, charged fallback, abort and session replacement, then run focused tests and required checks.
- [ ] Verify agterm prerequisites and exact socket/app identity. Create sandbox project/config/session directories and record their purpose without changing personal Pi settings.
- [ ] Install this execution-worktree package locally in the sandbox, configure user/project Router profiles, resolve project trust, and prove the loaded package is the dev source with no duplicate Router.
- [ ] Create the dedicated agterm session with Pi as its foreground process and explicit sandbox environment. Record session/pane identity and verify realized/foreground/cwd through tree readback.
- [ ] Confirm Router startup, profile selection and native commands in the running Pi. Verify that edits to dev source are picked up through the supported reload/restart path, without adding a test-only marker to production.
- [ ] Prepare deterministic test providers and an approved real-backend smoke profile, with sandbox-only tools and a documented request/spending budget. Do not copy credentials or implicitly authorize Jev.
- [ ] Capture sanitized startup/config/load evidence and exact reproduction commands. Missing agterm, trust, backend permission or credentials must remain an explicit unmet prerequisite.

## Task 11: Exercise installed Pi functionality and visually review UI/UX in agterm

dependsOn: [10]

Files: `ui.test.ts`, `commands.test.ts`, `host.test.ts`,
fixture assets, `docs/testing/2026-10-05-pi-router-agterm-acceptance.md`,
and scoped `docs/assets/router-agterm/` captures where appropriate.

- [ ] In the running installed dev extension, submit actual prompts through Router. Verify deterministic baseline/advice selection, pin/unpin, effective thinking, tool continuation, timeout/abstention, charged pre-content fallback, exhausted fallback, cancellation and unknown-cost states against expected metadata.
- [ ] Complete the approved real-backend round trip through Pi's normal provider registry, including a read-only tool continuation where supported. Confirm stable logical selection, actual dispatched model/effort, observed usage and budget/coverage labels. Record provider failures honestly and keep the item open if no real backend was exercised.
- [ ] Exercise all five tabs and existing/new commands with real keyboard input. Check completion, text entry, navigation, scroll, Esc, focus return and prompt digits; verify forms, pin/profile controls and last-versus-next request labels are understandable and do not steal streaming input.
- [ ] Test config edit, preview, cancel, discard, confirmed sandbox save, conflicting external edit, validation failure and reload. Verify only the selected sandbox file changed, unrelated fields survived and runtime stayed valid on failure.
- [ ] Visually inspect 40/60/80/120-column layouts, regular/fullscreen Pi, resize while screen/selector is open, short terminal heights and light/dark themes. Check clipping, spacing, priority omissions, readability, cursor/focus, error discoverability and selected-control contrast. Capture representative real terminal images.
- [ ] Exercise more than 50 observations, log off/clear, branch rewind, compaction and session switch in the installed host. Compare branch/session views with fixture/native evidence and check advisor dedupe, unknown coverage and absence of double counting.
- [ ] Test coexistence with another sandbox extension's status/widget, repeated open/close/reload/restart, and shutdown cleanup. Verify no stale component, leftover timer/process or inherited parent-session route.
- [ ] Review UI/UX findings from the real terminal separately from assertion results. Fix in-scope defects, repeat affected flows and record before/after evidence. HTML screenshots and unit-test rendering are supplementary only.
- [ ] Verify RPC/text fallbacks and secret-safe output separately, then run required checks. Mark the agterm acceptance gate passed only when both installed-host tracks and visual UI/UX checks have actual evidence.

## Task 12: Document shipped behavior and complete the acceptance gate

dependsOn: [11]

Files: `README.md`, `docs/user-guide.md`, `docs/architecture.md`,
`docs/jev-advisor.md`, `model-router.example.json` only if new config fields exist.

- [ ] Document actual commands and tab controls, persistent pins versus last observed route, width/mode behavior and safe config saving, including managed-file and external-writer limitations.
- [ ] Document host-versus-router cost overlap, branch/session-file scope, legacy coverage, unknown prices, advisor fees, shadow assumptions and unchanged soft-budget policy in the appropriate owning guides.
- [ ] Update architecture ownership/state contracts and user-visible privacy restrictions, without rewriting historical research/evaluation figures or promising measured savings.
- [ ] Record supported Pi minimum-version evidence, run documentation link checks and relevant examples, and inspect generated terminal illustrations if added.
- [ ] Run npm run check, npm test and npm run pack:dry on the final changes; confirm packaged production files contain no fixtures or accidental dependencies.
- [ ] Prepare the controller review handoff with commits, commands/results and the agterm acceptance report, actual dev-install/config evidence, real-backend results, inspected terminal captures and residual limits. Do not publish or modify the Claude repository.

## Post-task controller acceptance

After task 12 is committed, the controller runs required independent review,
review fixes and final verification. These are controller stages, not a checkbox
that the task-12 worker can complete before review starts. If review fixes change
UI/actions or provider observation behavior, repeat the affected agterm flows
against the reviewed dev source and update the acceptance evidence. Report completion only
when the controller reaches its verified terminal state. Unresolved findings or
unrun terminal checks must remain explicit, not described as a clean release.
