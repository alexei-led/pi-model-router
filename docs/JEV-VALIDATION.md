# Jev routing validation — 2026-09-21

## Findings

A live Pi session using the local router, `pi-sub-aliases`, `jev-latest`, a
5000 ms deadline and a 0.65 confidence threshold rejected a **high** choice with
probability **0.48** and confidence **0.35** after **764 ms**, HTTP 200. This was
not a timeout. The fallback was the configured medium/Luna/max baseline.

The old UI collapsed all rejection causes into the same baseline marker and
removed latency/error fields on tool continuations. It could not explain this
outcome. The old criteria mostly named tier/model/effort without explaining what
distinguished the tiers. The new criteria describe reasoning requirements and
explicitly classify the latest user request, not earlier tasks in the history.

Two independent provider regressions were reproduced before the fix:

- A repeated same-turn call reverted from high to baseline medium while retaining
  `advisor: jev`.
- Concurrent same-turn calls delegated to Luna and Astra respectively instead of
  both waiting for the single Jev result.

Both regression tests now pass. This does not prove that concurrency caused every
reported baseline selection: low confidence was the directly observed live cause.

## Controlled input comparison

24 live advisory calls: three tasks × four input/rubric variants × two repeats.
Tasks were a package lookup, fencing/cancellation design, and a contextual follow-up.
Each variant saw the same task context. No system prompts, tool arguments, thinking,
configuration credentials or raw private configuration were included. Generation
was not run in this comparison. Threshold and timeout were held constant.

| Variant | Accepted advice | Confidence range | Median latency |
| --- | --- | --- | --- |
| Existing flat context + old criteria | 2/6 | 28–83% | 276 ms |
| Same context + new criteria | 6/6 | 88–98% | 287 ms |
| Latest request only + new criteria | 6/6 | 91–97% | 278 ms |
| Separate current request/history + new criteria | 6/6 | 92–96% | 286 ms |

Old vs new criteria at the same input:

- Package lookup: 28–30% → 88–89%, correctly choosing micro with the new criteria.
- Fencing design: 40–42% → 93–94%, choosing high.
- Contextual follow-up: 83% → 97–98%, choosing high.

Decision: keep the existing bounded recent context. Improving the criteria was
sufficient; neither more context nor a new structured payload showed a consistent
advantage here. Latest-only input risks losing referents in follow-up requests.
No threshold reduction, extra advisor call, automatic retry, or local intent
heuristic was added. This is a small diagnostic sample, not a quality benchmark or
proof that higher confidence always means a better answer.

## Actual Pi/agterm validation

One local router instance, alias provider and provider-compat extension were loaded.
Initial attempts without aliases, or with both installed and local routers, were
excluded. All test tasks used read-only tools in the `pi-plan-exec` checkout.

In one session after reloading the corrected local extension:

| Task | Actual generation target | Jev confidence | Jev latency |
| --- | --- | --- | --- |
| Fencing design, same conceptual request previously rejected | gpt-6-astra / high | 91% | 807 ms |
| Arithmetic after the design task | gpt-5.6-luna / off | 100% | 717 ms |
| Package lookup with tool continuation | gpt-5.6-luna / off | 97% | 866 ms |

The model changes were checked against assistant-message metadata in the Pi session,
not only the footer. The logical model remained `router/openai-personal`. Tool
continuations retained the route and the original Jev metrics/start time without a
new advisory request. Reload restored those metrics from branch-safe router state.
The service reported that `jev-latest` resolved to `jev-1.13.0` in the final lookup.
A separate fresh session with an intentionally underspecified comparison request
returned `uncertain` (73% confidence, 860 ms), used baseline, and asked for
clarification. Thus the changes do not force confident routing for every input.

## UI and persistence

Full-width and approximately 86-column split-pane agterm displays were checked.
The original long canonical route clipped the Jev result in the split pane. The
compact default removes the repeated provider prefix and keeps tier, actual model,
effort, confidence and latency visible. Detailed mode retains the canonical route,
probability, threshold and original local request time; widget/debug show the rest.

Temporary UI configuration changes were restored. User Jev model, deadline,
threshold and privacy opt-ins were not changed. No tracked test-project files were
modified. Runtime single-flight tests also cover late waiters sharing a deadline,
one waiter cancelling without stopping another, and final-waiter cancellation
aborting the transport without starting generation.

Diagnostics are field-by-field sanitized into existing `router-state` entries.
`/router debug on` enables the bounded 50-decision history. These are local metrics,
not remote explanations or transcript copies. Confidence and selected probability
remain distinct. No new logging service or raw-response log is introduced.

## Sources and gates

- [Jev API reference](https://docs.typesafe.ai/api)
- [Choice semantics and criteria guidance](https://docs.typesafe.ai/primitives/choice)
- `npm run check` — Biome and TypeScript
- `npm test` — routing, transport, cancellation, config, UI and persistence tests
- `git diff --check`
