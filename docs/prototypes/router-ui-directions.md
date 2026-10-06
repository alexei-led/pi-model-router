# Router UI: three design directions

**Design study for 0.11.0.** Signal Panel was selected and implemented.
See the [user guide](../user-guide.md#native-inspector) for shipped behavior and
[actual-host validation](../testing/signal-panel-acceptance.md) for screenshots.
The [interactive HTML study](router-ui-directions.html) retains all three design
alternatives with synthetic data; it is not the implementation.

## Chosen direction

**02 / Signal panel** is selected: one command, a two-line route strip and a small
inspector with **Now / Usage / Settings**. Keep routine status quiet; make
exceptions readable. Reuse the current UI runtime, not another state model.

The other directions remain comparison sketches, **not configurable modes**.

### Naming

Use **Model Router** for the product and **Router** for the inspector, status
labels and `/router` command family. The UI is advisor-neutral: Jev, Clef and
Clef Flash are advisor choices, not product names. Show the actual advisor name
only in routing explanations, observations and settings. Jev in the synthetic
prototype is an example, not a fixed label in the implementation.

| Direction | Persistent surface | On demand | Trade-off |
|---|---|---|---|
| 01 / Quiet line | One footer status; no widget | Short centered overview | Least clutter; usage stays one command away |
| 02 / Signal panel | Two-line widget; no duplicate footer route | Narrow right overlay; small bars and settings | Best everyday balance; covers some transcript |
| 03 / Route trace | One-line widget; extra line for pending changes | Wider overlay, recent decisions first | Better diagnosis; more screen space and interpretation |

## Current UX findings

Design judgments grounded in implementation and the existing
[actual terminal capture](../assets/router-ui/router-now-dark.png), not a usability study:

1. **Two entry points for one concept.** Users must remember whether status
   lives in `/router` or `/router-ui`. One prints a long notification; the other
   opens an inspector. Source: [commands.ts](../../extensions/commands.ts),
   lines 49–59, 98–122, 135–195 and 431–437.
2. **Repeated route information.** Footer and widget describe the same route;
   the inspector repeats it. Source: [index.ts](../../extensions/index.ts),
   lines 223–239; [ui.ts](../../extensions/ui.ts), lines 382–403 and 446–492.
3. **Weak hierarchy.** Actual route, advice, next-turn settings and history
   have nearly equal weight. Long names wrap inside the 56-column overlay.
   Source: [inspector.ts](../../extensions/ui/inspector.ts), lines 424–467
   and 618–651.
4. **Browsing looks like editing.** Apply/Discard/Undo appear on Now and Usage.
   Even “Browse only” is warning-colored. Source: inspector.ts, lines 521–548.
5. **Implementation vocabulary.** `thinkingHigh`, “Classifier” and raw outcome
   codes do not explain the user's task. Use “Effort,” “Advisor,” “Timed out →
   baseline” and “Next user turn.” Source: inspector.ts, lines 20–31, 557–584.
6. **Important qualifiers drown in prose.** Preserve actual versus advised,
   deferred controls, cost coverage and privacy. Put the essential qualifier
   beside the value; expand the rest on demand.

## One command

Proposed grammar, **not current syntax**:

| Command | Meaning |
|---|---|
| `/router` | Open Now in TUI; concise text outside TUI |
| `/router usage` | Retained-window usage; text outside TUI |
| `/router settings` | Session controls; read-only summary outside TUI |
| `/router status` | Always return a short text summary |
| `/router profile <name>` | Select a profile and enable routing |
| `/router pin <tier\|auto>` | Existing pin operation |
| `/router thinking <level\|auto>` | Existing all-tier effort operation |
| `/router log [on\|off\|clear]` | Existing history inspection/collection |
| `/router widget` | Existing widget visibility control |
| `/router off` | Restore the previous non-router model |
| `/router reload` | Existing configuration reload |
| `/router help` | Grouped help and argument completion |

Do not add `/router ui` as another concept. Opening the router shows the router.
Merge Routing and Classifier into Settings; keep Now and Usage task-focused.

This is a deliberate migration: `status` and `profile` are currently retired
verbs, and bare arguments can be profile names. Prefer explicit `profile <name>`
and retire the shorthand with a clear message. Existing profiles named `usage`,
`settings`, `status` or `profile` must remain addressable through that explicit
command. Do not silently discard them by extending reserved config names.

Remove the second registered command rather than advertise a permanent alias.
Document the old-to-new mapping. Invalid commands must never change profiles.
Sources: commands.ts, lines 35–43 and 374–488;
[config.ts](../../extensions/config.ts), lines 643–655;
[constants.ts](../../extensions/constants.ts), command-name reservation.

## Visual hierarchy

**Now:** actual model → tier and effort → one local explanation. Show the full
advised identity only when it differs, or in expanded details. Pending settings
are separate: “Next user turn: pin high.” Never relabel the running request.

**Usage:** small bars for observed tiers; deduplicated advisor acceptance and
median latency; known cost with coverage. “6 retained decisions” does not mean
6 user turns or a session ledger. Count unknown routes explicitly. Missing
request IDs do not enter request metrics.

**Settings:** pin first. Baseline, budget, advisor/deadline and per-tier effort
behind one Advanced section. Keep existing scope, validation, conflict checks
and deferred application. In production, show Apply/Discard only with a dirty
draft, and offer Undo after an application rather than on every screen.

The HTML simulates pin Apply/Discard and the next user turn. Other settings are
read-only previews. Selecting an advisor never grants privacy consent or
proves backend authentication.

## Status bar facelift

Persistent status answers **what is running**. The inspector answers **why and
how much**. Illustrative proposed strip (not current production output):

    auto · model-medium · medium · effort medium
    Jev selected medium · 420 ms

Exceptions replace routine detail:

| State | Explanation |
|---|---|
| Choosing | Choosing route · no generation started |
| Tool continuation | Reusing this turn's route · no new advice |
| Advisor timeout | Jev timed out → baseline |
| Generation fallback | Primary unavailable → explicit fallback |
| Soft budget exceeded | Over soft budget → eligible baseline |
| Pending edit | Next user turn: pin high · actual unchanged |
| Generation failure | Generation failed · /router log |
| Cancelled | Cancelled; do not imply automatic restart |
| Idle | Last route, not running |
| Off | Clear persistent router status; inspector explains off |

A recovered advisor timeout is not a generation failure. A generation fallback
can stay in the same tier: do not label every model change a downgrade.

**One persistent owner:** clear the router's `setStatus` entry while its widget
is visible. When the widget is hidden, use the compact footer status. Leave
Pi's own footer intact: no `setFooter` takeover of other extensions, git, or
host token/context totals.

**Narrow widths:** preserve model identity and failure/pending state first.
Drop normal latency, then profile/tier decoration. Truncate model IDs by
terminal display width; keep full provider/model in details. Limit the widget
to two lines and the footer to one. Provide ASCII fallback for block glyphs.
The HTML wraps at phone width for readability; exact terminal-column clipping
still needs native tests.

## Claude Model Router: useful transfers

Reference inspected: the local `claude-model-router` checkout. Paths in this
table are relative to that repository.

| Reference | Borrow | Do not transfer |
|---|---|---|
| `lib/native-band.mjs:8–45,131–144` | Tiny tier indicator, model/effort, width-priority removal | Strength interpreted as quality or permissions |
| `lib/native-display.mjs:4–21,62–80` | Short routing explanations | Its upgrade policy; keep Pi's eligible-baseline policy |
| `lib/native-display.mjs:89–121` | Explicit unknowns, labeled bars and bounded sparklines | Context/cache percentages without the correct denominator; forecasts |
| `lib/native-panel.mjs:291–326` | Clear tier-to-model mapping | Another permanent four-card dashboard |
| `lib/native-panel.mjs:515–541`; `docs/user-guide.md:91–103` | Separate host observations from price estimates | Claude quota, switch tax, payback or savings as if Pi measures them |

The useful transfer is visual compression, not more metrics. Pi already shows
host context/token information; repeating it is not a facelift.

## Feasibility and honest metrics

Checked Pi's installed `docs/extensions.md`, `docs/tui.md`, `docs/themes.md`,
and the `custom-footer.ts` and `widget-placement.ts` extension examples.

| Visual | Existing source / Pi mechanism | Limit |
|---|---|---|
| Route and lifecycle colors | UI snapshot + semantic theme tokens | Labels work without color; high tier is not a warning |
| Four-position tier marker | Actual tier → ordinal marks | Not a percentage, quality prediction or security level |
| Soft budget meter | Existing accumulated cost + configured budget | Expose cost in UI snapshot; label recorded catalog cost, not complete billing |
| Route-mix bars | Actual tiers in retained history | At most 50; active branch/profile; reuses remain decisions |
| Accepted/median advice | Local request-ID dedupe | Exclude missing IDs/latencies; show coverage |
| Latency sparkline, option 03 | Unique requests in retained order | Advisor time, not generation speed; labeled scale; no invented missing samples |
| Recent trace | History order, actual tier, reuse/outcome | UI history has no timestamps; use ordinal entries |
| Panels and controls | `custom`, `setWidget`, `setStatus`, themes | No core changes or embedded browser |

Budget fill clamps at 100%, but text keeps the true percentage, such as 108%.
No budget means no gauge; unreliable cost means unknown. The existing
accumulator adds reported costs without a complete missing-cost ledger. It is
not a precise remaining allowance. Advisor costs are excluded; missing costs
are never free.

Sources: [types.ts](../../extensions/types.ts), lines 456–498;
[runtime.ts](../../extensions/ui/runtime.ts), lines 36–55 and 177–220;
[provider.ts](../../extensions/provider.ts), lines 1135–1144;
inspector.ts, lines 72–122.

Charts are plain text, not SVG/canvas. Page cards, mouse controls and native
HTML selects are review aids. Pi selectors use keyboard controls; disclosure
means expanded text. Overlays cover the transcript, never reflow it. Below the
current 100-column threshold, use the custom-screen path and preserve drafts.

No speedometers, donuts, animations, remote explanations, private auth
inspection, quota estimates, confidence-as-quality, savings claims or new
background telemetry.

## Checks and limits

- Browser-checked three directions and eleven synthetic scenarios.
- Checked draft/discard/apply/next-user-turn; actual stays unchanged until the
  simulated next turn.
- Checked keyboard sections, Tab, Escape/focus return and mock commands.
- Checked horizontal overflow at 390, 768 and 1440 pixels, all sections.
- Rendered three direction screenshots plus light/narrow and phone views.
- `npm run check` passed (Biome and TypeScript). Documentation links: 11 checked,
  none broken. Prose lint returned 13 advisory semicolon findings.
- No Mermaid diagrams are present. The Mermaid helper incorrectly attempted
  diagrams #1 and #0 because this platform's `seq 1 0` counts downward. Those
  nonexistent-diagram renders failed. The HTML visuals were checked in Chromium.
- No production TypeScript changed. Browser checks do not prove ANSI output,
  glyph widths, native lifecycle behavior or extension interoperability.

Before shipping, test real Pi at narrow/wide columns, both themes, resize,
long/wide model names, tool continuations, missing usage, partial profiles and
concurrent setting edits. Print/RPC must return text without starting inference.

**Decision:** adopt Signal panel, with the quiet footer only when its widget
is hidden. Keep product naming advisor-neutral: Model Router / Router.
