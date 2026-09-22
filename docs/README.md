# Documentation

Operator-facing usage starts in the root [README](../README.md). This folder
holds everything deeper.

## Current

| Document | Type | Content |
| --- | --- | --- |
| [architecture.md](architecture.md) | design | Routing decision flow, continuation predicate, Jev adapter boundaries, module dependency direction, state and persistence, fallback chains, test boundaries. |
| [jev-advisor.md](jev-advisor.md) | guide | Jev configuration reference, privacy, context selection, acceptance policy, diagnostics and troubleshooting. |
| [releasing.md](releasing.md) | operations | Signed-tag release procedure and verification. |

## Research

Experiments that justify the current defaults. Each report names its date, the
Jev model, the corpus and its limits. They are evidence, not specification;
when a report and a current document disagree, the current document wins and
the report says what changed since.

| Report | Date | Question |
| --- | --- | --- |
| [research/jev-routing-policy.md](research/jev-routing-policy.md) | 2026-09-22 | Structured criteria, probability-based acceptance, parallel Noul questions, live Pi/agterm sessions. |
| [research/jev-context-selection.md](research/jev-context-selection.md) | 2026-09-22 | Which recent context to send, token estimation without a Jev tokenizer. |

## Archive

Reports whose subject was replaced. Kept for provenance; each starts with a note
saying what superseded it.

| Report | Date | Subject |
| --- | --- | --- |
| [archive/2026-09-21-jev-quality-first-routing.md](archive/2026-09-21-jev-quality-first-routing.md) | 2026-09-21 | 0.6.4 quality-first criteria and 24-task live validation. |
| [archive/2026-09-21-jev-input-comparison.md](archive/2026-09-21-jev-input-comparison.md) | 2026-09-21 | 0.6.3 input-window comparison and same-turn routing fixes. |

## Conventions

- Folders by type: the root of `docs/` holds current design, guides and
  operations; `research/` holds dated experiment reports; `archive/` holds
  superseded documents; `plans/` holds implementation plans while they are
  active and is empty otherwise.
- File names are lowercase kebab-case. Archived reports are prefixed with the
  ISO date of their experiment.
- One fact lives in one place: mechanism in `architecture.md`, configuration
  and operator guidance in `jev-advisor.md` or the root README, evidence in
  `research/`. Other documents link instead of restating.
- A document that stops being true is moved to `archive/` with a superseded-by
  note, or deleted when it has no provenance value.
