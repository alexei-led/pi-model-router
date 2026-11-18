# Testing the router

## Choose the smallest relevant gate

| Command | Scope |
| --- | --- |
| `npm test` | All Vitest tests, including native Pi integration |
| `npm run test:unit` | In-process behavior tests without native CLI/SDK integration |
| `npm run test:host` | Native Pi CLI and SDK integration |
| `npm test -- extensions/state.test.ts` | One test file |
| `npm run test:coverage` | All Vitest tests with unchanged aggregate/per-file coverage gates |
| `PI_TEST_BINARY="$(command -v pi)" npm run test:classifier-catalog` | Optional installed-host classifier smoke check |

The default and coverage commands run both tiers. The focused commands do not
replace release checks. See the [release guide](release-guide.md) for all gates.
Tests are discovered only under `extensions/**/*.test.ts`. Worker concurrency is
capped at two (or the available CPU count if lower) because each isolated worker
loads Pi SDK/catalog modules. File isolation and timeout limits remain unchanged.

## Keep fixtures local and isolated

- `extensions/test/fixtures.ts`: model/message builders and stream consumption.
- `extensions/test/provider-harness.ts`: a fresh provider registry, controls,
  delegation spies and classifier responses per test.
- `extensions/test/temp-directory.ts`: a unique directory removed with the
  current test's cleanup, including failed assertions.
- `extensions/test/host-fixture.ts`: a unique offline Pi home, router config and
  subprocess environment. It never inherits the developer's credentials.

Keep routing, activity/advisor and lifecycle cases in their corresponding test
files and group related behavior with `describe`. Share setup, not mutable
registries, sessions or advice caches. Dispose SDK sessions before removing
homes or restoring environment variables. Avoid broad global reset hooks when
only a local fixture changed.

Native command-view checks batch read-only commands in one process per
print/JSON/RPC transport. They still validate every view and reject accidental
inference. Generation, tuning and recovery cases retain isolated subprocesses.
Provider fixture replies identify the physical delegated model rather than
always claiming the primary model succeeded.

## Diagnose slow or flaky tests

```sh
npm test -- --reporter=json --outputFile=/tmp/router-tests.json
```

Compare the same command, dependency versions and machine load before and after
changes. The JSON report includes per-test durations. Native subprocess startup
is intentionally separate from in-process tests. Do not disable file isolation,
coverage floors or failure assertions to obtain a better timing number.
Use controlled promises or bounded condition waits for async boundaries rather
than arbitrary sleeps. Add failure and boundary cases before deleting overlapping
tests; two scenarios with different fallback positions are not duplicates.
