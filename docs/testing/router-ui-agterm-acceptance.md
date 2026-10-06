# Router UI v2: actual-host acceptance

Date: 6 October 2026. Validation snapshot: `router-ui-v2` development worktree,
based on `e9139816`, before the 0.10.0 release commit. Publication was not part
of these acceptance checks.

**Result:** native-host, real generation/tool-continuation and bounded live
Clef/Clef Flash smoke checks passed with the limits below.
Cloudflare initially lacked credentials. After the operator completed Pi's
API-key login, both live requests succeeded. Local classifier fixtures remain
separate evidence, not a substitute for those requests.

## Environment and isolation

- Actual Pi CLI **1.0.4**, agterm **0.34.0**, commit `c865bc6c`.
- Repository dependencies/type checks: Pi **1.0.2**.
- A dedicated agterm window, workspace and sessions were created. Other
  sessions were neither typed into nor replaced.
- Dev package installed from the new sibling worktree, not npm:
  `pi install --local <absolute-dev-worktree>`.
- Installation and the fixture process used the same isolated
  `PI_CODING_AGENT_DIR`. `pi list --approve` and startup confirmed the local
  source. Only the router and the explicit fixture extension were loaded.
- Agterm tree confirmed realized terminal surfaces and Pi as foreground.
  These were real TUI sessions, not HTML overlays, RPC screenshots or mocked
  component renderings.
- The fixture uses synthetic profiles, synthetic authentication entries and
  registered local providers. No personal credentials were copied into it.
  Its `LOCAL FIXTURE · no network` status distinguishes it from live testing.

The original launch failed with `env: node: No such file or directory`.
An explicit PATH fixed the GUI environment. That failed launch was not counted
as a successful extension load.

## Reproduce the fixture setup

In a disposable project, with an absolute dev-worktree path:

```sh
export PI_CODING_AGENT_DIR=/tmp/router-ui-acceptance/agent
mkdir -p "$PI_CODING_AGENT_DIR"
pi install --local /absolute/path/to/pi-model-router.worktrees/router-ui-v2
pi list --approve
```

Place a user router configuration in that sandbox agent directory. Use profile
`auto` with `router-fixture/high`, `medium`, `low`, `micro`;
give high/medium the explicit fallback `router-fixture/fallback`.
Enable debug collection. Leave external advisors disabled for the first pass.

Launch actual Pi through `agtermctl session new --command`, with explicit
window/workspace and sandbox cwd. The command uses:

```text
env PATH=<node-and-pi-bin>:/usr/bin:/bin:/usr/sbin:/sbin
    PI_CODING_AGENT_DIR=<sandbox-agent-dir>
    <absolute-pi> --approve --offline --no-mcp --no-skills
    --no-context-files --no-prompt-templates
    --session-dir <sandbox-sessions> --model router/auto
    --extension <dev-worktree>/extensions/test/router-ui-fixture.ts
    --tools fixture_echo
```

This is one command line, shown wrapped for readability.
Read agterm tree before injecting input into that exact session ID.
Agterm command entry may first accept a completion; verify the prompt is
submitted before entering the next command.

The checked-in fixture exposes `/router-demo` scenarios:
`baseline`, `fallback`, `unknown`, `tool`, `slow`,
`advisor-timeout`, `advisor-invalid`, and `failure`.
`/router-demo-size` reports the actual terminal dimensions.
`/router-demo-check` checks the synthetic classifier registration.

For local Cloudflare-path tests, the fixture overrides the Cloudflare
classifier implementation with an in-process deterministic implementation.
Enable Cloudflare only for this synthetic sandbox profile. Supply a fake
sandbox credential with key `local-fixture-no-network` and account ID
`fixture-account`; these are not service credentials. Initial fixture
attempts without the account ID correctly failed Pi authentication. The
normal, non-fixture Cloudflare environment remained unauthenticated.

Never reuse that fixture extension or fake credentials for live acceptance.

## Executed checks

