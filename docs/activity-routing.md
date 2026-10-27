# Activity routing: defaults and tuning

**The router chooses two things: task difficulty and kind of work.**
Together, they select a model and reasoning effort.

- **Tier:** `micro`, `low`, `medium` or `high`.
- **Activity:** `code`, `debug`, `explore`, `plan`, `review`, `ops` or `docs`.

For example, `low + debug` can run a different model from `low + ops`.
A tier is not a tool-permission boundary or a spending limit.

## Start with the defaults

Already have an OpenAI or Claude profile? You do not need to copy an activity matrix.

1. Update the router.
2. Restart Pi or run `/reload` to load the updated extension.
3. Select your profile with `/router profile <name>`.
4. Run `/router status`.
5. Open `/router routes`.

A recognized profile reports `Activity preset: openai` or `Activity preset: anthropic`.
The Routes grid marks built-in cells with **B**.
Only tiers already present in your profile receive built-in cells.
The [complete matrices](activity-presets.md) list all seven activities and four tiers for each family.

**Presets do not enable the classifier.**
To choose activities from your requests, [configure and approve a classifier](classifier-advisor.md#configure-a-model).
Check the Classifier tab for **Eligible to ask**.
Provider authentication still happens in Pi when a request runs.

### What activates automatically?

The default is `profiles.<name>.activityPreset: "auto"`.
Recognition uses resolved model IDs, never profile names or provider-name patterns.

| Preset    | Recognized primary model IDs                                                          |
| --------- | ------------------------------------------------------------------------------------- |
| OpenAI    | `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol`, predecessor `gpt-6-sol`                 |
| Anthropic | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, legacy `claude-haiku-4-5` |

Every configured generic primary must belong to one family and use the **same exact Pi provider ID**.
Aliases in `models` are resolved first.
Unknown IDs, mixed families and mixed provider IDs do not receive a preset.
Their explicit activity routes still work.

Built-in targets use that same provider ID, including custom subscription aliases.
For example, `openai-codex-work` never becomes `openai-codex-personal`.
The router does not inspect credentials or attest which account a backend uses.

**Upgrade notice:** recognized existing profiles receive defaults on reload.
Defaults can introduce models not previously named in the profile, including Terra for old OpenAI profiles and Haiku 5.5 for a legacy Haiku 4.5 profile. OpenAI medium activity cells now use Terra/xhigh for code/debug and Terra/medium otherwise; low activity cells use Luna/high. Mode-aware preferences can choose Terra or Sol before raising effort; see [mode ownership and precedence](routing-modes.md#openai-default-preferences).
They can increase spending, even if the old profile used only a cheap model.
Files are not rewritten. Use the opt-out below to retain tier-only behavior.

## Understand the display

| Display                              | Meaning                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `debug`, `code`, or another activity | A validated classifier activity selected this route.                            |
| `base`                               | No activity-specific cell selected. This replaces the old `generic` label.      |
| An availability-cell label           | A local eligibility fallback used an activity cell, not an inferred task label. |
| `last`                               | The displayed generation finished. It is not a running request.                 |
| `B` in Routes                        | Built-in preset cell.                                                           |
| `O` in Routes                        | Explicit file or session cell.                                                  |
| `I` in Routes                        | Inherits the generic tier, also called the base route.                          |

`base` is normal with pins, disabled activity routing, uncertain advice or initial advice failure.
A classifier activity can also use the selected tier's generic plan when its specialized cell is unavailable.
The inspector distinguishes the validated activity from the physical cell that supplied the route.

The router asks about activity only when eligible plans differ.
It does not classify work merely to decorate the display.
Initial advice runs on a new user task. Background reviews can reconsider a running tool loop.
See [classifier selection and bounds](classifier-advisor.md#bounds-and-selection).

## Tune one cell permanently

Edit `~/.pi/agent/model-router.json`.
Add the following inside your **existing profile**. Replace `auto` with that profile's name.
Do not replace the entire file with this fragment.

```json
{
  "profiles": {
    "auto": {
      "activities": {
        "debug": {
          "medium": {
            "thinking": "high"
          }
        }
      }
    }
  }
}
```

Then run `/router reload` and inspect `/router routes`.

**An explicit cell replaces that preset cell.**
Missing fields inherit your generic tier, not the preset.
Thus this example uses your generic medium model at `high` effort.
This preserves the meaning of existing sparse activity settings.
To keep a preset model while changing its effort, specify that model too.

For example, this cell explicitly chooses Sol at `xhigh`:

```json
{
  "model": "openai-codex/gpt-6.1-sol",
  "thinking": "xhigh"
}
```

Use your exact registered provider ID. Model aliases are also accepted.
An explicit `fallbacks` list replaces the generic list. `[]` removes that list.
Otherwise, the generic tier's ordered fallback list is retained.

### Use the base route for one cell

Set the activity/tier cell to `null`:

```json
{
  "profiles": {
    "auto": {
      "activities": {
        "ops": { "medium": null }
      }
    }
  }
}
```

This suppresses the preset for `ops/medium` and restores generic medium inheritance.
Remove the `null` entry to restore the preset on the next reload.
An empty cell `{}` also inherits the generic tier, but appears as an explicit override.

### Turn off defaults, but keep your custom routes

Set this **user-level profile** field:

```json
{
  "profiles": {
    "auto": {
      "activityPreset": "off"
    }
  }
}
```

Use `"auto"` to enable automatic recognition again.
Off also disables automatic generic mode preferences and restores legacy tier-mode transforms. Explicit activity cells remain active.
Only `auto` and `off` are valid. An invalid value warns and uses `off`.
Project files cannot change this field.

### Turn off all activity routing

Set the top-level field in user or project configuration:

```json
{ "activityRouting": "off" }
```

Built-in and explicit cells remain visible, but neither participates in routing.
Use `"on"` to restore them. This does not change classifier approval.

## Try a change without editing files

1. Open `/router routes`.
2. Choose **Edit cell**.
3. Select the activity and tier.
4. Choose a registered model and supported effort.
5. Choose **Apply routes**.
6. Close the inspector and send a new user message.

**Apply queues the change. It does not interrupt the current tool loop.**
The grid shows `*` for drafts and `+` for queued changes.
**Reset to generic** suppresses the cell for this session.
A router reload restores the file-backed cell or preset.
These controls do not write configuration files or change credentials.

A tier-wide effort override in Settings wins over every activity's effort at that tier.
Clear it to return to cell-specific effort.
A pin uses the generic tier and bypasses activity advice and routing modes.

## Which setting wins?

For file-backed routes:

1. Merge user declarations with project route declarations, field by field.
2. An explicit activity cell inherits the resulting generic tier.
3. An absent cell uses the recognized preset, or generic inheritance without a preset.
4. A `null` cell suppresses the preset.
5. Queued session edits take effect at the next user message.

Project `.pi/model-router.json` can tune cells and set `activityRouting`.
It cannot choose, enable or approve a classifier, or change `activityPreset`.
Use only project files you trust: explicit project routes can name other providers.

[Routing modes](routing-modes.md) resolve default-owned model/effort alternatives or custom transforms before advice.
Manual effort overrides and pins retain their existing priority.
The router revalidates availability, input support and context fit before selection.
Unsupported effort maps to the nearest supported level in Pi.

## Missing models and failures

Presets do not install models or providers.
Registry presence does not prove account entitlement or working credentials.
A newly introduced model can fail when Pi authenticates or calls it.

An unavailable preset primary can use its **already declared generation fallbacks**, in order.
If the activity cell has no eligible attempt, valid activity advice uses the selected tier's eligible generic plan.
Otherwise, selection uses the deterministic eligible baseline.
The baseline prefers generic cells, but can use an activity cell when no generic route remains eligible.
Context-window filtering can cause that case even without activity advice.

No implicit fallback model is added. Cancellation never starts fallback generation.
Retries use only declared generation fallbacks, before visible content.
The soft budget skips advice and prefers eligible medium-or-lower tiers. It is not a physical-model price ceiling.

## Troubleshoot

| Symptom                                   | Check                                     | Fix                                                                                  |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| All requests show `base`                  | Classifier tab and Routes grid            | Enable and approve a registered classifier. Check for pins or disabled routing.      |
| Preset says `none (unrecognized routes)`  | Primary canonical IDs and provider IDs    | Use a supported homogeneous profile, or define explicit activity cells.              |
| A built-in cell says unavailable          | Registered models for the exact provider  | Register/access the target, add an explicit fallback, or override/suppress the cell. |
| Changed effort does not run               | Settings tier-wide override               | Clear that override. Inspect actual mapped effort.                                   |
| Edited JSON has no effect                 | Configuration warnings and profile name   | Correct the file and run `/router reload`.                                           |
| UI edit disappeared after reload          | Session-only versus file-backed settings  | Add the cell to user or project configuration for persistence.                       |
| Activity is right but model is unexpected | Now tab, mode, fallback and held proposal | Inspect the actual cell and switch reason, not just the classifier answer.           |

## Why these defaults?

They are **derived starting policies**, not vendor-prescribed routing tables or measured quality equivalence.
The complete mappings, effort controls and limitations are covered in the
[Terra policy evidence](research/2026-10-27-terra-defaults.md) and the earlier
[activity model-card evidence](research/2026-10-25-activity-presets.md).
The [acceptance record](testing/activity-presets-acceptance.md) separates automated, synthetic and live checks.
