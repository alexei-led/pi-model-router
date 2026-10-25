# Activity preset evidence, 2026-10-25

## Status and limits

The OpenAI and Anthropic matrices in [activity-presets.md](../activity-presets.md)
are **derived routing policy**. They are not official vendor routing tables.
They have not been validated as equal-quality replacements or measured savings.

The sources describe capabilities and prompting/effort controls, not a complete
activity × tier benchmark. Actual quality, latency and cost require workload evaluation.
Pi's live registry owns supported effort mapping and provider behavior.
No preset asserts cache sharing or changes prompts, API controls or tool permissions.

## Model-card sources

The reviewed knowledgebase is [alexei-led/model-cards](https://github.com/alexei-led/model-cards).
Each record's `model.yaml` is canonical. Its overview and prompting guide are generated.

| Record | Verified | Relevant evidence and source IDs |
| --- | --- | --- |
| [GPT-6.1 Sol](https://github.com/alexei-led/model-cards/tree/main/openai/gpt-6.1-sol) | 2026-09-30 | Official `model-guide`/`prompting` guidance: start medium for complex technical work. Consider xhigh for polished deliverables or conflicting evidence. Supported effort starts at low. |
| [GPT-6 Luna](https://github.com/alexei-led/model-cards/tree/main/openai/gpt-6-luna) | 2026-09-23 | Derived `model-guide`/`prompting` guidance: bounded, repeatable work with clear goals. Compare higher-effort Luna against Sol before moving up. |
| [GPT-6 Sol](https://github.com/alexei-led/model-cards/tree/main/openai/gpt-6-sol) | 2026-09-30 | Predecessor recognized for migration. New preset strong targets use GPT-6.1 Sol. No Astra record was found in the reviewed catalog. |
| [Claude Haiku 5.5](https://github.com/alexei-led/model-cards/tree/main/anthropic/claude-haiku-5-5) | 2026-10-08 | Official `prompting` guidance: medium for most work, low for simple latency-sensitive work, high for knowledge work or strict instructions. Extreme effort needs measured gains. |
| [Claude Sonnet 5.5](https://github.com/alexei-led/model-cards/tree/main/anthropic/claude-sonnet-5-5) | 2026-09-30 | Official `prompting`/`whats-new`: medium for well-specified coding and tool use, high for harder/longer work. Use Opus for the hardest long-horizon work. |
| [Claude Opus 5.5](https://github.com/alexei-led/model-cards/tree/main/anthropic/claude-opus-5-5) | 2026-09-23 | Official `prompting`: medium starting point and workload-specific effort sweep. Thinking cannot be disabled. |

Claude Haiku 4.5 is recognized only as a legacy profile anchor.
The preset assigns Haiku 5.5, not an assumed equivalent setting for 4.5.
Provider availability and account access still need verification.

## Derived policy rationale

- **Code:** bounded OpenAI work uses Luna at high effort. Medium uses Sol at its documented medium starting point. Claude low/medium uses Sonnet at high effort. High uses a stronger model or effort.
- **Debug, plan and review:** reserve more reasoning for ambiguous causes, design choices and conflicting evidence. Use Sol/high or Opus/medium at medium, with xhigh at high. This xhigh choice is a policy hypothesis, not a proven improvement over high.
- **Explore and ops:** use Luna/high or Haiku/high at medium for bounded investigation or execution. Keep a stronger high-tier route for difficult multistep tasks.
- **Docs:** use a smaller model for low-tier work and retain stronger medium/high routes for technical synthesis and deliverables.
- **Micro:** use low or medium effort for OpenAI and medium or high for Claude according to activity. Micro is a route choice, not a universal “thinking off” promise.

Some adjacent tier cells share a physical pair. Tiers remain independent classifier choices.
The engine bypasses advice when only one effective plan remains.

## Related router evidence

[Claude router](https://github.com/alexei-led/claude-router) supplies several default activity overrides.
Its policy informed the low-tier coding and medium-tier operations distinction.

The local `codex-router` implementation supplies only `debug/medium → gpt-6.1-sol/high`.
Its `internal/config/default.go` cites bounded live evaluations from October 15–16, 2026.
The retained reports under `docs/archive/evidence/2026-10-15-openai-defaults/` and
`2026-10-16-debug-activity/` support trialing Luna/high on bounded tasks and distinguishing debugging from planned coding.
These samples do not establish results for arbitrary repositories, providers or long-running tasks.

The classifier rubric adopts that distinction: an observed failure with an unknown cause is `debug`, even when a fix is requested.
This is semantic classifier guidance. No local keyword detector selects an activity or tier.

## Revisit criteria

Update the exact recognized IDs and matrices when model cards or Pi capabilities change.
Before claiming quality or savings, compare fixed workloads against a named fixed-model baseline.
Include tool-loop completion, failures, cache rebuilds and classifier overhead.
Do not infer cache compatibility from a family name or matching effort strings.