| Check | Result / evidence |
| --- | --- |
| Dev install and startup | Local package source shown by Pi, foreground verified in agterm tree |
| Baseline generation | `router/auto` dispatched `router-fixture/medium` and remained logically selected |
| Native strip and four tabs | Rendered in actual Pi, without replacing the host footer/editor |
| Session draft | Changed pin auto → high; Apply left the actual medium route unchanged until the next user turn |
| Activation | The next fixture request dispatched high |
| Apply/discard/undo | Actual keyboard actions, pending feedback and restoration observed |
| Pre-content fallback | Primary failed; explicit fallback ran; both known costs counted |
| Exhausted fallbacks | Both fixture targets failed before content; the strip showed failed with no observed generation |
| Tool continuation | `fixture_echo` ran; the following decision recorded `reuse: continuation` |
| Cancellation | Slow fixture aborted; no fallback generation; strip showed cancelled after the display fix |
| Unknown cost | An error attempt with unknown reported cost followed by successful fallback produced partial coverage, not a zero-cost claim |
| Clef / Clef Flash selection | Both exercised through the local classifier provider in actual Pi; not live Cloudflare |
| Advisor deadline | Local advisor waited for cancellation; the router used baseline under the shared 1500 ms bound |
| Invalid advice | A foreign candidate was rejected; baseline used |
| Privacy gate | Disabling the sandbox profile's Cloudflare approval produced unavailable/baseline |
| Soft budget | An exceeded sandbox generation budget bypassed advice and used baseline |
| Reload | Source edits were picked up; activated pin persisted after the undefined-override fix |
| Widths | Actual 40/60/80/120-column sessions measured by the fixture; inspector open/close and narrow layout exercised |
| Resize | Draft and Classifier tab survived wide → narrow → wide |
| Scrolling / focus | Page Down, Tab, arrow keys, Escape and return to prompt exercised |
| Themes | Dark and light were visually inspected; light foreground contrast was corrected before final capture |
| Coexistence | Another keyed fixture status and below-editor widget remained visible |
| Regular mode | Separate actual Pi `--tui-mode regular` session opened and closed the inspector |
| Print / JSON / RPC | Real-host subprocess tests return section text without starting inference; print diagnostics use stderr |
| Branch/legacy/dedupe edge cases | Automated regression suites, not a claimed exhaustive manual terminal matrix |

Agterm clamps this window to at least 640 points wide. The 40-column check
therefore used a larger font in the dedicated fixture session. Its font was
reset afterward. Full-size captures use the ordinary fixture font at
1320 × 900 window points (127 columns × 46 rows).

## Defects found by real-host validation

All listed corrections were exercised again:

1. An aborted provider terminal event was displayed as idle. The observation
   now reports cancelled; the provider cancellation regression was seen red
   before the fix and then passed.
2. UI-created effort maps contained undefined-valued keys. In-memory reload
   rejected the newest snapshot and restored an older pin. Undefined overrides
   are now omitted; pin activation followed by reload retained the high pin.
3. Print-mode `notify` produced no output. Print now emits diagnostics to
   stderr; JSON emits a custom message; RPC uses notifications. Actual-host
   tests cover all three without inference.
4. The initial overlay had no visual separation; it now has a themed frame.
   Light mode initially inherited white terminal text on a light background;
   explicit theme text color fixed contrast.
5. Narrow custom screens used the whole terminal height and lost controls
   behind host chrome. They now reserve rows for the host footer/widgets.
   The 40-column recheck showed action controls and a working scroll path.

The independent code review also found four P2 issues. They were fixed with
regressions: cross-profile session-wide pending controls, requested text-mode
sections, an explicit failed lifecycle, and positive fractional timeout values.
Unrelated external settings are rebased into pending views; overlapping edits
still fail compare-and-set.

## Approved live generation smoke

The operator approved at most four synthetic requests with an estimated
cost ceiling of $0.10. Two generation calls and two subsequent Cloudflare
classifier calls were made.

A separate actual Pi/agterm session used the normal Pi authentication path,
a synthetic project profile `router/live-smoke`, and the dev extension.
No auth file was copied. Its only tool was read-only `fixture_echo`.
The system prompt asked for exactly one echo call followed by `OK`.
A test-only request hook limited the payload size, output to 256 tokens, and
logical requests to two. Agent retries/compaction were disabled.

| Call | Actual model | Outcome | Reported catalog cost |
| --- | --- | --- | --- |
| 1 | `openai-codex/gpt-6-luna`, off | Tool call | $0.000016 |
| 2 | Same model/effort | `OK`, stop | $0.0000142 |

