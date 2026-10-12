# pi-model-router

[![CI](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40alexeiled%2Fpi-model-router)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stop changing models by hand.**

Keep one profile in [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
`pi-model-router` can select a different model and reasoning effort as the task changes, including between tool-loop requests.
Optional advice uses any text-capable classifier registered in Pi. The router uses Pi’s typed classifier API and requires explicit per-profile approval for the exact model.

## Why use it?

- **Fewer manual changes.** One profile can combine fast, low-cost routes with stronger models.
- **Control over cost and quality.** You choose the models, effort levels, fallback order, and baseline. You can pin a route at any time.
- **Activity-specific routes.** Optional sparse code/debug/explore/plan/review/ops/docs overrides share one consent-gated classifier operation. [Configure activity routes](docs/user-guide.md#activity-routes).
- **Adaptive tool loops.** Periodic background reviews assess current work without delaying generation. Eligible recommendations can change tier, activity and effort between requests, with explicit switch-cost controls.
- **Visible decisions.** A compact Signal Panel shows actual activity, model and effort. Held proposals stay distinct. Open `/router` for native bars/sparklines, observed usage and session controls.

The aim is selective use of expensive models, not the cheapest answer at any cost.
Savings depend on your profiles, task mix, output size, and cache reuse.
Advisors add latency. Their fees are separate from generation costs.

## Optional routing advice

Choose any classifier model configured in Pi as the optional advisor.
It reads bounded recent context and advises a model and effort from your profile.
The selected generation model produces the answer, not the advisor.

```mermaid
flowchart LR
    Task["Your task"] --> Router["Pi model router"]
    Advisor["Configured Pi classifier"] -.-> Router
    Router --> Light["Micro / low"]
    Router --> Strong["Medium / high"]
    Light --> Answer["Answer and tool calls"]
    Strong --> Answer
    classDef policy fill:#dbeafe,stroke:#2563eb,color:#0f172a
    classDef advisor fill:#fef3c7,stroke:#b45309,color:#451a03
    classDef generation fill:#dcfce7,stroke:#15803d,color:#14532d
    class Router policy
    class Advisor advisor
    class Light,Strong generation
```

Configure classifier credentials in Pi and approve its exact `provider/model` reference per profile. Selected text can contain private data. The router sends text only. Without an advisor, it uses a compatible local route.
[Classifier setup and privacy →](docs/classifier-advisor.md)

## Inspect routing in Pi

Run **`/router`**. The Signal Panel has three sections: **Now**, **Usage** and **Settings**.
Open `/router usage` or `/router settings` directly; `/router status` returns short text.
The two-line strip is on in new sessions. `/router widget` switches to a quiet footer status instead.

![Native Pi router inspector with an above-editor route strip](docs/assets/router-ui/signal-now-dark.png)

Captured from the local dev extension in Pi inside agterm, using synthetic fixture data.
[Inspector controls](docs/user-guide.md#native-inspector) · [Classifier setup](docs/classifier-advisor.md) · [Adaptive routing acceptance and limits](docs/testing/adaptive-router-acceptance.md)

## A turn in Pi

This illustrative strip shows a low-tier choice after completion. It is not a routing promise or a latency benchmark.

```text
gpt-6-luna · low · effort off · last
Classifier advice accepted · 807 ms · auto (illustrative historical capture)
```

The model answers and calls tools. Periodic background reviews use bounded current-loop progress; a fresh recommendation may apply at the next request. Cost sensitivity and a short horizon can hold a costly switch, while strong capability advice can override the estimate. Pins, consent and generation safeguards still apply.
[Adaptive routing and switch policy →](docs/user-guide.md#activity-routes)
[Read the status and take control →](docs/user-guide.md#understand-the-result)

Recent records cover 1,967 Pi responses across 25 sessions. They show route use, not guaranteed savings.
[See the chart, cost calculations, and limits →](docs/evaluation.md)

## Upgrading to 0.14.0

Restart Pi after updating. No configuration migration is required.
For an enabled, approved classifier, background reviews default to every four requests.
Set `advisor.reviewEveryRequests: 0` to keep advice at new user-task boundaries only.
Reviews send bounded recent text and add advisor requests; existing consent requirements still apply.

### From versions before 0.12.0

After updating, restart Pi. Replace `/router-ui` with `/router`, and
`/router <profile>` with `/router profile <name>`. Classifier advice now uses any Pi-registered classifier. Replace provider-specific configuration with the generic advisor model and exact per-profile approvals.
[Classifier migration →](docs/user-guide.md#from-011x-to-012x)

Coming from 0.11.0? Replace Jev/Clef/chat-classifier settings with generic advisor settings and exact profile approvals. See the migration note in the user guide.

## Install

Requires Pi **1.1.0 or later in the 1.x series** and Node.js **22.19.0+**.
The test suite and host checks run against Pi 1.1.0; see the [classifier acceptance evidence](docs/testing/classifier-advisor-pi-1.1-acceptance.md).

```sh
pi install npm:@alexeiled/pi-model-router
```

Then start a new Pi session.
[Create a profile with your available models →](docs/user-guide.md#first-profile)

If you use the upstream package, remove it first. Both packages register the `router` provider.

---

Independent fork of [Ye Liu's pi-model-router](https://github.com/yeliu84/pi-model-router), with the original MIT license and attribution.
