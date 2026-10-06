# Router UI and classifier refresh

Research date: 6 October 2026. Proposal, not shipped behavior.

Scope: Claude Router's last three days of local history (3–6 October),
Pi Router at `e9139816`, installed Pi 1.0.2, and current public documentation.
The working checkouts were clean before research. No fetch/pull, inference,
credential inspection, production edits, or plan-exec recovery was performed.

[Open the interactive prototype](../prototypes/router-ui-v2.html).

## Recommendation

Take the **interaction model**, not the Claude runtime or routing policy:

- A two-line route strip above the prompt; keep Pi's footer and editor.
- An on-demand right-side inspector: **Now / Routing / Classifier / Usage**.
- One visible draft/apply/discard area across tabs; explicit next-user-turn
  activation. Show the actual route separately from a pending setting.
- Jev remains the existing default advisor. Add **Clef** and **Clef Flash**
  as opt-in alternatives through Pi's classifier registry, subject to the
  compatibility and safety checks below.
- Keep full-session accounting and persistent file editing separate from this
  first UI slice. The existing retained history can power an honest, explicitly
  scoped first inspector.

This is not approval to change live routing, enable external data sharing,
or replace the existing execution plan.

## What changed in Claude Router

Source checkout: `claude-model-router`, HEAD `7599fb5`.

| Commit / date | Change worth considering |
| --- | --- |
| `46eef01` / Oct 5 | 1.0: native Mods replace the gateway runtime. The host owns generation transport and credentials. |
| `a878235` / Oct 5 | 1.1: native above-prompt band and route/model/effort editor. |
| `d7c7067`, `f6f09ff` / Oct 5 | Claude-engine CI coverage and 1.1.1 release. Test the integration inside its actual host, not just render helpers. |
| `0402bec` / Oct 5 | 1.2: Jev, Clef and Clef Flash selection; provider-specific credentials and deadlines. |
| `7599fb5` / Oct 6 | 1.3: Now/Routing/Classifier/Usage; shared save/discard/status/undo area; route and policy draft saved together. |

Evidence in that checkout:

- `lib/native-panel.mjs:17–22,463–510`: four tabs and shared commit status.
- `lib/config.mjs:75–98,202–214`: classifier presets and removal of
  default-equivalent overrides. Claude defaults are 1500 ms for Jev and
  3000 ms for Cloudflare; these are not measured Pi recommendations.
- `hooks/native-router.mjs:457–505,639–650`: main-conversation routing,
  turn-scoped state and cancellation/cleanup.
- `lib/jev-contract.mjs:45–57,85–105`: request shape and answer normalization.
- `test/native-hook.test.mjs:929–1100`: draft/undo behavior and preservation
  of unrelated edits.

The read-only scout reported 251 passing Node tests. That is child-reported
fixture evidence, not a live Claude engine or provider acceptance result.

### Copy selectively

**Take:** width-prioritized status, actual-versus-configured separation,
cross-tab drafts, meaningful failure states, reversible narrow edits,
and host-native lifecycle integration.

**Do not take:**

- Claude's relaxed probability parsing: it clamps malformed/missing values
  rather than enforcing Pi Router's exact candidate/distribution contract.
- The extra semantic continuation question, cross-turn switching heuristics,
  cache-tax decisions or local error-driven tier escalation.
- Main-agent-only restrictions as a universal Pi rule: the logical
  `router/<profile>` must remain usable wherever it is explicitly selected.
- Automatic provider failover, project-owned privacy consent, guessed billing
  identity, or a fresh transport/authentication layer.

Pi already has validated same-turn tool reuse and a host-owned generation path.
There is no reason to rebuild those for a UI change.

## What Claude Code Mods actually provides