Total: **$0.0000302**, 207 input and 19 output tokens.
This is catalog pricing, not subscription billing or an invoice.
Saved router metadata recorded baseline, then validated continuation on the
same physical model while the logical profile remained selected.

## Approved live Cloudflare smoke

The initial `pi auth check --provider cloudflare-workers-ai --no-refresh --json`
returned `not_ready / credentials_not_configured`. After the operator used
`/login cloudflare-workers-ai`, the same check returned `ready / api_key`.
No credential values were printed, copied into fixtures, or committed.

The existing actual Pi/agterm live session loaded a test-only command which
called the **unchanged dev `runCloudflareDetailed` adapter** through its normal
`ctx.modelRegistry`. It used a synthetic one-message task, two current
candidate IDs, no system prompt/history/tool output, a 512-token state bound,
a 10-second total deadline and one HTTP attempt per model. A shared fetch
counter and a one-shot local result file prevented additional requests.
No global router configuration or work-profile consent was changed.

| Model | HTTP / validation | Observed latency | Reported input tokens | Catalog input-cost estimate |
| --- | --- | --- | --- | --- |
| `@cf/cloudflare/clef` | 200 / selected | 1305 ms | 715 | $0.0001716 |
| `@cf/cloudflare/clef-flash` | 200 / selected | 1083 ms | 715 | $0.00006435 |

Both selected the low candidate through the existing cumulative-probability
policy. Confidence was below the direct-choice threshold; accepted cumulative
mass was 0.8464 and 0.8179 respectively. Strict response checks passed.

Cloudflare total: **$0.00023595**. Combined with generation:
**$0.00026615** across the four approved calls. Estimates use service-reported
tokens and catalog rates, not invoices. The production 1500 ms default was not
changed. One sample per model is not a quality benchmark or latency guarantee.

Sanitized local evidence: `/tmp/router-ui-v2-acceptance/live-cloudflare.json`
and `/tmp/router-ui-v2-live/classifier-result-screen.txt`. The tested generic
Cloudflare endpoint plus required inner selector worked for these requests.

## Screenshots

These PNGs were captured from the dedicated agterm window using scoped
`screencapture -l <window-number>`, then cropped with `sips`.
Only fixture data is shown. They are not reconstructed terminal renders.

- [Now, dark](../assets/router-ui/router-now-dark.png): terminal content,
  above-editor strip and actual native inspector; used in README.
- [Classifier draft](../assets/router-ui/router-classifier-draft.png):
  native inspector crop showing a pending Clef → Clef Flash change.
- [Usage, light](../assets/router-ui/router-usage-light.png):
  retained-history coverage, synthetic advisor samples and unknown charges.

The parent opened and visually inspected the captured images. The final reviewer
found that the first Usage capture predated median rounding. It was recaptured
from the final source: both the image and `final-code-usage.txt` now show
`Median advisory latency: 1 ms`. The targeted fixture session was selected and
verified active before capture.
No full-desktop capture, auth store, private transcript or raw provider response
is checked in.

## Verification and limits

- `npm run check`: passed.
- `npm test`: **787 tests, 18 suites passed** at the final integrated-code gate.
- `npm run pack:dry`: passed; 21 files, fixture/test files excluded.
- `git diff --check`: passed.
- Documentation links: 27 checked, no broken links in the five current docs.
- Five Mermaid diagrams rendered and were visually inspected. The default
  renderer lacked its pinned Chrome binary; using the installed Chrome fixed
  that tooling error. Prose lint reported 15 advisory style findings.
- Independent final code review: OK with notes, no new code defects; all four
  prior P2 findings confirmed fixed. Its remaining stale-screenshot finding was
  corrected by recapture and parent visual/text verification. Later live
  Cloudflare evidence was added without production-code changes.

Local raw evidence is under `/tmp/router-ui-v2-acceptance/` (screen text and
synthetic session records) and `/tmp/router-ui-v2-live/` (live smoke metadata).
Only the sanitized findings and scoped screenshots belong in the repository.

**Limits:** live wire compatibility is sampled, not exhaustively established.
Routing quality and latency distributions were not benchmarked. IME and every
possible combination of third-party widgets have not been manually tested. The old plan-exec cleanup remains separate and was not
performed or used as an implementation source.
