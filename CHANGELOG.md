# Changelog

## 0.5.0 (unreleased)

This is the first release of the independently maintained `@alexeiled/pi-model-router` fork.

- Require Pi `0.86.0` or newer and test against the synchronized Pi 0.86.0 packages.
- Upgrade development tooling to TypeScript 7 and Vitest 5.
- Replace Prettier with pinned Biome 2.5.14 for lint, formatting, and import-order checks. Enforce the same read-only checks in CI, releases, and before publishing.
- Preserve the last selected router profile across new Pi sessions.
- Dispatch registered custom-provider streams when Pi exposes a provider-specific stream.
- Accept headers-only authentication used by providers such as Kimi Code OAuth.
- Apply credential-specific provider base URLs when Pi exposes them.
- Keep classifier requests isolated from the main conversation system prompt and tools.
- Ignore the startup thinking-level event emitted by newer Pi versions instead of turning it into a router-wide override.
- Keep the original MIT license and upstream attribution.
