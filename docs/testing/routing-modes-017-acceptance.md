# Routing modes 0.17 acceptance

Date: 2026-10-25. Native checks used Pi 1.4.0 and agterm 0.36.0.
All task-created sessions were isolated from existing operator sessions.

## Real model-backed comparison

Three fresh sessions used the same synthetic Node.js counter/retry diagnosis prompt.
Each used the existing OpenAI profile, built-in activities and Jev `typesafe/jev-1.14.0`.
Only the project mode differed. No repository files or commands were available to generation.

All three classifier operations selected `high/debug`.

| Mode | Actual generation | Observed input tokens | Observed output tokens |
| --- | --- | ---: | ---: |
| cost | `gpt-6.1-sol / high` | 539 | 302 |
| balanced | `gpt-6.1-sol / xhigh` | 540 | 1,129 |
| quality | `gpt-6.1-sol / max` | 539 | 985 |

The route strip showed the selected project mode and the corresponding effort.
These are single runs, not a quality benchmark or a savings measurement.
The differing token counts are observations, not a promise about another task.

## Native cost-recovery loop

A separate fresh Pi/agterm session used the local registered classifier and provider in
[`mode-recovery-fixture.ts`](../../extensions/test/mode-recovery-fixture.ts).
Only its model boundaries were synthetic. Pi ran the actual extension, tool loop and built-in `write` tool.
No network or account credentials were needed.

Observed sequence:

1. The classifier selected `high/ops` in cost mode, preferring Haiku/high.
2. A local check failed.
3. Pi wrote `recovery-proof.txt` in the temporary working directory.
4. The same local check failed again.
5. The next generation used Opus/high, the balanced high cell.
6. The strip showed `Cost recovery · balanced high route` while the mode remained `cost (profile)`.
7. The next user task retained Opus/high during the one-turn cost hold.
8. The following task returned to Haiku/high after expiry.

The physical trace was Haiku, Haiku, Haiku, Opus, Opus, Haiku, all at high effort.
The reproduction is automated by:

```sh
npm test -- extensions/mode-recovery-host.test.ts
```

Unit checks also cover context-ineligible recovery targets, pins, manual effort, budgets,
Google thought signatures, configuration replacement and sibling branches.
An ineligible recovery proposal retains the valid cost incumbent instead of resetting it to baseline.
A hold is armed only after an eligible recovery plan is found.

## Settings, preview and session ownership

A fresh local OpenAI-provider fixture session checked the native inspector with equal illustrative input prices.
It had no advisor or explicit activity cells.

1. Settings exposed **Session mode** beside **Pin tier**.
2. Selecting cost changed only the draft. Actual generation remained Sol/medium.
3. Apply queued the mode. Routes showed current balanced preferences and separate queued cost preferences.
4. A new user message activated cost. Actual generation became Sol/low, using the effort lever.
5. Routes then showed cost as current, with no queued preference.
6. The saved `router-state` entry contained the activated `modeOverride: "cost"`.
7. After closing that process, a fresh Pi runtime resumed the same session and restored `cost (session)`.
8. `/new` cleared the override and showed `balanced (default)`.

The equal-price fixture correctly used effort reduction rather than claiming a cheaper-model switch.
The generated [mode preferences](../mode-preferences.md) separately cover both families and all 56 preset cells.
Documentation tests parse the JSON tuning examples and verify their actual precedence and policy effects.

## Consumed steering and follow-up regression

The release panel found that `before_agent_start` does not run when queued steering or follow-up input is consumed.
Settings activation now also uses the awaited, owned user `message_end` boundary.
Both paths share validation, logical-model refresh and persistence.
Custom-triggered turns, raw input queueing, assistant messages and tool results do not activate pending intent.
Foreign-owned user events cannot drain the active session's pending controls.

The orchestrator regression failed before the fix and passed afterward.
Two additional tests use fresh native SDK sessions and the real queues/tool loop, with only model and terminal boundaries replaced.
They operate the actual Settings selector and Apply action:

```sh
npm test -- extensions/user-boundary.test.ts extensions/index.test.ts
```

Two further fresh agterm/Pi 1.4 sessions confirmed:

| Delivery | Physical trace |
| --- | --- |
| Steering | base/medium, cheap/high |
| Queued follow-up | base/medium, base/medium, cheap/high |

Before release of the waiting tool, each session had one consumed user message and no activated mode override.
After consumption, each had two user messages and a saved cost override.
The follow-up's intervening base request confirms that queueing alone did not activate the setting.
The fixture used no network. Both additional terminal sessions were closed.

## Cleanup and limits

All eight agterm sessions created for these checks were closed. No test session remained in the terminal tree.
Pre-existing sessions and user configuration files were untouched.
The package was not installed globally, tagged or published.

Local fixtures do not establish provider entitlement or HTTP behavior.
The real comparison validates the exercised OpenAI integration, not every account or backend.
The earlier [activity acceptance](activity-presets-acceptance.md) records live generation on all five preset model IDs.
