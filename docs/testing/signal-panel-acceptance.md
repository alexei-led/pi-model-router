# Signal Panel: actual-host acceptance

Date: 6 October 2026. Release: 0.11.0. Source: `feat/router-signal-panel`,
based on `8cb650bc`, loaded directly from the development checkout.

## Environment and isolation

- Actual Pi 1.0.4 in agterm 0.34.0 (`c865bc6c`). Repository type checks use Pi 1.0.2.
- Dedicated agterm window/workspace. Every input targeted its exact fixture or
  live-smoke session ID. Other sessions were not typed into or replaced.
- Local package installation in a disposable project with an isolated
  `PI_CODING_AGENT_DIR`. Pi's package listing confirmed the development source.
- Only the router and explicit `extensions/test/router-ui-fixture.ts` loaded in
  the fixture session. Fake provider credentials stayed inside that sandbox.
- Agterm tree confirmed realized surfaces and Pi as foreground. Screenshots
  are actual terminal captures, not HTML or reconstructed ANSI images.
- Fixture generation and structured classifiers run in process, with the
  visible `LOCAL FIXTURE · no network` label. Fixture advice has no HTTP request
  ID and is therefore excluded from unique HTTP-request totals.

The first session launch exited before inspection. A new held-open launch with
an explicit Node/Pi/system PATH succeeded. Failed startup was not counted as
validation. Auto-completion sometimes consumed the first Enter; screen reads
confirmed submission before subsequent actions.

## Reproduce

