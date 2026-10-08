# Pi 1.1.0 classifier advisor acceptance

Date: 2026-10-08

## Automated checks

- Pi AI, coding-agent, agent-core, and TUI development dependencies resolve to 1.1.0.
- TypeScript and Biome checks pass with npm run check.
- The full Vitest suite passes: 17 files, 474 tests.
- Pi host integration runs against the locked Pi 1.1.0 dependencies.

## Interactive agterm smoke

Started Pi 1.1.0 in an agterm session with the updated extension and a temporary isolated Pi agent directory. Loaded only the router and the deterministic local fixture provider. No API keys or external inference were used.

The fixture registered a custom classifier model with API ID fixture-classifier, approved only that exact model for profile smoke, and routed a synthetic user prompt. Pi showed:

- Selected tier: medium
- Classifier source: router-fixture-classifiers/demo/route
- Status: advice accepted
- /router log: one accepted classifier choice, confidence 100%, route probability 100%, with the selected classifier identity and bounded-context metrics.

Generation completed through the fixture model. Pi reported local fixture output stating that no external inference was used.

This validates the real Pi extension load, the typed registry/classifier call, explicit profile approval, candidate selection, generation delegation, and UI diagnostics. It does not measure classifier quality, production-provider latency, or live billing.
