# Built-in activity preset acceptance

Date: 2026-10-25. Environment: Pi 1.4.0, agterm 0.36.0, Node.js 24.15.0.

## Scope

Checked the complete OpenAI and Anthropic presets, configuration/tuning examples,
provider identity, native Routes editing and actual generation through named subscription providers.
Existing operator sessions and user configuration files were not changed.
New agterm sessions loaded the worktree extension explicitly, rather than the installed npm release.
Project tuning used temporary directories. No credentials were copied or printed.

## Automated checks

- `npm run check`: Biome and strict TypeScript passed.
- `npm run test:coverage`: 858 tests passed across 30 files. Coverage thresholds passed.
- `npm run check:unused`: passed.
- `npm run pack:dry`: passed. Production preset module included. Tests and fixtures excluded.

The suite checks all 56 requested pairs and their effective model/effort plans.
It covers provider separation, target aliases, legacy recognition, partial profiles,
sparse user/project merging, null suppression, opt-out and explicit-cell inheritance.
It also checks missing targets, declared fallback identity/order, image/context filtering,
pins, effort overrides, budgets, modes and escalation.
Existing tests retain cancellation, stale-review fencing and fallback-stream guarantees.

Five native Pi subprocess cases exercise the actual extension/provider path using local boundary fixtures.
They cover both preset families, an explicit effort change, null suppression and preset opt-out.
They use a registered deterministic classifier and generation provider. They make no network calls.
Documentation tests load the JSON examples from the published Markdown and check their actual configuration behavior.
Both the preset reference and broader mode decision table are generated and snapshot-checked.

## Live model-backed agterm checks

Fresh native Pi sessions used Jev `typesafe/jev-1.14.0` through Pi's classifier registry.
No classifier or generation transport was mocked in these sessions.
The task was a short JavaScript failure diagnosis, with no repository access.

| Setup | Observed generation route |
| --- | --- |
| Existing OpenAI profile, no explicit activity cells | `gpt-6-luna · debug · low · effort high` |
| Existing Claude profile, no explicit activity cells | `claude-sonnet-5-5 · debug · low · effort high` |
| OpenAI project override: `debug.low.thinking: "low"`, then `/router reload` | `gpt-6-luna · debug · low · effort low` |
| OpenAI project override: `debug.low: null`, then `/router reload` | `gpt-6-luna · debug · low · effort medium`, using generic low |
| OpenAI profile restricted to generic medium, activity-only advice | `gpt-6.1-sol · debug · medium · effort high` |
| Same OpenAI session: run `printf ROUTER_OPS_OK` | `gpt-6-luna · ops · medium · effort high`; command output and final reply observed |
| Claude profile restricted to generic medium, activity-only advice | `claude-opus-5-5 · debug · medium · effort medium` |
| Same Claude session: run `printf ROUTER_OPS_OK` | `claude-haiku-5-5 · ops · medium · effort high`; command output and final reply observed |

Both operations tasks exercised an actual cross-model transition and a same-route tool continuation.
All five preset model IDs generated successfully in these live checks.
New targets retained the selected named provider ID. No work/personal scope switch occurred.
These small tasks verify integration and access for the exercised targets, not comparative quality or savings.

## Native Routes workflow

A separate fresh agterm session used the checked-in local provider fixture, with no network.
Its full OpenAI profile had no advisor or explicit activity cells.

Observed steps:

1. Startup displayed `gpt-6.1-sol · base · medium · effort medium · last`.
2. The second line displayed `Local eligible baseline · auto · balanced (default)`.
3. `/router routes` showed 28 built-in cells, marked `B`.
4. **Edit cell → code/high → Reset to generic** showed `inherited · draft`.
5. Actual generation remained unchanged while browsing and drafting.
6. **Apply routes** showed `inherited · queued` and the next-user-boundary target.
7. A new user message activated the reset. Only `code/high` became `I`, leaving 27 built-in cells.
8. `/router reload` restored all 28 built-in cells.

This workflow exposed a built-in reset guard that still accepted only explicit overrides.
A regression test reproduced it for identical and different physical pairs.
The fix and the full native workflow passed afterward.

## Limits

This is not a benchmark or an account-entitlement guarantee.
Not every cell was exercised against a real backend. All 56 cells were checked automatically.
Offline fixtures do not validate provider authentication or network behavior.
Real checks used named personal subscription providers, not every possible provider or work account.
No release was published and no installed router package was replaced.
