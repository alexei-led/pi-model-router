# pi-model-router

[![CI](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![npm downloads](https://img.shields.io/npm/dm/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![Latest release](https://img.shields.io/github/v/release/alexei-led/pi-model-router?display_name=tag&sort=semver)](https://github.com/alexei-led/pi-model-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)

Per-turn model router for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Selects high, medium, low or micro-tier models using task intent, a soft budget policy and custom rules, while keeping the selected `router/<profile>` model stable.

> **Independent fork:** This project is an independently maintained fork of [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router), originally created by Ye Liu. It is not an official upstream release. The original MIT license and copyright notice are preserved.

## Fork status

This fork is maintained at [alexei-led/pi-model-router](https://github.com/alexei-led/pi-model-router). It publishes independent releases as `@alexeiled/pi-model-router` and accepts fixes for current Pi versions and provider integrations. See [CHANGELOG.md](CHANGELOG.md) for fork-specific changes.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Per-Turn Routing**: Intelligently chooses between `high`, `medium`, `low`, and `micro` tiers for every turn based on task intent and complexity.
- **Task-Aware Heuristics**: Detects planning vs. implementation vs. lightweight tasks using keyword analysis, word count, and conversation history.
- **Advanced Controls**: Includes built-in support for:
  - **Jev Advisor**: Optionally choose a validated model/thinking pair within the active profile, subject to local safety and capabilities.
  - **LLM Intent Classifier**: Optionally use a fast Pi model for tier advice when Jev is disabled or unavailable; local safety still wins.
  - **Custom Rules**: Define keyword-based tier overrides for specific patterns (e.g., `deploy` → `high`).
  - **Cost Budgeting**: Set a session spend limit; high tier downgrades to medium once exceeded, unless the local safety floor forbids it.
  - **Fallback Chains**: Automatic retry with alternative models if the primary choice fails.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation work.
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

If the upstream package was installed through another manifest, remove that entry there instead. The configuration file and router commands remain compatible for this release.

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
- Jev and classifier share one 1500 ms routing deadline. Jev gets at most 750 ms (or its shorter configured timeout); the classifier gets only the remainder and a 256-token output limit. Advisor failures retain local routing, not a failed generation.
- Valid same-turn tool continuations reuse the actual prior route before either advisor. Pins, rules, budget gates and deterministic mechanical tasks also skip advisors.
- Context trimming preserves system instructions and whole active tool turns. It is a text estimate, not a guarantee that images or a large active turn fit.

See [architecture](https://github.com/alexei-led/pi-model-router/blob/main/docs/ARCHITECTURE.md) and [release procedure](https://github.com/alexei-led/pi-model-router/blob/main/docs/RELEASING.md).

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
| `classifierModel`       | (Optional) Pi model used for tier advice if Jev supplies no valid choice. Supports model aliases. If neither advisor supplies advice, local heuristics are used. |
| `jev`                   | (Optional, user config only) External advisor settings; requires global enablement, a key and an explicit `profiles.<name>.jev.enabled` opt-in. Disabled by default. |
| `maxSessionBudget`      | (Optional) Soft generation-cost threshold in USD. Downgrades high to medium, or low if medium is absent, subject to the local safety floor. Not a spending cap; classifier and Jev costs are excluded. |
| `phaseBias`             | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`. |
| `rules`                 | List of custom keyword rules (e.g. `{ "matches": "deploy", "tier": "high" }`).    |
| `models`                | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`. |
| `profiles`              | Map of profile definitions, each containing optional `high`, `medium`, `low`, and `micro` tiers (at least one required). Tier models can reference aliases from `models`. |

### Optional mechanical tier

The order is `micro < low < medium < high`. Existing three-tier configs and saved
sessions need no migration. Add `"micro": { "model": "nano", "thinking": "off" }`
to a profile to use your configured cheapest model for exact mechanical requests
such as `git status --short`, `git diff --stat`, `head -n 20 README.md`, or
`Replace the exact comment "// teh value" with "// the value" in src/index.ts`.
`micro` defaults to `off`, not the normal config default of `medium`; explicit
thinking overrides still apply. There is no automatic model-price ranking.

Mechanical detection is a narrow allowlist, not a shell parser. Chaining,
substitution, arbitrary commands and ambiguous edits do not qualify. Classifier
advice remains limited to `low`, `medium`, and `high`; deterministic mechanical
requests skip the classifier. Images require image-capable models at every
attempt and may promote a micro request to a higher tier.

Local safety wins over pins, rules and the soft budget: ambiguous requests require
at least `low`, ordinary edits/debugging `medium`, and design, security,
destructive operations, migrations and concurrency `high`. Missing tiers resolve
to a configured tier at or above that floor. **A partial profile with no eligible
tier now fails before generation** rather than silently lowering safety. Budget
conflicts retain the eligible route and report `budget-floor-conflict`.
Referential implementation follow-ups (such as “go ahead” or “continue”) inherit
the preceding task's safety floor. Safety-raised pins report `pin-safety-floor`.
Partial profiles warn at config load when medium or high floors cannot be met;
generation errors identify the profile and tier to configure.

### Optional Jev advisor: user config only

Jev makes one bounded TypeSafe System One Choice request per eligible new user
turn, without retries. It chooses only among the active profile's available
primary tier/model/thinking pairs at or above the local safety floor. Fallback
models are not extra Jev choices. Pins, custom rules, budget gates, deterministic
micro tasks and tool continuations skip Jev and the classifier.

Missing keys, malformed responses, `uncertain`, low confidence, timeout and HTTP
errors fall through to the configured Pi classifier within the same deadline,
then local heuristics. Jev cannot select another profile or an arbitrary model,
provider account or thinking level. Explicit generation fallback chains may
still cross providers, as configured by you.

Configure Jev **only** in `~/.pi/agent/model-router.json` (or the agent directory
selected by Pi). Both global enablement and an explicit user-level profile opt-in
are required. Work profiles remain disabled unless you explicitly approve sending
their task summaries externally. All project-level `jev` settings, including
profile opt-ins, are ignored with a warning, before merging user credentials.

```json
{
  "jev": {
    "enabled": true,
    "apiKey": "<rendered by chezmoi/1Password>",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-1.13.0",
    "timeoutMs": 750,
    "confidenceThreshold": 0.65,
    "maxStateChars": 12000,
    "mode": "advisory"
  },
  "profiles": {
    "personal": {
      "jev": { "enabled": true },
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "off" },
      "micro": { "model": "openai/gpt-5.4-nano", "thinking": "off" }
    }
  }
}
```

The endpoint, model, timeout, confidence threshold, state limit and mode shown
above are defaults. Only HTTPS endpoints without embedded credentials, query
parameters or fragments are accepted. Timeout must be positive and at most
1500 ms, confidence must be 0–1, and the task-summary limit must be 1–12000
characters. Provider routing further caps Jev at 750 ms within the fixed 1500 ms
shared advisor deadline; increasing `timeoutMs` does not extend those caps.
Values above 750 ms are normalized to 750 ms with a configuration warning.
The 1500 ms deadline also applies when only the Pi classifier is enabled.

**External data:** Jev receives the latest user text, truncated to `maxStateChars`
and marked untrusted, plus candidate tier/model/thinking identifiers. This is not
a redaction or summarization service: the bounded text may still contain private
data. It does not send the full transcript, tool output, system prompt or config.
Approve external-data handling before enabling a profile, especially work. Local
keyword safety checks are conservative routing heuristics, not a security sandbox.

Router state and debug history retain only allowlisted local decision metadata:
source, tier, model, thinking, phase, timing and fixed error classes
(`advisor-unavailable` or `deadline`). They never retain the Jev key, endpoint,
request text, raw response or remote explanations. Older saved explanations are
discarded as non-rendered `legacy` metadata; Pi's own conversation transcript is
separate from router state.

For chezmoi, use a **private template**, for example
`private_model-router.json.tmpl` under your agent-directory source path. Render
only the `apiKey` value using a reference such as
`{{ onepasswordRead "op://Personal/TypeSafe/apiKey" | toJson }}` (unquoted in the
JSON template). Adapt the vault/item reference locally. Keep the rendered file
out of Git and restrict permissions to `0600` (`chmod 600` on Unix); verify the
mode without printing the file. Never commit rendered credentials or 1Password
output. No environment variable is required, and the extension never executes a
secret-lookup command. The repository example contains only a placeholder and
keeps Jev disabled.

## Commands

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/router`                   | Show detailed status, current profile, spend, and settings.                     |
| `/router status`            | Alias for `/router` (show current status).                                      |
| `/router profile [name]`    | Switch to a profile or list available ones (enables router if off).             |
| `/router pin <t\|a>`        | Pin a tier (high/medium/low/micro/auto) for the active profile.                      |
| `/router fix <tier>`        | Correct the _last_ decision and pin that tier for the current profile.          |
| `/router thinking <level>`  | Override thinking level for all tiers (e.g. `/router thinking max`). Unsupported tiers are skipped; an override that leaves no eligible route is rejected without changing any tier. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`). |
| `/router disable`           | Disable the router and switch back to the last non-router model.                |
| `/router widget <on\|off>`  | Toggle the persistent state widget (supports `toggle`).                         |
| `/router debug <on\|off>`   | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`). |
| `/router reload`            | Hot-reload the configuration JSON.                                              |
| `/router help`              | Show usage help for all subcommands.                                            |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
