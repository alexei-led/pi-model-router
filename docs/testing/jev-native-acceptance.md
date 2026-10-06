# Jev native authentication migration

Date: 6 October 2026. Validation snapshot: `router-ui-v2` development worktree,
before the 0.10.0 release commit.

## Change

Jev now calls Pi's public classifier registry, like Cloudflare. The shared
`choice.ts` adapter owns the bounded request policy and strict answer
validation. Pi owns credentials, configured provider URLs and native HTTP
dispatch. No credentials were read from private auth storage or copied.

The normalized router schema and example no longer contain `jev.apiKey` or
`jev.endpoint`. Legacy fields emit a value-free migration warning. A custom
legacy endpoint disables Jev until it is migrated to Pi, rather than silently
sending text to another service. Profile privacy approval is unchanged.

The requested `jev-1.13.0` pin is retained on the wire. The native catalog's
`jev-latest` entry supplies transport metadata only when an exact pinned entry
is absent. The router does not substitute that alias in the request.

The shared adapter keeps Jev's structured criteria, total deadline, byte bound,
explicit retries, cancellation, strict candidate/distribution checks and safe
response diagnostics. The chat-classifier path is still used only when Jev is
inactive, not after an active Jev authentication or transport failure.

## Offline verification

- Initial migration tests failed against the direct-HTTP implementation.
- `npm run check`: Biome and TypeScript passed.
- `npm test`: **797 tests in 19 suites passed**.
- Coverage includes registry-owned credentials, exact pin/URL dispatch,
  foreign-provider rejection, a stalled authentication operation, legacy-field
  cleanup, custom-endpoint protection and no second advisor on missing Pi auth.
- Existing Jev response/deadline/context and Cloudflare transport tests now
  exercise the shared implementation. Jev tests mock the registry/auth boundary
  and use Pi's actual TypeSafe transport conversion.
- Existing provider, continuation, fallback, state and UI tests remain passing.

## Separately approved live smoke

The operator had already used the four earlier smoke requests and explicitly
approved **one additional Jev request**, with cost acknowledged as unknown.
The test used the existing actual Pi 1.0.4 session in agterm 0.34.0, normal
TypeSafe login and the unchanged dev adapter through `ctx.modelRegistry`.

Only synthetic task text and two candidate IDs were sent. No transcript from
this coding session, system prompt, tool output or configuration was sent.
The test set a 512-token state bound, a 10-second total deadline, one HTTP
attempt and a 16,000-character request-body ceiling. A one-shot result file
prevented accidental repeats. Production's 1500 ms default was unchanged.

| Observation | Result |
| --- | --- |
| HTTP requests | 1, no retry |
| HTTP response | 200 |
| Requested model | `jev-1.13.0` |
| Service-reported model | `jev-1.13.0` |
| Router outcome | selected / choice |
| Selected candidate | low / `openai-codex/gpt-6-luna` / off |
| Confidence / option probability | 0.92 / 0.95 |
| Input tokens | 1044 reported; 1196 estimated |
| Total observed latency | 297 ms |
| Cost | Unknown; a zero catalog rate is not proof of free usage |

Local sanitized evidence:
`/tmp/router-ui-v2-acceptance/live-jev-native.json` and
`/tmp/router-ui-v2-live/jev-native-screen.txt`.

This proves one live authentication/dispatch/validation round trip, not routing
quality or a latency guarantee. No second generation call followed the advice.

## Configuration ownership and delivery

The repository schema, example and current guides are cleaned. The operator's
existing user router file was not rewritten: its older installed extension
still depends on the legacy field. Remove those fields after loading the
migrated extension, following the [migration guide](../jev-advisor.md#migrate-the-old-router-fields).
These migration checks did not install globally or publish a package.

The Classifier screenshot was recaptured after its Jev label was changed from
the latest alias to the user-configured model pin. The screenshot remains
synthetic native-host evidence, separate from the live smoke above.

Independent review approved the migration with no confirmed P0/P1 findings.
Its one P2 diagnostics finding was reproduced with failing tests and fixed:
request IDs are now assigned at the first bounded HTTP fetch, not before Pi
authentication. Returned or thrown authentication errors before fetch leave
both request ID and HTTP attempt count absent. Retries reuse the same ID.
Focused tests, the full 797-test suite, TypeScript/Biome, package dry-run and
diff checks passed after that correction. No additional paid request was made
for this diagnostics-only fix.