[Official overview](https://code.claude.com/docs/en/plugins/mods/overview)
and [reference](https://code.claude.com/docs/en/plugins/mods/reference)
were fetched directly, not inferred from the name.

Mods are in-process plugin handlers, not shell status-line scripts.
`turn.start`, `turn.step` and `turn.complete` follow an answer;
`turn.step` can alter model/effort. `ui.render` draws `AbovePrompt`
and `Pane`; a pane can be docked beside the transcript or inline.
The API includes state, commands, controls, measurements and invalidation.

The current overview says terminal support starts at Claude Code 2.1.287;
the reference describes 2.1.289. Mods can run with the user's OS permissions
and are not a security sandbox. CLI/Desktop render support does not imply
that VS Code chat, headless or remote clients render the same surfaces.

### Pi equivalents and limits

Verified against installed `docs/extensions.md`, `docs/tui.md`,
`examples/extensions/widget-placement.ts`, and public declarations:

| Need | Pi integration |
| --- | --- |
| Compact persistent route | Keyed `ctx.ui.setStatus` |
| Above-editor strip | Keyed `ctx.ui.setWidget` component |
| Inspector | `ctx.ui.custom`, with a right-anchored overlay on wide terminals |
| Narrow layout | Ordinary custom screen, keyboard-first |
| Live state | Provider-owned choosing/selected/fallback events plus Pi lifecycle events |
| Completion | Use the correct Pi boundary; `turn_end` can be followed by more work. `agent_settled` means automatic continuation is finished. |
| Durable observations | Allowlisted `router-state` entries, restored from the active branch |

An overlay **covers** the transcript; it is not a public dock API that
reflows it. A real dock requires a different host surface or host support.
Do not replace the footer/editor or patch Pi internals to imitate it.

Guard terminal components with `ctx.mode === 'tui'`; `hasUI` also covers
RPC clients that cannot run a custom terminal factory. Keep text commands.
Use public terminal-width helpers and semantic colors. Close through the
custom component's completion callback; dispose subscriptions on session
replacement/reload/shutdown. Do not poll for statistics on every frame.

## Cloudflare support: smaller than a new provider

### Verified models

| Model | Canonical Pi reference | Published specification |
| --- | --- | --- |
| Jev | `typesafe/jev-latest` | Existing router advisor; keep its current transport initially |
| Clef | `cloudflare-workers-ai/@cf/cloudflare/clef` | 27B, 65,536 context, $0.24 per million input tokens |
| Clef Flash | `cloudflare-workers-ai/@cf/cloudflare/clef-flash` | 9B, 65,536 context, $0.09 per million input tokens |

Sources: [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/),
and Clef's [input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json)
and [output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json).
Prices are published input rates, not invoices or measured end-to-end savings.
No routing-quality/latency benchmark was performed; a smaller model is not
evidence of equivalent decisions.

Both Cloudflare models accept System One typed questions. Choice answers have
`choice`, per-option `probabilities`, and `confidence`. Confidence is
derived from the distribution; it is not interchangeable with the probability
of a particular route. Public multimodal capability does not authorize the
router to send images; retain the existing bounded-text privacy contract.

The local model-cards catalog has no Clef records. No model-specific prompting
or effort claims were invented from that catalog.

### Pi already owns the transport and credentials

Pi 1.0.2 includes both models as **classifier**, not chat, models:

- `modelRegistry.findOfType('classifier', provider, id)`
- `modelRegistry.classify(model, { state, questions }, options)`

Evidence: installed `model-registry.d.ts:30–47`,
`pi-ai/dist/providers/data/cloudflare-workers-ai.json`,
and `pi-ai/dist/api/cloudflare-workers-ai-system-one.js`.
Pi's model guide explicitly documents extension classifier calls.

Pi's Cloudflare authentication resolves `CLOUDFLARE_API_KEY` and
`CLOUDFLARE_ACCOUNT_ID`, or credentials established through Pi's normal
login path. Do not read private auth files, display keys, or create a second
router credential store.

The router's existing [chat classifier](../../extensions/classifier.ts)
calls `find` and `streamSimple`. Merely entering a Clef ID in the current
`classifierModel.model` field will **not** add structured classifier support.

### Native support is not sufficient acceptance evidence

Direct code inspection and an offline fake-fetch probe found three gaps:

1. Pi's shared parser validates numeric finiteness, not candidate membership,
   [0,1] bounds, distribution keys/sum or argmax consistency. The probe returned
   `choice: foreign`, confidence 7, and probabilities 2/-1; the native call
   returned `stopReason: stop`. Keep the router's stricter acceptance layer.
2. The native transport defaults to two retries, uses a per-attempt timeout,
   and calls unbounded `response.json()`. Preserve one absolute advisory
   deadline and a response-byte ceiling; explicitly control retries. Do not
   silently inherit different retry behavior when selecting Cloudflare.
3. The public model schema requires an inner `model: clef|clef-flash`.
   The installed Pi transport sends generic `/ai/run` with
   `{model: '@cf/cloudflare/clef', input: {state, questions}}`, without that
   inner selector. The official example instead uses a model-specific endpoint
   and includes the selector. This is a **wire compatibility question**, not a
   proven service failure. No live request was made.

Evidence: `pi-ai/dist/api/system-one-shared.js:23–55,142–166`;
`cloudflare-workers-ai-system-one.js:19–24`; public schemas above.
The probe used only synthetic data and intercepted fetch; its output and script
are in the local `/tmp/pi-router-research/` evidence directory.

Prefer the public registry path, but validate its exact wire shape first.
If a selector adjustment is required, use a verified public request hook or
upstream correction, not a private API patch. The public request options expose
fetch/payload hooks; a bounded response guard can retain Pi-owned authentication.
Do not migrate the hardened Jev transport until it has equivalent tested
deadlines, retry rules, body bounds, diagnostics and cancellation.

### Router-owned contract for any structured advisor

- Build the same bounded state and one eligible candidate per tier.
- Normalize transport results, then run the existing strict acceptance policy.
  Abstention mass retains the baseline semantics; no probability clamping.
- Select one advisor. Error, timeout, abstention or invalid response goes to
  baseline, not Jev → Clef → another classifier.
- Keep deadline/cancellation, single-flight ownership, branch-safe reuse and
  generation fallback policy unchanged.
- Record provider/model, local request identity and allowlisted numeric
  diagnostics. Never persist raw errors, remote explanations, credentials
  or the request body. Keep advisor costs outside the generation budget.
- Separate selection from authorization: existing TypeSafe approval must not
  implicitly authorize sending context to Cloudflare. User-owned,
  provider/profile-scoped consent is a proposed new contract; the existing
  `jev` configuration must retain its meaning during migration.
- Keep the current chat-classifier compatibility path distinct from structured
  choice models. No arbitrary plugin architecture or dependency is needed.

## Independent comparison with the previous attempt

I recorded the conclusions above before reading the earlier research,
[plan](../plans/2026-10-05-pi-router-ui-and-observability.md), or
[prototype](../prototypes/router-ui.html).

The old plan is strong on branch/accounting truth, safe file patches, headless
behavior, command collisions and real-host testing. Keep those constraints.
In particular, keep `/router-ui`; do not consume valid profile names such as
`config` or `stats` as new `/router` subcommands.

What should change in a newly approved scope:

- Include structured Cloudflare advisors; the old plan is Jev-only.
- Prefer four main sections with recent events in Now; five tabs are not needed
  for the first inspector.
- Unblock the visual UI before the old plan's observation ledger, full-session
  projection and shadow-pricing tasks. Initially label stats as retained history.
- Stage classifier changes with other controls instead of immediate hidden
  writes. Keep privacy approval separate from the model picker.
- Treat safe persistent file editing and complete accounting as later scope,
  not prerequisites for evaluating this design.

### Worktree evidence

Git still registers branch
`2026-10-05-pi-router-ui-and-observability-43271b0e`, at the same
`e9139816` commit as main, but marks its worktree **prunable** because the
linked gitdir target is missing. The directory contains only a
`.ralphex/progress/` log, not a source checkout or plan. No commits differ
from main. The plan and original prototype are committed on main.

The surviving log reports:

> Bridge launch remains unresolved: No correlated prelaunch rejection or
> bound child is recorded. The launch may have occurred.

That is not proof that the old worker is absent. No worktree cleanup, controller
reset, manual worker launch, resume, or plan edit was attempted.
Inspect through `/exec status` before recovery; that is a Pi command, and it
was not invoked from this session's tools. Resolve the preserved operation
before trying to execute a revised plan.

## Prototype and verification

[router-ui-v2.html](../prototypes/router-ui-v2.html) is a separate, self-contained
HTML/CSS/JS study. The original remains unchanged.

It demonstrates:

- Above-editor route strip and right-side inspector; narrow full-width view.
- Choosing, accepted, continuation, deadline, fallback, budget, cancelled,
  unknown-usage and off scenarios.
- Cross-tab draft, validation, apply/discard/undo, and a next-turn action.
- Jev/Clef/Clef Flash selection and explicit simulated Cloudflare consent.
- Actual generation versus advice, persistent pin labeling, and fixed synthetic
  statistics with missing-cost coverage.

No network, localStorage, real config writes or API calls. The HTML reserves
strip space for readability; this does not claim Pi overlay transcript reflow.
Numeric observations and generation routes are synthetic, not benchmarks.

Chromium checks passed at desktop 1512 px and mobile 390 px:
draft persistence, invalid-number rejection, next-turn activation, consent
boundary, discard/undo, cancellation, fallback identity, timeout, continuation,
arrow navigation, Escape/focus return and prompt command. No JavaScript errors,
HTTP requests or document horizontal overflow. Desktop and mobile screenshots
were visually inspected. Local evidence:
`/tmp/playwright-router-v2-manifest.json` and
`/tmp/playwright-router-v2-*.png`.

Repository checks: `npm run check` passed (Biome and TypeScript), and
`git diff --check` passed. The relative-link check found 5 links and no broken
links. Prose lint returned 24 advisory style findings, mostly semicolons.
No Mermaid diagrams changed. Biome's configured scope excludes this HTML;
the browser interaction checks are its actual executable verification.

Production routing tests and real Pi/agterm UI acceptance are not claimed:
no production extension code changed. Browser evidence cannot prove TUI
cell widths, theme invalidation, focus coexistence or live provider correctness.

The public-research subagent failed because its configured
`fetch_content`, `get_search_content` and `source_check` tools were absent.
It was not retried through another execution mode. This report's public API
claims use the parent's separately fetched official pages, not that child's
incomplete report.
