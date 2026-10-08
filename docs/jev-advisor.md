# Jev configuration migration

The provider-specific Jev adapter is removed. Configure any Pi classifier through the generic [classifier advisor guide](classifier-advisor.md).

## Migrate the old router fields

Remove `jev`, `cloudflare`, `classifierModel`, and the string-valued `advisor` field. Configure `advisor.enabled` and `advisor.model` in user-level router config. Add the exact `provider/model` reference to `profiles.<name>.advisor.models` only for profiles that approve sending bounded conversation text. Keep credentials in Pi. Project configuration cannot select a classifier or add approval.
