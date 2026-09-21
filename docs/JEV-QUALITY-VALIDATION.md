# Quality-first routing validation — 0.6.4

Date: 2026-09-21. Local extension in a real Pi/agterm session, not mocked generation.
The earlier input comparison is in [JEV-VALIDATION.md](JEV-VALIDATION.md).

## Setup

- One local router, `pi-sub-aliases` and provider-compat; no duplicate installed router.
- `jev-latest`, 5000 ms deadline, unchanged 0.65 confidence threshold.
- Existing `openai-personal` profile: high = Astra/high; lower tiers = Luna with
  their configured thinking levels. Operator-approved `baselineTier: high`.
- Read-only tools (`read`, `grep`, `find`, `ls`) in the `pi-plan-exec` checkout.
- 24 sequential prompts in one session. Prompts and acceptable tier ranges were
  written before the run in
  [`jev-quality-tasks.json`](../extensions/test/fixtures/jev-quality-tasks.json).
- Actual model/provider and completion were checked from assistant-message metadata;
  Jev outcomes and request identities came from persisted router state. Footer text
  was captured from agterm. Each task had exactly one distinct Jev request ID.

The operator's high baseline is configuration, not a new default for other users.
The extension does not rewrite user profiles. No confidence threshold, privacy
opt-in, request size or timeout was changed to make the evaluation pass.

## Results

All 24 completed. All actual routes matched the predefined acceptable ranges, and
all assistant model/provider identities matched the routed generation targets.

| Task | Tier | Jev outcome | Confidence | Jev ms |
| --- | --- | --- | ---: | ---: |
| Arithmetic | micro | selected | 100% | 784 |
| Fencing design | high | selected | 87% | 374 |
| Uppercase literal | micro | selected | 100% | 762 |
| Package lookup | micro | selected | 99% | 290 |
| Lookup follow-up | micro | selected | 100% | 726 |
| Local indexing bug | low | selected | 75% | 295 |
| Git/JSON crash recovery | high | selected | 92% | 699 |
| Sort numbers | micro | selected | 100% | 841 |
| README lookup | micro | selected | 95% | 352 |
| Storage design tradeoff | high | selected | 73% | 783 |
| Small trim helper | micro | selected | 99% | 757 |
| Completion idempotency | high | selected | 83% | 307 |
| Crash-recovery follow-up | high | selected | 65% | 741 |
| JSON formatting | micro | selected | 100% | 749 |
| Backoff/cancellation tests | high | low-confidence | 62% | 284 |
| Missing task referent | high | uncertain | 80% abstention | 748 |
| Repository cancellation analysis | high | low-confidence | 42% | 767 |
| Arithmetic after analysis | micro | selected | 100% | 721 |
| Routine ENOENT explanation | micro | selected | 87% | 340 |
| Cancellation linearization | high | selected | 80% | 743 |
| Cross-process follow-up | high | selected | 87% | 735 |
| Sort JSON strings | micro | selected | 100% | 744 |
| Configuration merge semantics | low | selected | 87% | 322 |
| Last-element helper | micro | selected | 84% | 707 |

- Astra: **10/24** generations; Luna: **14/24**.
- Accepted advice: **21/24**. Low confidence: **2/24**. Abstention: **1/24**.
- No observed transport timeouts/errors; deadline behavior is covered by unit tests.
- Median Jev latency: **731 ms**. No advisor retries.
- Package/README lookups used two assistant responses each; cancellation analysis
  used three. Each retained one request ID and a stable generation route throughout.
- Simple → complex → simple transitions occurred repeatedly. Frontier selection did
  not pin the conversation or prevent later micro routing.

The two low-confidence results both proposed high, but were correctly rejected at
0.65. The configured high baseline still selected Astra. For the missing referent,
Astra asked for clarification rather than inventing a task. This distinguishes
quality-first fallback from lowering the acceptance threshold.

## Answer checks and limits

Arithmetic, literal transformations, lookup follow-up, indexing fix and small helper
answers were inspected for their requested behavior. Design answers stated fencing,
atomicity/idempotency assumptions and adversarial interleavings. The repository
analysis distinguished observed code from uninspected guards; it was not treated as
proof of a bug in that project.

This is a small, coding-focused acceptance corpus, not a blinded answer-quality
benchmark against another model. Some tasks allow adjacent tiers. No medium route
was selected in this sample; medium eligibility and budget routing remain covered
by unit tests. Higher confidence alone is not considered better answer quality.

## UI, statistics and persistence checks

The captured live footer distinguished these cases without showing abstention
confidence as model confidence:

```text
Jev → high c87% · 374ms
Jev high c62% <65% → baseline · 284ms
Jev: no tier chosen → baseline · 748ms
```

`/router debug stats` was checked against independently deduplicated request IDs in
saved state. The live run exposed an old discrepancy: runtime retained 12 decisions
while docs described 50. The constant and collection behavior were corrected:

- Unit test drains 52 generations with debug on and verifies exactly 50 retained.
- After reloading the local extension, live history grew from 12 to 13 decisions,
  representing 11 distinct requests. The same counts appeared in the command output.
- A new real prompt with debug off updated the latest route, but retained history
  stayed at 13/11 and excluded the new request ID.
- Clear/reset and empty statistics are checked through the actual command handler;
  save/restore sanitization includes request IDs.

Statistics explicitly describe the retained window, not lifetime totals. Shared
requests, cached routes and tool continuations cannot inflate the request count.
Recognized legacy entries without request IDs are excluded rather than guessed.
No raw prompt/response, endpoint, credential or remote explanation is added to traces.

## Gates

- Full Vitest suite, including high-baseline versus confident micro/low and budget.
- Biome, strict TypeScript and `git diff --check`.
- Package-content validation and secret scan before publication.
