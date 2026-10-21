# Five-tab routing observability: native acceptance

Date: 21 October 2026. Release candidate: 0.15.0.
Branch: `feature/router-observability-tabs`.

## Isolation

- Actual Pi 1.3.0 in agterm 0.36.0, loaded directly from this development checkout.
- A dedicated agterm window with disposable basic and adaptive fixture sessions.
  Only the router and checked-in test fixture extensions were loaded.
- Isolated HOME, agent directories and session storage. No personal auth files,
  provider credentials, work prompts, MCP servers or third-party extensions.
- Deterministic local generation and classification. Both footers explicitly say
  `LOCAL FIXTURE · no network`. No production-service requests or model downloads.
- Scoped window captures, cropped to the terminal and resized for documentation.
  These are real Pi/agterm images, not reconstructed component or HTML renders.

## Observed behavior

| Check | Result |
| --- | --- |
| Navigation | Five tabs and direct Routes/Classifier commands rendered and opened |
| Actual route | Now showed physical provider/model and effective effort, while logical router selection stayed stable |
| Switch history | Physical model changes and same-model effort changes appeared as separate transitions |
| Classifier selection | A different local classifier stayed pending until a new user goal, then changed generation from medium to high |
| Approval | The restricted profile showed explicit missing approval without granting consent |
| Last operation | A 100 ms local classifier timeout remained visible after logging was turned off and history cleared |
| Routes | Grid showed inherited/overridden cells; native model search and supported-effort selection worked |
| Pending vs actual | Apply routes displayed queued configuration while current generation stayed unchanged |
| Activation | The next adaptive goal used the edited code/medium physical target; saved generation metadata matched |
| Effort masking/fallbacks | Basic editor preserved ordered fallback references and labeled the active tier-wide effort override |
| Usage | Compact cost/coverage and route mix rendered; Details exposed HTTP/cache diagnostics |
| Empty history | Logging off showed a short explicit message, not a wall of unknown totals |
| Resize/theme | Wide → narrow → wide preserved the active tab and unapplied classifier draft in light theme |
| File ownership | Native selection and route edits did not replace the original router configuration targets |
| Cleanup | Only the owned fixture sessions/window were closed; unrelated sessions were not changed |

Wide captures used a 1250×920-point window. Narrow captures used 800×650 points.
Application chrome and sidebar reduce usable terminal columns. Automated tests
also cover shorter terminals, Unicode width, focus and theme-colored row padding.

### Automatic adaptation and route-edit activation

The first adaptive user goal completed **21 generation requests**. Saved router
generation decisions established this sequence:

```text
balanced/low → balanced/high → deep/xhigh → docs/low → balanced/low
```

The activity sequence was explore → code → debug → docs → explore.
The logical model stayed `router/adaptive`.

The native Routes editor then queued
`code/medium → adaptive-fixture/docs [high]`.
Generation remained on the previous route while this was pending.
A second 21-request goal produced:

```text
balanced/low → docs/high → deep/xhigh → docs/low → balanced/low
```

The code activity's saved decision used the edited physical target.
This checks actual delegation and activation, not only the advisor label or
Pi's logical thinking field.

## Regressions found during validation

- Classifier cycling rebuilt the current selection at the front of the list,
  making later catalog entries unreachable. The regression failed before the
  fix and passed after. Sorted selection and an explicit None option are covered.
- Independent review identified unchanged-route metadata loss, non-text classifier
  mislabeling and missing-start-time operation ordering. Regressions cover each.
- Last-operation provenance now refreshes at selection, before a long generation
  completes. This timing edge is covered by an automated regression.
- Native automation initially read stale screen text and used an insufficient
  catalog-navigation bound. Final assertions checked newly persisted assistant
  entries and completed tool loops, not old transcript text. These were harness
  synchronization failures, not successful acceptance results.
- Window capture was retried only after verifying the owned native window.
  No desktop-wide capture or unrelated terminal image was taken.

## Screenshots

The parent opened and visually inspected all captures. Fixture model names,
prices, deadlines and latencies are illustrative, not defaults or benchmarks.

- [Now and model/effort history](../assets/router-ui/tabs-now-dark.png).
- [Route grid](../assets/router-ui/tabs-routes-dark.png).
- [Queued route edit](../assets/router-ui/tabs-routes-pending-dark.png).
- [Classifier selection and provenance](../assets/router-ui/tabs-classifier-dark.png).
- [Missing profile approval](../assets/router-ui/tabs-classifier-unapproved-dark.png).
- [Timeout diagnostics with logging off](../assets/router-ui/tabs-classifier-timeout-dark.png).
- [Compact Usage](../assets/router-ui/tabs-usage-dark.png).
- [Settings](../assets/router-ui/tabs-settings-dark.png).
- [Logging off, narrow light theme](../assets/router-ui/tabs-usage-off-narrow-light.png).
- [Classifier draft retained on resize](../assets/router-ui/tabs-classifier-draft-narrow-light.png).

## Automated checks and limits

| Gate | Result |
| --- | --- |
| Biome and strict TypeScript | Passed |
| Full Vitest coverage | 631 tests in 23 files passed |
| Aggregate coverage | Statements 91.55%, branches 84.46%, functions 92.99%, lines 93.14% |
| Knip | Passed |
| Package inspection | 28 files, no tests, fixture extensions or secrets |
| npm audit | Zero vulnerabilities after the compatible Vite lockfile update |
| Publication dry run | Passed, including all prepublish gates; this does not prove OIDC publication access |
| Workflow checks | actionlint passed; zizmor reported no findings |
| Documentation | 62 links checked with none broken; four Mermaid diagrams rendered and visually inspected |
| Independent review | No blockers after fixes; operation-at-selection timing has its own regression |

Release metadata tests fail closed on missing/empty changelog notes or a
mismatched tag. A mocked GitHub API verified the exact release title and use
of reviewed committed notes, without publishing anything.

The SDK/host tests use Pi 1.1.0; native GUI acceptance uses Pi 1.3.0.
No routing-quality improvement, real-service latency distribution, backend
cache retention or billing savings is inferred from these fixtures.
IME, mouse behavior and every third-party widget combination are not exhaustively
verified. Current routing policy and credential ownership are unchanged.

Sanitized raw evidence remains in the disposable `pi-router-015-*` directory:
visible-screen text, owned session JSONL and `native-adaptive-summary.json`.
Only this report and scoped screenshots are committed.
