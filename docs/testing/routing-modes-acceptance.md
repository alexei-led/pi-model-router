# Routing modes: actual-host acceptance

Date: 21 October 2026. Branch `feat/routing-modes`, before v0.16.0.
Pi CLI 1.3.0, agterm 0.36.0. Local fixture only: no network, no credentials.

**Result:** all fixture checks passed. Live-provider checks are not part of this report.

## Environment

- One new agterm session, started in the background. No other session was typed into.
- Isolated `HOME` and `PI_CODING_AGENT_DIR` in a scratch directory.
  The extension was installed from the worktree with `pi install --local`.
  Pi created its own `auth.json` in that directory; no credentials were copied.
- Launch, as in [Router UI acceptance](router-ui-agterm-acceptance.md#reproduce-the-fixture-setup),
  with `--tools fixture_echo,fixture_check,write`.
- User configuration: profile `auto` (no `mode`) and profile `thrifty`
  (`mode: cost`). Both use `router-fixture/{high,medium,low,micro}` and
  approve the fixture classifier `router-fixture-classifiers/demo/route`,
  which always selects `medium`.
- Fixture input prices per million tokens: micro 0.1, low 0.5, medium 2, high 4.
  The fixture reports usage cost from the routed model's price.

## Results

| Check | Steps | Observed |
| --- | --- | --- |
| Each mode | `/router mode cost\|balanced\|quality`, one prompt each | balanced `medium/medium`; cost `low/low`, `model lever from low`; quality `medium/high`, `effort lever from medium` |
| Change during a request | `/router-demo slow`, prompt under quality, `/router mode cost` while it runs | The running request kept `medium/high`. The next request used `low/low`. |
| Precedence | `/router mode default`; `/router profile thrifty`; project file `{"mode": "quality"}` and `/reload`; `/router mode cost` | `cost (profile)`, then `quality (project)`, then `cost (session)` |
| Project allowlist | Project file also sets `switchPolicy` | Warning: `Ignored project router settings: a project file may set only routes, display and mode.` No value is shown. |
| Resume and new | Quit, start with `-c`, then `/new` | Resume: `cost (session)`. `/new`: `quality (project)` |
| Pin | `/router pin medium` under cost, then `/router pin auto` | Pinned: `medium/medium`, widget `cost (session) · bypassed by pin`. Unpinned: `low/low` |
| Status | `/router status` | `Mode: quality (session) · activity routing: on (configuration)` |
| Log | `/router log` | Each record has `{mode <mode> (<source>)}`, the lever, the classifier `choice=medium`, and the route in use |
| Escalation | `/router-demo escalation` in balanced: check fails, `write` succeeds, check fails | The last request of that turn: `high`, `escalated from medium`. The next 2 user turns: `high`. The third: `medium` |

## Limits

- The mode change during a request used a single-request turn. A change
  inside a tool loop is covered by provider tests, not by this run.
- The fixture classifier always selects `medium`, so this run does not show
  tier changes from advice. The [decision matrix](../decision-matrix.md)
  covers every classifier answer.
- The Settings-tab screenshot is pending.

## Screenshots

Captured with `screencapture`, cropped to the terminal pane with `sips`.
Only fixture data is shown.

- [Cost mode, session source](../assets/router-ui/modes-widget-cost.png): the route strip shows
  `cost (session)` and the low model under `medium` advice.
