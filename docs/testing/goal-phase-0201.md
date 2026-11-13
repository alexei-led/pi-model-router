# Goal/phase routing acceptance — 2026-11-13

## Scope

Version 0.20.1 separates the classifier's durable goal from its immediate phase.
The `activity` answer remains the goal wire field. No routes, classifier approval,
permissions or provider transports are added.

## Automated evidence

The full suite contains 1,167 passing tests across 38 files. New cases exercise
Pi's production classifier request/parser and provider route selection, not just
a standalone policy helper:

- Code goal through verify, commit and report; explicit new documentation task.
- Missing, uncertain, low-confidence and malformed phase or continuity answers.
- Unknown goal and a missing referenced brief do not manufacture an ops route.
- Current-loop text is separate from earlier dialogue; prior proposals can remain
  reference evidence for a short approval without becoming the current step.
- Native notifications cannot authorize phase-derived ops.
- Native owner, branch ancestry, prior-message identity, config and request epoch
  fence the runtime goal anchor. Native tree navigation aborts the old runtime. Ambiguous continuity drops it.
- Changed message prefixes reject reviews. Appended evidence expires phase advice
  even when otherwise valid tier/goal advice remains usable.
- Fresh SDK sessions do not inherit foreign anchors; router state does not persist
  goal text. Legacy snapshots and activity-only diagnostics remain readable.
- Usage separates legacy activity labels from goal/phase effective activities.

Existing tests continue to cover cancellation, pin/budget precedence, Google
continuation constraints, escalation, switch costs and immutable fallback plans.

## Local release checks

Node 24.15.0: frozen install, Biome/TypeScript, full coverage, Knip, package dry
run, npm audit and publication dry run passed. Coverage is 93.90% statements,
88.99% branches, 95.26% functions and 95.19% lines. Audit reported zero
vulnerabilities in this repository's dependency graph. Node 22.19.0 build passed.
The package dry run contains 35 files, without tests or test helpers.
Publication dry run does not establish npm OIDC access or publish a version.

## Limits

These are fresh synthetic boundary/regression cases and deterministic classifier
fixtures, not a semantic holdout or a live classifier-quality benchmark. They do
not prove that a classifier obeys the rubric, that Jev 1.14 improves routing, or
that routing saves money. No private prompts were sent to public classifiers.
There was no live classifier inference or native visual TUI exercise for this
change. Classifiers without reliable phase/continuity answers degrade
conservatively as documented in the [classifier guide](../classifier-advisor.md).
