# pi-model-router

[![CI](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![npm downloads](https://img.shields.io/npm/dm/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![Latest release](https://img.shields.io/github/v/release/alexei-led/pi-model-router?display_name=tag&sort=semver)](https://github.com/alexei-led/pi-model-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)

Per-turn model router for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Selects high, medium, low or micro-tier models using optional semantic advice, a configured baseline and a soft budget policy, while keeping the selected `router/<profile>` model stable.

> **Independent fork:** This project is an independently maintained fork of [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router), originally created by Ye Liu. It is not an official upstream release. The original MIT license and copyright notice are preserved.

## Fork status

This fork is maintained at [alexei-led/pi-model-router](https://github.com/alexei-led/pi-model-router). It publishes independent releases as `@alexeiled/pi-model-router` and accepts fixes for current Pi versions and provider integrations. See [CHANGELOG.md](CHANGELOG.md) for fork-specific changes.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Four Configured Tiers**: `high`, `medium`, `low`, and `micro` describe model/effort choices, not tool permissions or security levels.
- **Deterministic Baseline**: Without advice, select an eligible configured baseline regardless of prompt words, language, punctuation or length. No keyword routing or phase inference.
- **Advanced Controls**:
  - **Jev Advisor**: Optionally select a validated primary model/thinking pair within the active profile using bounded recent conversation text.
  - **LLM Intent Classifier**: Optional Pi-based semantic tier advice when Jev is not active. Jev failure goes directly to baseline, never to a second advisor.
  - **Cost Budgeting**: Prefer eligible medium-or-lower tiers above a soft generation-cost threshold; explicit pins take precedence.
  - **Fallback Chains**: Retry only explicit configured alternatives, before visible content.
- **Stable Tool Continuations**: Reuse a validated per-turn route without asking advisors again. Reuse is scoped to the caller's Pi session.
- **Cache Diagnostics**: Observe generation/cache tokens and compare hypothetical stay/switch costs without changing routing.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile. Overrides that leave no eligible route are rejected atomically (including Pi's selection); otherwise unsupported tiers are skipped.
- **Persistent State**: Pins, costs, and debug history are remembered across agent restarts and conversation branches. When Pi starts on the router provider, new sessions use the last selected router profile if it is still configured. An explicit `--model` selection takes precedence.

## Installation

### Requirements

- Pi `0.86.0` or newer.
- Node.js `22.19.0` or newer.

Install from npm:

```bash
pi install npm:@alexeiled/pi-model-router
```

### Migrating from the upstream package

Do not load both packages at the same time: both register the `router` provider. Replace the upstream package with this package and keep your existing `model-router.json` configuration:

```bash
pi remove npm:@yeliu84/pi-model-router
pi install npm:@alexeiled/pi-model-router
```

If the upstream package was installed through another manifest, remove that entry there instead. Existing profiles and router commands remain supported. Legacy `rules` and `phaseBias` still load but have no routing effect; see the migration notes below.

### For development

Use Node.js 22.19+ and npm. Install and validate with:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome lint, formatting, import-order and async-safety checks, then
TypeScript 7 with strict indexing, optional-property and unused-code checks. Warnings fail
the check. CI and releases use the same gate.

- `npm run format` formats TypeScript and root JSON files.
- `npm run lint` checks lint rules; `npm run lint:fix` applies safe lint fixes.
- `npx biome check --write .` also fixes formatting and import order.
- `npm run tsc` runs only the type checker.
- `npm test` uses Vitest worker threads; this keeps the small suite fast without weakening assertions.

[Biome](https://biomejs.dev/) replaces Prettier and supplies linting in one pinned
direct tooling dependency, without ESLint or formatter plugins. Type checking stays with
TypeScript 7. Markdown and YAML are not formatted by this setup; validate
workflow YAML with `actionlint .github/workflows/*.yml`. The generated lockfile
is excluded from formatting.

Install from source:

```bash
pi install .
```

Or load directly for one run:

```bash
pi -e ./extensions/index.ts
```

## Reliability

- Generation and classification use Pi's provider registry, including native/custom providers and credential-specific URLs. Only the optional Jev advisor uses separate HTTPS transport.
- Fallbacks run only before content is emitted; cancellation does not retry. Every target must support the requested input and exact thinking level; explicit unsupported effort is not silently reduced. Omitted thinking defaults to `off` for non-reasoning targets, including fallbacks.
- Jev has one total advisory budget (`jev.timeoutMs`, 1500 ms by default) that includes its single transient retry. The classifier-only compatibility path has its own budget (`classifierModel.timeoutMs`, 10 s by default) and never retries. Failure or uncertainty means the eligible baseline; caller cancellation stops generation.
- Valid same-turn tool continuations reuse the actual prior route before either advisor. Pins, budget policy and a single eligible primary candidate also bypass advisors. Invalid continuations choose a compatible local route without advice; incompatible Google thought-signature replay fails plainly.
- Pi owns tool execution permissions and per-request authentication. The router checks configured provider/profile identity, not which backend login is currently behind a provider. No private authentication storage is read.
- Context trimming preserves system instructions and whole active tool turns. It is a text estimate, not a guarantee that images or a large active turn fit.

See [docs/architecture.md](docs/architecture.md) and [docs/releasing.md](docs/releasing.md).

## Configuration

Copy the example config to one of:

- `~/.pi/agent/model-router.json` (Global)
- `.pi/model-router.json` (Project-specific)

The example's model IDs and thinking levels are illustrative: verify them against
your Pi registry and account. Remove the top-level and per-profile `jev` sections
when copying to project config; they are user-only and otherwise produce a warning.

The extension stores the last selected profile in `~/.pi/agent/model-router-state.json`. It restores this preference only when Pi starts on the router provider without an explicit `--model` selection. Branch-specific state remains in Pi session entries and takes precedence when a session is resumed.

### Basic Config Shape

```json
{
  "classifierModel": "google/gemini-flash-latest",
  "maxSessionBudget": 1.0,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "off" },
      "micro": { "model": "openai/gpt-5.4-nano", "thinking": "off" }
    }
  }
}
```

### Configuration Fields

| Field                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `classifierModel`       | (Optional) Pi model used for four-tier semantic advice only when Jev is not active (disabled, not opted in or missing a key). A string, or `{ "model", "thinking", "timeoutMs" }` (`timeoutMs` defaults to 10000). Supports model aliases. Failure means baseline. |
| `jev`                   | (Optional, user config only) External advisor settings; requires global enablement, a key and an explicit `profiles.<name>.jev.enabled` opt-in. Disabled by default. Reference: [docs/jev-advisor.md](docs/jev-advisor.md). |
| `ui.statusLine`        | `compact` (default) or `detailed`. Display only; project config may override it. Widget/debug always include full diagnostics. |
| `maxSessionBudget`      | (Optional) Soft generation-cost threshold in USD. Unpinned requests prefer eligible medium-or-lower tiers and skip advisors. Not a spending cap; classifier and Jev costs are excluded. |
| `phaseBias`, `rules`    | Deprecated and ignored, with a fixed value-free warning. Remove these fields; there is no legacy keyword mode. |
| `profiles.<name>.baselineTier` | (Optional) Preferred configured tier; otherwise use `medium`, `high`, `low`, `micro` in that order, filtered by availability/input/effort. |
| `models`                | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`. |
| `profiles`              | Map of profile definitions, each containing optional `high`, `medium`, `low`, and `micro` tiers (at least one required). Tier models can reference aliases from `models`. |

### Baselines, pins and migration

The tier order is `micro < low < medium < high`; there is no automatic price
ranking or prompt-derived minimum tier. `micro` defaults to `off` thinking;
explicit thinking overrides still apply. Both semantic advisors may select all
four tiers. Partial profiles, including low-only profiles, work for any text when
the configured route supports the request's inputs and effort.

Set `profiles.<name>.baselineTier` to a configured tier to prefer it. Without that
setting, the order is `medium`, `high`, `low`, `micro`. At request time, filter by
live availability, input support and exact effort first, then prefer the baseline
and that same fixed order. Missing default `medium` is fine; no eligible route
produces an actionable configuration/capability error.

A manual pin skips advice and selects only its configured tier (including its
explicit eligible fallbacks). Words never raise or lower a pin; an ineligible pin
fails plainly. Above `maxSessionBudget`, unpinned requests skip advisors and use
the baseline preference within eligible medium-or-lower tiers if any. Otherwise
they keep an eligible configured baseline and report `budget`. This is not a hard
billing limit; advisor costs are not included.

Remove old `rules` and `phaseBias` settings: they remain loadable but are ignored
with a value-free deprecation warning. Use an explicit pin, a configured baseline
or semantic advice instead. Saved pins/cost/settings remain readable; obsolete
routing reasons become non-rendered `legacy` metadata. No keyword safety guarantee
remains, and model tier never grants or restricts tool permissions.

### Optional Jev advisor: user config only

Jev is TypeSafe's System One model. When enabled, the router asks it once per
new user turn to pick one of the active profile's eligible tier/model/thinking
pairs from bounded recent conversation text. It cannot choose another profile,
an unconfigured model or thinking level, or grant tool permissions.

Enable it only in the user config, with a global `jev.enabled`, an API key and an
explicit per-profile opt-in. Project-level `jev` settings are ignored with a
warning. Enabling a profile is approval to send its bounded conversation text,
including tool output, to TypeSafe; the router does not redact it.

```json
{
  "jev": { "enabled": true, "apiKey": "<rendered by chezmoi/1Password>" },
  "profiles": { "personal": { "jev": { "enabled": true } } }
}
```

Everything else has defaults: `jev-1.13.0`, a 1500 ms total budget with one
transient retry, a 0.65 confidence threshold, a 0.8 probability threshold and a
3000-token context budget of the current request, two prior turns and the last
native-error tool result. A Choice below the confidence threshold is resolved
from its full probability distribution rather than discarded; an `uncertain`
answer, a timeout or an error uses the local baseline directly. See
[docs/jev-advisor.md](docs/jev-advisor.md) for the full configuration reference,
context tuning, the acceptance policy, footer/widget diagnostics and
troubleshooting.

### Routing diagnostics

The footer shows profile, tier, model/thinking and the advisor outcome, for
example `🧭 Jev → high c91% · 807ms`. `ui.statusLine: "detailed"` adds the
top option's probability and the request start time. When a configured
advisor is not asked, the footer says why: `advice skipped: pinned high`,
`over budget`, `only high eligible`, `tool turn`. `/router` and
`/router widget` show full metrics; `/router log on` keeps the last 50
decisions in branch-safe session state and `/router log` summarizes them.
Advisor field meanings, outcome codes and fixes are in
[docs/jev-advisor.md](docs/jev-advisor.md#diagnostics).

After generation, status/widget/log also show the last terminal attempt's input,
output, cache-read and cache-write tokens, model transition and attempt count.
Reported cost sums observed terminal attempts, including errors before fallback.
An attempt without terminal usage leaves that request's aggregate cost unknown;
the session total still includes its known charges. Detailed footer mode adds cache
counters; compact mode stays unchanged.

On a model change, `shadow same-token all-read/all-new` compares current registry
prices for the previous and selected models using the completed response's token
counts, including output. These are hypothetical cache extremes, **not predicted
savings**: the previous model could produce different tokens or quality. Unknown
or zero placeholder tariffs, missing previous models and router-truncated contexts
suppress the comparison. Prices are catalog/list-price estimates, not subscription
charges or a billing guarantee. A zero reported cost with placeholder tariffs is
shown as unknown.

Future cache warmth remains unknown. Same-model effort changes are not assumed
cache-preserving; branch restore does not restore a server cache. No extra requests,
cache-warming calls, price-based holds or advisor-threshold changes are added.
See [generation economics](docs/architecture.md#generation-economics) for the formulas.

## Commands

One verb per concern. A verb without an argument shows the state it controls.

| Command | Description |
| --- | --- |
| `/router` | Status: profile, pin, thinking override, cost, Jev settings, last decision. |
| `/router <profile>` | Switch profile and enable the router. Same as `/model router/<profile>`. |
| `/router off` | Leave the router and restore the previous non-router model. |
| `/router pin <tier\|auto>` | Pin the active profile to `high`, `medium`, `low` or `micro`; `auto` clears. |
| `/router thinking <level\|auto>` | Override thinking for every tier; `auto` clears. Pi's own thinking selector applies the same override. Per-tier levels belong in the profile config. An override that leaves no eligible route is rejected. |
| `/router log [on\|off\|clear]` | Recent decisions and Jev statistics for the retained window; `on`/`off` control collection (last 50, saved in session state), `clear` forgets them. |
| `/router widget` | Toggle the status widget. |
| `/router reload` | Reload `model-router.json`. |
| `/router help` | Usage. |

Removed verbs (`status`, `profile`, `fix`, `disable`, `debug`, `?`, per-tier
`thinking`) answer with their replacement and do nothing.

## Documentation

- [docs/README.md](docs/README.md): index of all project documents.
- [docs/architecture.md](docs/architecture.md): routing flow, module boundaries, state and persistence.
- [docs/jev-advisor.md](docs/jev-advisor.md): Jev configuration, context tuning, acceptance policy, diagnostics and troubleshooting.
- [docs/releasing.md](docs/releasing.md): release procedure.
- [docs/research/](docs/research/): experiments behind the current defaults.
- [model-router.example.json](model-router.example.json): sample profiles.
