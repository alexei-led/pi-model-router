# Sol 6.2 default refresh — 2026-11-18

## Decision

Use `gpt-6.2-sol` wherever the built-in OpenAI policy previously selected
`gpt-6.1-sol`. Retain `gpt-6.1-terra` and `gpt-6-luna` and the existing
activity, tier and effort policy. The reference generic ladder now uses Sol 6.2.

Existing Sol 6 and 6.1 profiles remain recognized. Their generic declarations
are user-owned and are not rewritten; their built-in activity cells receive
current defaults. Old generic ladders keep the legacy mode transform.
Provider identity, availability checks, effort mapping and fallback order
remain unchanged. No implicit generation fallback is introduced.

## Evidence and limits

The local model-card manifests and guides, verified 2026-11-18, identify Sol 6.2
as the balanced release and Astra 6.2 as the frontier release. The official
[Sol model page](https://developers.openai.com/api/docs/models/gpt-6.2-sol.md)
and [Astra model page](https://developers.openai.com/api/docs/models/gpt-6.2-astra.md)
list short-context Standard input/output prices of $2/$10 and $8/$40 per
million tokens, respectively. Long-context and processing-tier conditions apply.

The model cards link to Artificial Analysis rather than retaining scores:
[Sol](https://artificialanalysis.ai/models/gpt-6-2-sol),
[Astra](https://artificialanalysis.ai/models/gpt-6-2-astra),
[Terra](https://artificialanalysis.ai/models/gpt-6-1-terra) and
[Luna](https://artificialanalysis.ai/models/gpt-6-luna).
The pages were consulted on 2026-11-18 for configuration-specific
FrontierCode-AA 2.0 repository work and Terminal-Bench 4.0 terminal tasks.
The results vary with effort and do not establish review, planning or
production-operations quality. They do not establish equivalent difficulty tiers.
No benchmark dataset or score table is redistributed here.

Astra offers a stronger measured option in several tested configurations,
but costs four times Sol per token. Existing built-ins did not use Astra;
this refresh does not introduce it. Terra and Luna retain distinct lower-price
roles. These are provisional routing policies, not measured task adequacy.

The reviewed official guides recommend low/medium effort and reject none/minimal;
they do not enumerate the full supported effort range. Pi's current Codex
catalog advertises high/xhigh/max as well. Existing high/xhigh requests are
retained and validated/mapped through the exact provider's live registry,
not treated as universal API support established by benchmark labels.
API context limits do not override a Codex deployment's catalog limits.

This refresh has synthetic regression coverage, not a live generation benchmark
or account-entitlement test. See the generated [activity](../activity-presets.md)
and [mode](../mode-preferences.md) tables for the requested pairs.
