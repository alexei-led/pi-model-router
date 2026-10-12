# Adaptive routing and native Routes: acceptance

Date: 11 October 2026. Branch: `feature/adaptive-router-and-ui`.
Initial runtime source: `de2011d1`; final repaint fix: `100fd6c0`.
No release, version change, push or merge.

**Result:** automated gates and native adaptation, route-edit activation,
reset/inheritance and tier-effort masking checks pass. The repaint defect has a
regression and independent review. Its final screenshot could not be captured
because the macOS GUI session was locked.

## Isolation and evidence

- Actual Pi 1.1.0, loaded directly from an isolated development worktree.
- Dedicated agterm window and disposable agent/session directories. Only the
  router and `extensions/test/adaptive-router-fixture.ts` were loaded.
- Local deterministic providers and classifier; no network, personal credentials,
  private prompts or auth storage. The footer says `LOCAL FIXTURE · no network`.
- Screenshots are scoped terminal captures, cropped to remove application chrome.
  They are not HTML prototypes or reconstructed component renders.

Two new user tasks each produced 21 requests. Persisted router generation
metadata establishes these changes in the first loop:

```text
balanced/low → balanced/high → deep/xhigh → docs/low → balanced/low
```

The native Routes editor queued `code/medium → adaptive-fixture/docs / low`.
Actual generation stayed `balanced/low` while queued. On the next user task,
that code cell generated with `docs/low`; debug used `deep/xhigh` and the loop
returned to `balanced/low`. The logical selection remained `router/adaptive`.
Pi's logical message thinking field can lag a route change; this evidence uses
persisted router generation decisions, not that field.

## Native checks

| Check | Observation |
|---|---|
| Advanced settings | Review interval, horizon, sensitivity and strong-advice controls rendered |
| Routes | Sparse cell selector, physical-model search and supported-effort picker worked |
| Pending vs actual | Routes and Now/strip showed queued changes without claiming generation changed |
| Activation | Next user boundary applied the code-cell edit; saved generation metadata matched |
| Layout | Wide floating right overlay; narrow custom screen replaces the editor, not a docked sidebar |
| Resize/focus | Wide → narrow → wide, Escape/back and Routes focus restoration worked |
| Themes | Dark controls and light Now screen inspected; footer fixture label remained visible |
| Reset/masked effort | Native code/medium reset to inherited generic medium; scalar medium/off persisted and masked cell effort during generation |
| Cleanup | Owned fixture session and window closed; absence/closed state verified |

Agterm window sizes were 1200×850 and 800×650 points. Window chrome/sidebar
reduce usable columns. These are not claims of exhaustive width, IME or widget
coexistence coverage. Later input timed out after 30 seconds; even
`agtermctl version --json` timed out after 10 seconds. The app was not restarted
because unrelated sessions could be affected. After the operator restored
agterm 0.36.0, a new isolated fixture completed reset/masking checks. The old
fixture sessions were already absent. Only the newly owned session/window were
closed; unrelated sessions were not touched.

## Captures

- [Advanced controls, dark](../assets/router-ui/adaptive-settings-dark.png).
- [Routes queued, dark](../assets/router-ui/adaptive-routes-pending-dark.png).
- [Now with pending routes, narrow light](../assets/router-ui/adaptive-now-narrow-light.png).

The parent inspected these captures. The light image predates the final fix and
shows the background discontinuity that led to it. A fresh resumed fixture
reproduced the issue: a nested background reset left padding at the terminal
default. The fix retains success foreground and lets the panel own the full row
background. The terminal-paint regression failed before the fix and passed after.
Opus 5.5 reviewed the current code and Pi theme reset semantics with no required
changes; its restricted tools could not inspect the git diff. Post-fix native
recapture failed because the GUI was locked. Truncated/embedded ANSI styling and
pixel-perfect repaint are not exhaustively verified.

## Verification

- Build, Biome/TypeScript, knip and package dry-run: passed.
- **612 tests in 23 files passed**, including the coverage gate.
- Overall coverage: statements 91.45%, branches 84.25%, functions 92.94%, lines
  93.08%. Thresholds were not reduced. Coverage is not proof of correctness.
- Package dry-run: 28 files; no tests or fixture extensions included.
- Comprehensive revmux: four sources, no degradation; actionable findings fixed.
- After-fix `final` review: Opus 5.5 and GPT-6 Astra, both high effort;
  two of two sources reported, no degradation, no findings. This pass gates
  major defects in the fixes, not every possible architecture or UX issue.
- Router Off live-stream completion/cost and activity-abstention economic hold
  have regressions, as do review provenance, cancellation/expiry, pending-route
  activation/capability refresh and narrow status suffixes.

Local raw evidence remains outside the repository. No provider-cache retention,
real billing savings, advisor quality or live-service compatibility is inferred
from these fixtures. Post-fix screenshot confirmation remains unperformed because
of the GUI lock. This report is not a release sign-off. Git branch/worktree
cleanup is deferred until a separately authorized release.
