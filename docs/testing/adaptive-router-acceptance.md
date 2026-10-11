# Adaptive routing and native Routes: acceptance

Date: 11 October 2026. Branch: `feature/adaptive-router-and-ui`.
Runtime source: `de2011d1`; validation-only tests: `7216fe5a`.
No release, version change, push or merge.

**Result:** automated gates pass. Native adaptation and route-edit activation pass;
remaining native checks are blocked by agterm control timeouts.

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
| Reset/masked effort | Automated regressions pass; final native interactions not completed |
| Cleanup | Final fixture-session cleanup not completed |

Agterm window sizes were 1200×850 and 800×650 points. Window chrome/sidebar
reduce usable columns. These are not claims of exhaustive width, IME or widget
coexistence coverage. Later input timed out after 30 seconds; even
`agtermctl version --json` timed out after 10 seconds. The app was not restarted
because unrelated sessions could be affected.

## Captures

- [Advanced controls, dark](../assets/router-ui/adaptive-settings-dark.png).
- [Routes queued, dark](../assets/router-ui/adaptive-routes-pending-dark.png).
- [Now with pending routes, narrow light](../assets/router-ui/adaptive-now-narrow-light.png).

The parent inspected the original captures. The light capture contains a
background discontinuity after the effort text; text and controls remain
readable, but pixel-perfect repaint was not established before control failed.

## Verification

- Build, Biome/TypeScript, knip and package dry-run: passed.
- **611 tests in 23 files passed**, including the coverage gate.
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
from these fixtures. Native reset/masked-effort, repaint and cleanup checks remain
open; this report is not a release sign-off.