Use a disposable project and isolated agent directory, as in the
[previous host setup](router-ui-agterm-acceptance.md#reproduce-the-fixture-setup),
but install the current development checkout and use the new `/router` commands.
The fixture now supplies TypeSafe Jev, Clef, Clef Flash and the chat model
`router-fixture/classifier`. Enable external advisors and per-profile consent
only in the sandbox configuration. A second profile with external advice
inactive exercises the optional Pi chat-classifier path.

Useful fixture commands:

- `/router-demo baseline|fallback|unknown|tool|slow|advisor-timeout|advisor-invalid|failure`
- `/router-demo-size` reports actual columns/rows.
- `/router-demo-theme dark|light` changes the fixture's Pi theme.

No test provider or credentials are packaged for npm.

## Executed native checks

| Check | Observation |
|---|---|
| Unified commands | `/router`, `/router usage`, `/router settings`, explicit profile selection and widget toggle worked in actual Pi |
| Jev / Clef / Clef Flash | Each local classifier ran through the production advisor path and appeared by its own name |
| Pi chat classifier | The `semantic` profile ran `router-fixture/classifier`; strip showed `Pi classifier advice accepted` |
| Advisor switching | Keyboard Advanced controls queued Jev → Clef → Clef Flash; actual generation stayed unchanged until a new user turn |
| Pin draft/apply/undo | Draft stayed local; applied high pin was visibly pending; next turn used high; Undo returned pending values without changing actual generation |
| Tool continuation | Local echo tool completed; strip showed `Tool route reused · no new advice` |
| Generation fallback | Failing primary used its explicit same-tier alternative; actual model and fallback explanation changed |
| Advisor timeout / invalid advice | Eligible baseline ran, with distinct readable explanations |
| Exhausted generation targets | Failed lifecycle shown rather than idle or successful routing |
| Cancellation | Escape aborted slow local generation; cancelled lifecycle remained visible |
| Missing attempt usage | Unknown-cost fallback scenario preserved missing coverage rather than claiming free generation |
| Soft budget | Applying a threshold below recorded cost activated budget policy on the next user turn |
| Resize | A high-pin draft and Settings section survived wide → narrow; focus returned to the tab row |
| Dimensions | 127-column/46-row wide capture; narrow custom screen during resize; smallest measured session 44 columns/42 rows |
| Scroll/focus | Tab, Shift+Tab/section arrows, numeric input, Page Down and Escape used in native controls |
| Themes | Dark Now/Settings and light Usage inspected; active theme colors used |
| Coexistence | Fixture footer status and below-editor widget remained visible; router never replaced Pi's footer |
| Quiet footer | Widget toggle cleared the router widget and used one status; re-enabling cleared that status |
| Non-TUI | Real Pi subprocess tests cover overview, usage, settings and short status in print, JSON and RPC, without inference |

The initial cancellation attempt used Ctrl+C, which did not invoke Pi's abort
binding. It was repeated with Escape and verified. A resize test initially
assumed field focus survived; screen inspection confirmed the documented
section-row focus reset, and the intended Apply action was then exercised.

## Defects found and corrected

1. The overlay inherited the old full-terminal height. It is now bounded by
   content and available rows, leaving the footer visible on wide terminals.
2. A long advisor suffix consumed a narrow footer's model allocation. A
   regression test reproduced the one-character identity, then passed after
   prioritizing model identity. The 44-column live recheck showed the model.
3. Short status originally bypassed non-TUI output handling. Print now writes
   stderr; JSON emits `router-status`; RPC notifies. Host tests cover each.

## Bounded real-service classifier smoke

A separate actual Pi/agterm session used normal Pi-managed authentication,
without copying auth files, enabling work-profile consent or loading fixtures.
A test-only command called the unchanged development advisor adapters with one
synthetic request, two synthetic candidate IDs, no project/system/history/tool
text, a 512-token recent-state bound, one attempt and a 10-second diagnostic
deadline. The command was one-shot. No generation model was called.

Pi's public auth check reported API-key readiness for TypeSafe and Cloudflare.
Readiness alone was not treated as wire-compatibility evidence.

| Advisor | HTTP | Outcome | Latency | Reported input tokens |
|---|---|---|---|---|
| Jev `jev-1.13.0` | 200 | selected low | 304 ms | 954 |
| Clef | 200 | selected medium | 1,011 ms | 632 |
| Clef Flash | 200 | abstained (`uncertain`) | 584 ms | 632 |

Clef Flash's abstention is a valid result; router policy uses baseline. It is
not an authentication or transport error. The recent-state bound excludes
rubric/request overhead, so reported input can exceed 512 tokens.

All three requests reached their actual services through Pi. The production
1,500 ms default was not changed. One sample per model is not a quality benchmark
or latency guarantee. No bill or savings estimate is inferred from these values.
The Pi chat-classifier path was tested with a local fixture, not another live
paid generation request. Exhaustive backend/model combinations remain untested.

## Screenshots

Captured only the dedicated agterm window with `screencapture -l`, cropped out
window/sidebar chrome and resized with `sips`. No desktop-wide capture, private
transcript, auth values or raw provider responses are included.

- [Now, dark](../assets/router-ui/signal-now-dark.png): actual route, soft-budget
  meter, retained tier bars and the two-line strip.
- [Settings, dark](../assets/router-ui/signal-settings-dark.png): high pin queued,
  actual medium route unchanged, and Undo available.
- [Usage, light](../assets/router-ui/signal-usage-light.png): retained observations
  and honest exclusion of fixture advice lacking HTTP request IDs.

The parent opened and visually inspected all three PNGs. These are synthetic
local observations in real Pi, not measurements from the service smoke.

## Release gates

- Clean dependency install, Biome/TypeScript and 819 tests in 20 suites passed.
- Dependency audit: zero vulnerabilities.
- Package dry run: 23 production files; no test helpers or test files.
- Publication dry run passed. It does not prove trusted-publisher access.
- Changelog/release notes validated (199 words); npm manifest and lockfile both 0.11.0.
- 55 documentation links checked, none broken; five Mermaid diagrams rendered
  and inspected. Prose lint had 24 advisory style findings.
- Staged-diff secret scan and whitespace checks passed.

The generic release-version helper expected a Python `pyproject.toml`; this
npm project's three version fields were instead checked directly against the
intended tag. npm 12 also returned a package-name-keyed dry-run object rather
than the older array; package inspection used that actual output shape.

## Evidence and limits

Local sanitized screen text and live-service summaries:
`/tmp/router-signal-acceptance/evidence/`. Only this report and scoped PNGs are
committed. Unit rendering also covers 40/60/80/120 columns, Unicode model names,
short heights, invalid numeric input, stale transactions and lifecycle teardown.
Live checks used fullscreen Pi; regular-mode behavior has automated component
coverage and the previous release's host evidence, not a new manual run here.
IME and every third-party footer/widget combination were not tested.
