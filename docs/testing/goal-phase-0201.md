# Goal/phase routing acceptance — 2026-11-13

## Scope

Version 0.20.1 separates the classifier's durable goal from its immediate phase.
The `activity` answer remains the goal wire field. No routes, classifier approval,
permissions or provider transports are added.

## Automated evidence

The full suite contains 1,173 passing tests across 38 files. New cases exercise
Pi's production classifier request/parser and provider route selection, not just
a standalone policy helper:

- Code goal through verify, commit and report; explicit new documentation task.
- Only positive semantic new-task evidence seeds an anchor. Unanchored approvals,
  uncertain/missing relations and low-confidence new-task answers do not seed.
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
89.02% branches, 95.26% functions and 95.19% lines. Audit reported zero
vulnerabilities in this repository's dependency graph. Node 22.19.0 build passed.
The package dry run contains 35 files, without tests or test helpers.
Publication dry run does not establish npm OIDC access or publish a version.

## Limits

The automated checks are fresh synthetic boundary/regression cases and
deterministic classifier fixtures, not a semantic holdout. They do
not prove that a classifier obeys the rubric, that Jev 1.14 improves routing, or
that routing saves money. No private prompts were sent to public classifiers.
There was no native visual TUI exercise for this change. Classifiers without reliable phase/continuity answers degrade
conservatively as documented in the [classifier guide](../classifier-advisor.md).

## Small live Jev 1.14 smoke

Eight synthetic inputs were sent through Pi's public `models.classify()` registry
operation to `typesafe/jev-1.14.0`, with the production `buildChoicePayload`
rubric and production choice parsers. No shared configuration or direct provider
transport was used. All eight operations stopped normally and their distributions
parsed. The goal/phase/continuity threshold was 0.65. Known total classifier cost
was $0.00040467.

| Synthetic boundary | Observed goal | Observed phase | Continuity / policy |
| --- | --- | --- | --- |
| Find and implement a parser fix with regression tests | code 1.00 | produce 0.33 | new-task 1.00; low phase keeps code |
| Explain a worker failure without edits | debug 0.81 | reason 0.75 | new-task 0.72 |
| Author a retry configuration file and tests | code 1.00 | produce 0.96 | new-task 1.00 |
| Run only specified unit checks, no edits or diagnosis | ops 0.75 | verify 0.96 | new-task 0.73 |
| Yes, proceed, after a prior test proposal; no activeGoal | code 0.92 | verify 0.46 | continuation 1.00; no anchor seeds |
| Agreed checks with an existing parser goal | code 0.45 | verify 0.99 | uncertain 0.46; anchored advice falls back |
| Explicit new user-manual task over an old parser goal | docs 0.98 | produce 0.83 | new-task 1.00 |
| Complete the task in an unavailable brief | uncertain 0.92 | uncertain 0.87 | uncertain 0.68; no ops or anchor |

The anchored-check abstention is a limitation, not a success or a reason to lower
thresholds. These eight developmental examples are not an independent holdout,
quality benchmark, savings result or comparison with Jev 1.13. They do not prove
that the rubric generalizes to real tasks.
