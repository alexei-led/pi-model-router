# Release 0.17.0 readiness

Prepared: 2026-10-25. Candidate: `@alexeiled/pi-model-router@0.17.0` / `v0.17.0`.
**Publication is not authorized.** Merge through a reviewed PR, then obtain approval before the signed tag is pushed.

## Version recommendation

Use a **minor release**, not `0.16.1`.
This release adds automatic activity defaults, a mode selector, route previews and high-tier cost recovery.
Recognized existing profiles can change behavior and use additional models on reload.
The opt-out and required restart are documented in the [0.17 changelog](../../CHANGELOG.md#0170---2026-10-25).

The verified previous published release is [v0.16.0](https://github.com/alexei-led/pi-model-router/releases/tag/v0.16.0).
The npm `latest` tag was `0.16.0` during preparation. The candidate version was absent (`E404`).
No candidate tag, GitHub release or npm publication was created.

## Validation

| Gate | Result |
| --- | --- |
| Frozen install | `npm ci --ignore-scripts` passed with the final lockfile |
| Node 22.22.1 | Full 893-test suite passed. Golden matrix rechecked after fixture optimization |
| Node 24.15.0 | 893 tests across 34 files passed with coverage thresholds |
| Lint / formatting / imports / types | `npm run check` passed |
| Unused production graph | `npm run check:unused` passed |
| Package contents | 32 files. Presets and UI preview included. Tests, fixtures and credential files excluded |
| Publication dry run | `npm publish --dry-run --access public` passed, including all prepublish gates |
| Dependency audit | Repository dependency graph: zero advisories after the scoped development updates |
| Release notes | Changelog section checked as a minor release, 249 words |
| Native acceptance | [Modes, recovery, Settings, resume and cleanup](routing-modes-017-acceptance.md) |

CI still needs to run after the PR is opened. Its exact Node matrix is 22.19.0 and 24.15.0.
Local Node 22.22.1 coverage does not replace that CI result.
A dry run does not establish npm OIDC authorization or publication success.

Prepared archive: `alexeiled-pi-model-router-0.17.0.tgz`.
SHA-256: `77802f784b9c291e9c7414c19594e4f7c589c00ba4a399bf25255cd3839fd7c7`. This identifies the inspected local artifact, not a published package.

### Test-setup correction

One coverage dry run hit the golden matrix fixture's existing 10-second hook timeout under host load.
The fixture repeatedly normalized the same declarations for the table's 2,940 route decisions.
It now shares deeply frozen declarations while retaining every request-preparation call and assertion.
The timeout and coverage thresholds are unchanged. No tests were skipped in the passing run.

The focused command's wall time changed from 6.46 seconds to 5.43 seconds.
Those timings include machine load and are not a benchmark.
The complete publication dry run passed after the correction.

## Release review

The six-model release panel recommended a minor version and found one P2: consumed steering/follow-up users bypassed Settings activation.
The fix uses an awaited user-message boundary while retaining the ordinary prompt path, owner/epoch checks, validation and persistence.
Regression coverage includes real native SDK queues and two fresh agterm sessions.
See the [consumed-user acceptance](routing-modes-017-acceptance.md#consumed-steering-and-follow-up-regression).
The panel found no other confirmed defect. Focused post-fix review found no confirmed defects in the user-boundary correction.
Its CI, approval and host-risk conditions remain in force.

## Separate Pi-host dependency advisory

**A clean repository audit does not mean the installed Pi host is patched.**

During preparation, published Pi 1.4.0 and the inspected local Pi installation both pinned `undici@8.10.2`.
That version matches [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c),
including a high-severity denial-of-service issue involving malicious HTTP content-encoding responses.
Router-specific exploitability was not established. No exploit was attempted.

The repository uses an `undici@8.12.2` root override for its development and native-fixture dependency graph.
Vitest and its coverage provider are pinned together at 5.0.5. The lockfile resolves patched Zod 4.6.7.
The final repository audit reported zero advisories.

These changes do **not** rewrite a separately installed Pi runtime.
Dependency-level npm overrides are not a host remediation.
The running Pi installation was not modified, and peer compatibility remains Pi `^1.1.0`.
Do not advertise this router release as fixing Pi's runtime dependency vulnerability.

Approval must distinguish the router candidate from this remaining upstream host risk.
An upstream Pi fix or a separately authorized host patch is outside this release preparation.
Recheck the upstream dependency and candidate availability before publishing.

## Publication owner and remaining actions

[The release workflow](../../.github/workflows/release.yml) owns npm publication and the GitHub release.
It requires an annotated, verified signed tag that matches `package.json` and points to a commit on `main`.
It uses npm provenance and extracts the reviewed changelog section as the only authored release notes.

Before publication:

1. Review and approve the candidate and the disclosed host-risk scope.
2. Open and merge the release PR after CI passes.
3. Recheck the version and signed tag target.
4. Push the approved signed tag through the documented release workflow.
5. Verify registry metadata, provenance and GitHub release artifacts afterward.

No publication, push or global installation is part of this prepared state.
