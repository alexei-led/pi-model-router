# Router quality improvements

Apply the approved codebase audit without changing routing policy or replacing the custom-provider architecture. Keep one writer at a time. Run independent read-only review after implementation; the parent owns final acceptance.

## Invariants

- Preserve exact classifier consent, bounded text/privacy, shared deadlines and caller cancellation.
- Preserve deterministic eligible baseline, pin/budget policy, capability/effort validation, explicit fallback order and no retry after visible content.
- Keep Pi responsible for authentication and transport. No live model calls, global agent changes, commits, push, publication or unrelated worktree cleanup.
- Keep strict TypeScript and Biome as the existing lint/format system. New packages are development-only coverage/dead-code tools.
- Historical session snapshots remain readable and sanitized; obsolete phase metadata has no runtime routing effect.
- Each writer records actual commands, results, changed paths and residual risks in its durable workflow output. Do not claim completion from prose alone.

## Task 1: Correct UI state and close test gaps

- [x] Reproduce and fix stale inspector history after `/router log clear` with owner-controlled replacement, persistence and UI publication.
- [x] Reproduce and fix removed-profile reload status; validate final state before final persistence/rendering.
- [x] Move pure UI control validation out of the terminal inspector and retain transaction/conflict behavior.
- [x] Correct the warning privacy assertion and test prompt-independent baseline through the provider pipeline.
- [x] Add simultaneous single-flight waiter tests, including one-waiter cancellation and last-waiter transport cancellation.
- [x] Cover classifier fetch rejection, non-2xx, malformed/oversized response bodies and body deadline/abort with safe diagnostics.
- [x] Remove confirmed duplicate validation cases and extract the duplicated host CLI fixture setup without weakening scenarios.
- [x] Pass focused regression tests and the full existing check/test gate.

## Task 2: Reduce provider complexity without changing behavior

- [x] Characterize the routing, continuation, fallback, accounting and cancellation seams before extraction.
- [x] Extract request preparation/route selection, turn-cache/single-flight coordination and generation attempts into narrow typed responsibilities.
- [x] Keep the provider registration/stream adapter thin; avoid helpers that capture the entire mutable extension state.
- [x] Separate reusable domain guards/model-reference parsing from filesystem configuration loading where this repairs the dependency boundary.
- [x] Remove new runtime phase/lastPhase metadata and provider-specific selection naming; preserve safe reading of historical snapshots.
- [x] Remove obsolete context/type exports only after verifying production references, public package exports and tests; replace redundant legacy tests with active behavior coverage.
- [x] Pass the full check/test gate and record post-refactor function size/complexity and import graph results.

## Task 3: Enforce quality and update current documentation

- [x] Add development-only Vitest V8 coverage and an explicit `test:coverage` script; measure branch coverage before setting defensible core-module gates.
- [x] Add configured production dead-export/dependency checking with Knip and a `check:unused` script; do not silence genuine findings with broad ignore lists.
- [x] Add directional import boundaries and a pragmatic production-only cognitive-complexity baseline/ratchet using the existing Biome tooling.
- [x] Make template-literal style consistent and eliminate the existing non-failing style diagnostics.
- [x] Remove comments from tests by improving names/helpers; retain useful production invariants and remove stale/restating production comments.
- [x] Keep colocated tests and shared fixtures; do not add a duplicate formatter, test DSL or unnecessary duplication gate.
- [x] Verify minimum supported Node 22.19.0 in CI alongside the current Node version, preserving pinned actions and permissions.
- [x] Update architecture, maintainer checks and affected user documentation from actual behavior; leave archived reports unchanged.
- [x] Pass check, coverage, unused-code and package dry-run gates; verify runtime files and the published entrypoint are included without tests/dev artifacts.

## Task 4: Independent review and parent acceptance

- [x] Complete fresh-context routing/security/state and tests/tooling/documentation reviews; fix confirmed findings and re-review changed seams.
- [x] Run final checks in the parent, inspect the complete diff and verify no staged files or unrelated changes.
- [x] Record final metrics, coverage, commands and any exact remaining limitations; report completion only after these checks.
