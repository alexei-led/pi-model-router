# Routing modes (`cost | balanced | quality`) — v0.16.0

Status: Phase 2 (implementation). Manager approved the plan; Q9 changed (see open choices).

- Branch `feat/routing-modes`, worktree `../pi-model-router.worktrees/routing-modes`, based on `origin/main` at `ff499f65` (v0.15.1, tagged).
- Merge order: v0.15.1 is already merged and tagged. No rebase needed. This branch targets v0.16.0.
- Design: `router-modes/design.md` (manager scratchpad). Repo brief: `brief-pi-model-router.md`.
- Commit style: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`), release commit `release: v0.16.0`.

## Verified claims

| Claim | Result |
| --- | --- |
| Tier config `{model, thinking, fallbacks}`, activities, `baselineTier` (`config.ts:268-465, 738-754`) | Confirmed |
| `switchPolicy` (`config.ts:630-676`), soft `maxSessionBudget` (`config.ts:797-804`) | Confirmed. No votes or dwell. |
| `/router profile` (`commands.ts:146-149` → `index.ts:311-345`); global fallback `model-router-state.json` (`state.ts:36, 126-157`) | Confirmed. The global file stores only the profile name. |
| Project merge (`config.ts:844-853`); `stripProjectAdvisorConfig` strips only advisor keys (`config.ts:606-628`) | Confirmed. A project file can set `switchPolicy`, `maxSessionBudget`, `debug`, `models`, `ui`, `activityRouting`. |
| `docs/user-guide.md:197` says routes-only | **Wrong line/text.** `docs/user-guide.md:251`: "Project overrides for routes and display". |
| `appendEntry('router-state')` (`index.ts:238`), built in `state.ts:443-476`, owner-matched restore (`index.ts:445-458`) | Confirmed |
| Commands `constants.ts:2-19`, parsed `commands.ts:364-457` | Confirmed (completions `363-405`, handler `407-480`) |
| `resolveRoutePair` `routing.ts:30-47`, `availableRoutePairs` `:104`, `buildRouteMatrix` `:379`, `selectBaselineRoute` `:274-317`, budget pool `:292-296` | Confirmed. Plan-level budget pool is `selectBaselinePlan` `routing.ts:481-486` (`tier !== 'high'`). |
| Candidate identity includes thinking (`choice.ts:128`); generation revalidates the plan | Confirmed. Revalidation recomputes thinking from `plan.config` + `plan.thinkingOverrides` (`routing.ts:502-514`, `provider-generation.ts:418-430`), not from `plan.attempts`. |
| `isError` only classifier evidence (`context.ts:174-215`); `tool_result` unused; continuation reuse (`provider-request.ts:737`) | Confirmed. Context `toolResult` messages carry `toolName`, `isError`, `content` (pi-ai `types.d.ts:426-431`). |
| Effort cache sharing default `unknown`, accepted with no rebuild cost (`switch-policy.ts:60-70, 117-129`) | Confirmed (`effort-cache-unknown`, `:126-127`) |
| Thinking levels include `off`, `minimal` (`domain.ts:7-15`) | Confirmed; order `off minimal low medium high xhigh max` |
| Codex escalation (`codex-router internal/policy/policy.go:96-119`) | Confirmed with a nuance: codex matches on a normalized **output signature** (exit + output), not the tool name. "Edit" = a successful `apply_patch` or shell write. Hold `escalationHoldTurns` default 2 (cost 1, quality 4), counted in user turns; one tier up, none at `high`; the same signature cannot escalate twice. |
| Gate scripts (`package.json`) | Confirmed: `npm test`, `npm run test:coverage`, `npm run check`, `npm run check:unused`; release also `npm run pack:dry`. |

## Divergences

1. **Design §3 pair-aware fix is not needed in Pi.** Pi has no votes, dwell or same-tier early return. `applySwitchPolicy` compares model and thinking (`provider-request.ts:576-585`). `evaluateSwitch` handles effort-only changes (`switch-policy.ts:114-127`). Pi's gates are: same-turn continuation reuse (`provider-request.ts:153-216`), and the switch-cost check on background-review advice only (`provider-request.ts:791-792`). Initial user-turn advice is not cost-gated today. The plan keeps that.
2. **"Pending" in Pi.** The only pending mechanism is the Settings-tab queue to the next user turn (`ui/runtime.ts:875-960`). `/router pin` and `/router thinking` apply at once and invalidate same-turn continuation through the `policy` fence (`provider-request.ts:748-756, 164`). The plan treats a mode change the same way (open choice 2).
3. **Revalidation recomputes the pair from config** (see table). The transformed plan must carry its source cell config and the transformed effort (as a per-plan thinking override), or generation fails with "Routed model capabilities or thinking are unsupported".
4. **In-flight initial advice is fenced only by config identity and advisor JSON** (`provider-request.ts:479-484`). `refreshMatrix` reuses the request snapshot (`:725-735, 475`). A session-level mode change during classification is not detected today. Regression test 8 needs a live mode getter.
5. **Uncertain advice.** Design says "T = uncertain → no transform". In Pi, uncertain or failed advice selects the baseline plan from the matrix. The classifier is optional, so the baseline is most users' only route. Open choice 1.
6. **Codex escalation is signature-based.** Pi port: signature = `toolName` + normalized error text (digit runs replaced, whitespace collapsed, first 2000 chars), hashed. Edit = a successful `edit` or `write` tool result. Simplification: shell writes do not count as edits. Upgrade trigger: replay data shows missed bash-edit loops.
7. **Non-reasoning routes default to `off`** (`config.ts:304-305`, `routing.ts:128-136`). The off/minimal validation must target explicit declarations only, or it disables every non-reasoning model at `low` and above.
8. **Fixture prices are equal** (`extensions/test/router-ui-fixture.ts:55-64`). The cost model lever cannot show live. The fixture needs per-tier prices.
9. **Brief hazard is stale.** The main checkout is on `main` (clean), not `fix/classifier-catalog-0.15.1`. I did not touch it.

## Risks

- The classifier sees transformed routes in its criteria (`choice.ts:409-423`). This can bias its tier choice. Prompts and labels stay unchanged.
- In cost mode two tiers can resolve to the same model and effort. The classifier still runs, because `oneEffectivePlan` is checked only with meaningful activities (`provider-request.ts:409-411`). Extra advisor cost, same route. Not fixed here (scope).
- Effort-only moves with `unknown` cache sharing pass the switch-cost check free (`switch-policy.ts:126-127`). Both levers' effort steps move without a tax.
- Subscription prices (checked 2026-10-21, read-only): the user's `anthropic-*` and `openai-codex-*` providers are `pi-sub-aliases` clones of built-in Pi 1.3.0 models (`cloneAliasModel` is a `structuredClone`, cost included); `models.json` overrides only `contextWindow`. Catalog input prices: `gpt-6.1-sol` 2, `gpt-6-luna` 0.1, `claude-opus-5-5` 4, `claude-sonnet-5-5` 2, `claude-haiku-4-5` 1. None is zero, so the cost model lever can fire for every routed profile. No fix needed. Not checked through a live registry.
- Escalation hold state is runtime-only. Reload or resume drops it (codex does the same).
- The project-file allowlist is a breaking change for repos that set other keys. No `.pi/model-router.json` found under `~/Workspace` (depth 4).
- Coverage gate: 90% branches on `routing.ts` and `state.ts`.
- Sandbox: the worktree is outside the sandbox write scope, so builds and tests in it need a sandbox bypass. `screencapture` is likely blocked by the sandbox. Screenshots may need user-run commands.

## Open choices (recommendation first)

1. **Transform the baseline** (no classifier, uncertain or failed advice): **yes.** Otherwise modes do nothing without a classifier. Alternative: transform only accepted advice.
2. **Mode change mid tool loop:** **apply at once through the existing fence** (like pin/thinking). The continuation becomes invalid and the compatible-route rule keeps the prior model when its tier still offers it (`provider-request.ts:666-717`). New turns classify on the new matrix. Alternative: queue the change to the next user turn like the Settings tab.
3. **Failure escalation in every mode, balanced included:** **yes**, for parity with codex/claude and the design formula `T = classified + boost`. This changes balanced behaviour; the release notes call it out. Alternative: cost and quality only.
4. **Escalation detection source:** **scan the request's context messages** (current user turn) instead of a `tool_result` hook. Same data, branch-correct, no event-ordering state. Only the hold `{signature, floorTier, untilUserTurn}` is runtime state.
5. **Project-file allowlist:** **routes + display + `mode`.** Allowed: `profiles.<n>.{high,medium,low,micro,activities,baselineTier}`, `models`, `activityRouting`, `ui`, top-level `mode`. Rejected with a value-free warning: `advisor`, `profiles.<n>.{advisor,mode}`, `switchPolicy`, `modes`, `maxSessionBudget`, `debug`, `rules`, `phaseBias`, unknown keys. The design says mode-only; that would remove a documented feature.
6. **Validation:** explicit `thinking: off|minimal` on `low`/`medium`/`high` (generic or activity cell) **disables that tier with a warning** (existing invalid-tier pattern). A route declared `reasoning: false` may still say `off`; routes limited by capability stay valid; the transform never moves them below `low`.
7. **Effort override** (`/router thinking`, Shift+Tab) is a manual choice: **mode is bypassed for overridden tiers.** Status shows `mode cost (session) · bypassed by effort override`.
8. **Budget exceeded:** **quality's model lever never targets `high`.** Otherwise a medium cell would generate the high model and slip past the budget pool (`routing.ts:481-486`).
9. **Settings-tab cost sensitivity vs mode patch (manager decision):** an explicit Settings-tab edit is runtime user intent and wins over the mode patch for that session; the Settings tab shows that it overrides the mode. Config-file `switchPolicy` still loses to the mode patch. Mode is changed by command only in 0.16.0.
10. **Session override scope:** **one value per session**, not per profile.
11. **User profile defaults:** work profiles `cost`, personal profiles `balanced`. The user decides.

## Design for Pi

- **Transform:** new `extensions/modes.ts`, one pure function `transformRoute({mode, tier, pairAt, supportedLevels, inputPrice, budgetExceeded})` returning `{sourceTier, thinking, lever: 'model'|'effort'|'none'}`. `pairAt(t)` resolves the activity cell's tier `t`, else the generic tier `t` (sparse cells inherit). Steps use `THINKING_LEVELS`; `proj` is the existing `clampEffort` over registry levels narrowed by declared `thinkingLevels` (same as `routeThinking`). Minimum for `low`+ is `low`. Price = registry `model.cost.input`; unknown or zero price means "not cheaper".
- **Matrix:** `buildRouteMatrix` applies the transform per cell after eligibility, before context fit. Each plan keeps `tier = T` (classified tier) and carries `mode` provenance `{mode, lever, sourceTier}`. Model lever: `config` and attempts come from the source cell (with its fallbacks). Effort lever: same config, the transformed effort as `thinkingOverrides[T]`, so `currentPlanPairs` reproduces it. Plan ids change with the mode, so stale advice and reviews no longer match. Pins skip the transform (`pinnedTier` already selects generic plans). Micro is never transformed. Cost never yields micro.
- **Gate:** no new gate. The effective mode goes into the `policy` fence, so a reused continuation or advised decision never logs a stale mode. Plan ids encode the transformed pair, so advice or a review computed for another mode fails the existing id checks; a separate live-mode authorization check was redundant (mutation-tested) and is not added. After classification the matrix is rebuilt from the live mode, so a rejected answer falls back to the current transformed matrix.
- **Escalation:** new `extensions/escalation.ts`, pure `detectEscalation(messages)` plus a small runtime hold. During a hold, a selected plan below the floor tier moves to the floor tier in the same cell (else generic) of the current matrix; reason code `escalation`. Skipped for pins, Google continuation, and above `medium` when the budget is exceeded.
- **Persistence:** `router-state` gains `modeOverride?`. Restored only through the existing owner match. Never written to `model-router-state.json`. Decisions gain `mode`, `modeSource`, `modeLever`, `modeSourceTier`; `snapshotDecision` and `isDecision` allowlist them. The route in use stays `targetLabel` + `thinking`.
- **Config:** `profiles.<n>.mode`; top-level `modes.{cost,balanced,quality}.policy` with keys from `switchPolicy` (built-in cost `{costSensitivity: 0.8, escalationHoldTurns: 1}`, quality `{costSensitivity: 0.2, escalationHoldTurns: 4}`, deep-merged, documented as untuned); `switchPolicy.escalationHoldTurns` (default 2); project top-level `mode`. A user-level top-level `mode` is ignored with a warning (set it per profile).
- **Commands:** `/router mode [cost|balanced|quality|default]`; no argument prints the mode and its source.
- **Display:** widget second line `… · cost (session)`; `/router status` line `Mode: cost (session)`; inspector Now/Settings show mode and source; `/router log` entries show mode and lever.

## Tasks

### Code

- [x] C1 `escalation.ts`: `detectEscalation` (signature, edit-in-between, current user turn only, latest pair) and hold logic.
- [x] C2 Wire escalation into `prepareRouterRequest` (floor after advice and continuation; reason code `escalation`; pins, Google continuation and budget rules).
- [x] C3 Types: `RouterMode`, `ModeSource`, `modes` config, `RoutePlan` provenance, decision fields, reason code.
- [x] C4 Config: normalize `profiles.<n>.mode`, `modes`, `switchPolicy.escalationHoldTurns`; merge rules; effective policy `{...switchPolicy, ...modes[mode].policy}`.
- [x] C5 Config: project allowlist replaces `stripProjectAdvisorConfig`; extract project `mode`.
- [x] C6 Config: off/minimal validation at `low`+.
- [x] C7 `modes.ts`: `resolveMode` and `transformRoute`.
- [x] C8 `routing.ts`: apply the transform in `buildRouteMatrix`; budget cap for quality.
- [x] C9 `provider-request.ts`: mode in the `policy` fence; live-mode check after classification; mode-specific switch policy into `evaluateSwitch`.
- [x] C10 State: `modeOverride` in `router-state`; restore; decision allowlist.
- [x] C11 Commands: `/router mode`, completions, help text, `ROUTER_COMMANDS`.
- [x] C12 UI: widget, `/router status`, inspector Now/Settings, log formatting.
- [x] C13 Fixture: per-tier prices; a failing-tool scenario for escalation.
- [x] C14 `AGENTS.md` module list: `modes.ts`, `escalation.ts`.

### Tests

- [x] T1 Table test: mode × tier × activity × supported efforts → pair, including the design §2 cases and the Claude-like expectations (same-model high drops effort; medium takes the cheaper low model; low drops one effort step; low cannot go below `low`).
- [x] T2 Quality table: effort lever first; model lever at max effort; `high` at max unchanged; budget cap.
- [x] T3 Micro unchanged in every mode; cost never produces micro; unknown price → effort lever.
- [x] T4 Precedence: session > project > profile > default; `default` clears the override.
- [x] T5 Effective policy merge: built-in modes deep-merged with user edits; mode patch beats `switchPolicy`; invalid `modes` keys warn.
- [x] T6 Project allowlist: each rejected key warns and has no effect; allowed keys work; `mode` accepted. Security regression test for `switchPolicy`, `maxSessionBudget`, `debug`.
- [x] T7 Validation: explicit off/minimal at `low`+ disables the tier (generic and activity); `micro: off` stays valid; non-reasoning routes stay valid.
- [x] T8 **Key regression:** advice started under balanced, mode changed, old result delivered → rejected; generation uses the current transformed matrix. Same for a background review.
- [x] T9 Generation revalidation succeeds for model-lever and effort-lever plans, fallbacks included.
- [x] T10 Pin and effort override bypass the mode.
- [x] T11 Persistence: override survives resume (same owner); not inherited by new or fork sessions; absent from `model-router-state.json`.
- [x] T12 Escalation: two same-signature failures with an edit between → one tier up for N user turns; no edit → none; different signatures; already `high`; same signature cannot re-escalate; pin and Google continuation skip; budget cap.
- [x] T13 Decisions carry `mode`, `modeSource`, classified tier and route in use; snapshot round-trip.
- [x] T14 Commands: usage errors, no-profile error, completions.
- [x] T16 **Golden decision matrix** (manager request, 2026-10-21): one table-driven test over every classifier outcome (`micro`, `low`, `medium`, `high`, `uncertain`, invalid/failed advice, and the no-classifier baseline path) × mode × activity cell × pin × effort override × budget × escalation hold → expected `{tier, model, thinking, lever, reasonCode}`. Built on a realistic profile (Claude-like and Codex-like shapes from the user's config, catalog prices). Golden output is checked in and reviewed by hand.
- [x] T17 Regression cases (manager item 2; the message arrived truncated, text requested): cases from past route-selection fixes. `0a9fcd5b` (per-model context windows) **found a real bug**: in cost mode the model lever could pick a lower-tier model whose window could not hold the request; the cell then failed context fit and routing fell to `high`. Fixed: a lever source must fit the request. Also covered: image input onto a text-only cheaper model (`788b28f8`-style eligibility), a tier served by its fallback (`788b28f8`), clamped unsupported efforts (`fd38b849`, in T1/T9), per-tier effort overrides (`d50e7988`, T10), and mode changes across continuations (`36064863`, T8).
- [x] T15 Coverage: 90% branches on `routing.ts`, `state.ts` (and the new modules).

### Docs

- [ ] D1 `README.md`: one front-page line on modes; "Upgrading to 0.16.0".
- [ ] D2 `docs/user-guide.md`: modes section (meaning, levers, precedence, command, pending behaviour, pins/overrides bypass), project-file allowlist (can be gitignored), escalation, config table rows, upgrade notes.
- [ ] D3 `model-router.example.json`: `mode` per profile, `modes`, `escalationHoldTurns`.
- [ ] D4 `docs/architecture.md`: transform location, matrix provenance, fence, escalation, module list.
- [ ] D5 `docs/classifier-advisor.md`: candidates show transformed routes (one fact, one line).
- [ ] D6 Mode policy values documented as untuned in one place (user guide).
- [ ] D7 Screenshots: existing method (`docs/testing/router-ui-agterm-acceptance.md:39-65, 202-206`): agterm window, `screencapture -l <window>`, `sips` crop, fixture extension. New: widget with `cost (session)`, `/router status`, Settings/Now tab with mode. Add an acceptance report `docs/testing/routing-modes-acceptance.md`.

### Config and migration

- [ ] M1 Existing configs load unchanged; no `mode` means `balanced`.
- [ ] M2 Stored `router-state` without `modeOverride` restores as before.
- [ ] M3 Upgrade notes: project allowlist (security), off/minimal validation, escalation in balanced.
- User machine changes (listed, **not applied**):
  - `~/.pi/agent/model-router.json`: add `"mode": "cost"` to `openai-work` and `claude-work`; `"mode": "balanced"` (or omit) for `openai-personal` and `claude-personal`. No current tier at `low`+ uses `off`/`minimal`, so validation does not affect it.
  - `~/.pi/agent/model-router-state.json`: no change.
  - Installed package `npm:@alexeiled/pi-model-router`: update to 0.16.0 after publish.

### Live agterm verification

Isolated: `PI_CODING_AGENT_DIR` and `HOME` under the scratchpad, `pi install --local <worktree>`, `--approve --offline --no-mcp --no-skills --no-context-files --session-dir <scratch>`, fixture extension, `--model router/auto`.

- [ ] L1 Each mode: `/router mode cost|balanced|quality`; capture the route per tier (`agtermctl session text`, `/router log`).
- [ ] L2 Mode change mid tool loop: route follows open choice 2; next turn uses the new matrix.
- [ ] L3 Session vs project vs profile; `default` clears the override.
- [ ] L4 Resume keeps the override; `/new` does not.
- [ ] L5 Pin bypasses the mode.
- [ ] L6 Status shows mode and source.
- [ ] L7 Log records carry `mode`, `modeSource`, classified tier, route in use.
- [ ] L8 Escalation via the fixture failure scenario.
- [x] L10 **Impact, offline** (manager request): replay a fixed prompt set and recorded traces (`docs/assets/usage-data.json` where usable) through the matrix per mode; report estimated catalog cost per mode and the model/effort mix per profile. Any mode or profile without a real difference (for example zero prices or same-model tiers) is reported as a finding. Result: `docs/research/2026-10-21-routing-modes-impact.md`.
- [ ] L11 **Impact, live** (manager request): one representative multi-turn task per mode in an isolated agterm session, on one subscription-billed and one API-billed profile, classifier Jev (`typesafe/jev-1.14.0`, enabled and approved in the user's config). Capture models used, switches, tokens and estimated cost from `/router log` and `/router usage`. Blocker: an isolated agent dir has no provider login. Needs the user to log in inside it (`! PI_CODING_AGENT_DIR=… pi` then `/login`) or to approve another way. I will not copy `auth.json`.
- [ ] L9 Screenshots; close the test sessions.

### Release

- [ ] R0 T16, T17, L10 and L11 are done and reported before Phase 4.
- [ ] R1 `npm version minor --no-git-tag-version` → 0.16.0 (`package.json`, `package-lock.json`).
- [ ] R2 `CHANGELOG.md` `## [0.16.0] - <date>`: Security (project allowlist), Changes, Upgrade; compare link.
- [ ] R3 Full gate: `npm ci --ignore-scripts`, `npm run check`, `npm run test:coverage`, `npm run check:unused`, `npm run pack:dry`.
- [ ] R4 Push the branch, open the PR. Stop before merge, tag or publish.
