# Что перенести из Claude Router в Pi

Анализ от 5 октября 2026. Читатель: разработчик Pi Router.
Это рекомендации, не описание уже внедренных функций.

## Краткий вывод

**UI стоит переносить почти целиком по смыслу, но не по коду.**
Pi extensions позволяют сделать status band, конфигурационный экран,
usage view, переключатели профилей и pins без изменений Pi core.

**Switching policy целиком переносить не стоит.**
Сохранить Pi eligibility, continuation validation, cancellation и explicit fallbacks.
Cache economics сначала расширить как наблюдаемую shadow-метрику.
Только после измерений рассматривать ограниченную защиту от колебаний на новых user turns.

[Открыть интерактивный HTML-прототип](../prototypes/router-ui.html).

## Область исследования

Окно: **2026-10-03 11:16 UTC — 2026-10-05 11:16 UTC**.
Обе рабочие директории были чистыми при начале исследования.

Claude Router, HEAD `d7c7067`:

| Commit | Время UTC | Изменение |
| --- | --- | --- |
| `46eef01` | 05 Oct 07:07:48 | 1.0.0: gateway заменен Claude Code Mod |
| `086e84d` | 05 Oct 08:04:18 | docs приведены к 1.0.0 |
| `a878235` | 05 Oct 10:41:38 | 1.1.0: band, tabs, route editor, tuning, usage |
| `d7c7067` | 05 Oct 10:57:03 | engine-backed CI и revmux profile |

Pi Router: `0.9.2`, HEAD `cc40b920`, локальная Pi dependency `1.0.2`.
Установленный Pi: `1.0.3`. Важные UI и virtual-model APIs проверены
также в декларациях локальной `1.0.2`, а не только в новых docs.

Последние два дня — большой перенос runtime и UI, а не полная замена
математической switching policy. `policy.mjs` и `native-cost.mjs`
получили native integration в 1.0.0; diff 1.0.0 → 1.1.0 их не меняет.
Сами cost-sensitive downgrades и multi-turn horizon старше окна:
CHANGELOG относит их к 0.7.1/0.7.2, 24–25 сентября.
Релиз 1.1.0 меняет default medium: Sonnet xhigh → Opus medium.

Источники: Claude `CHANGELOG.md:3–56`, git log/show/diff,
`lib/config.mjs:5–74`. Рассмотрены исходники и тесты, не приватные
сессионные логи, credentials или реальные счета. Новые performance/savings
измерения не проводились.

## 1. Что именно улучшилось в Claude

### Native dispatch вместо gateway

Mod меняет model/effort основной беседы; Claude Code владеет HTTP,
credentials, streams, tools и нативным учетом usage.
Subagents сохраняют собственные модели. Это хорошая граница ответственности.

Pi Router уже близок к этому: собственный логический provider,
а конкретная генерация идет через Pi registry. Proxy/daemon переносить не нужно.

Источники: Claude `hooks/native-router.mjs`, `CHANGELOG.md:32–56);
Pi [provider.ts](../../extensions/provider.ts), delegation около строк 989–1059.

### Band + подробный экран

Claude band показывает tier/model/effort, короткую причину,
поддержку Jev, context/cache. Не помещающиеся сегменты убираются
по приоритету. Дополнительная строка показывает последние ответы и switches.

Pane разделен на **Now / Tiers / Tuning / Usage**.
Routes редактируются как draft; показывается diff, есть Save/Discard.
Untouched поля сохраняют изменения, сделанные на диске.

Источники: Claude `lib/native-band.mjs:18–46,83–205`,
`lib/native-panel.mjs:14–28,248–409`,
`lib/config.mjs:95–161`, `hooks/native-router.mjs:577–703`.

Что особенно стоит взять:

- Видимая разница selected, proposed и actual model.
- Короткая причина в band, подробности только в pane.
- Запланированный pin не выдается за уже выполненное переключение.
- Context capacity и **observed cache-read share**, а не абстрактный “cache health”.
- Draft/diff/save, сохранение нетронутых полей и отказ писать в symlink.
- Не показывать родительский route в чужом subagent transcript.
- Ограниченные history strips, ошибки и unavailable state без toast-шума.

Не копировать: жесткие hex-цвета, hover как единственный способ найти управление,
измерение terminal width через JS string length.
В Pi нужны semantic theme colors и `visibleWidth/truncateToWidth`.

## 2. Что Pi extensions реально позволяют

Это публичные возможности Pi, не monkey patch внутренних React/Ink компонентов.

| Поверхность | Pi API / компоненты | Рекомендация |
| --- | --- | --- |
| Status | `ctx.ui.setStatus(key, text)` | Всегда короткий actual route + reason |
| Band над/под prompt | `ctx.ui.setWidget(key, factory, {placement})` | 2–3 строки; adaptive priority |
| Dialogs | `select/confirm/input/editor` | Простые bounded действия |
| Router screen | `ctx.ui.custom(factory)` | Основной интерактивный config/stats экран |
| Overlay | `custom(..., {overlay:true, overlayOptions})` | Временное окно на широком терминале |
| Tabs, selectors, forms | `Container/Box/HStack/VStack, SelectList, SettingsList, Input` | Tabs — небольшой custom state |
| Таблицы и графики | Text + terminal bars/sparklines; `ScrollView` | Никакой plotting dependency |
| Mouse | Fullscreen mouse handlers / `MouseRegion` | Дополнение, не замена keyboard |
| Header/footer/editor | `setHeader/setFooter/setEditorComponent` | Доступны, но для Router избыточны |
| Model/provider | `registerProvider`, `registerVirtualModel` | Сохранить текущий путь для первого UI этапа |
| Persistent state | `pi.appendEntry`, session branch reads | Branch-safe runtime + metadata |
| Commands / hotkeys | `registerCommand/registerShortcut` | Сохранить CLI и добавить UI-вход |

Ограничения:

1. Это terminal cells и ANSI, **не HTML/CSS/DOM внутри Pi**.
2. Overlay может перекрывать transcript; это не docked sidebar,
   автоматически уменьшающая ширину основной беседы.
3. В regular terminal mode mouse принадлежит терминалу. Все действия должны
   работать с keyboard. Не перехватывать цифры глобально в prompt.
4. Custom UI относится к interactive mode. RPC может передавать простые UI
   requests/status/widgets клиенту, но не выполнять terminal component factory;
   print/headless должен иметь текстовый fallback.
5. Footer и editor — общие replacement surfaces. Их замена может конфликтовать
   с другими extensions. Для Router достаточно keyed status/widget.
6. Компоненты нужно завершать через supplied `done`, освобождать subscriptions,
   пересоздавать после reload/session replacement и проверять resize/theme.
7. Extensions работают с правами процесса Pi. Это trusted code, не sandbox.

Источники: установленный Pi `docs/extensions.md`, `docs/tui.md`,
`examples/extensions/widget-placement.ts`, `custom-footer.ts`,
`overlay-qa-tests.ts`; локальные `core/extensions/types.d.ts:65–185,1365`.

### Насколько это аналог Claude Code Mods?

По пользовательскому результату — **да**: band, настройки, usage, callbacks,
динамическое обновление и model routing возможны.
API не тот же: в Pi собственные terminal components вместо `ui.render`
перехватчиков `AbovePrompt/Pane`. Переносить придется view model и UX,
а не Ink/Mod render code.

Для настоящего браузерного dashboard существует Pi SDK/RPC, но это отдельный
client/host. Для этой задачи он не нужен. HTML ниже — макет TUI.

### Новый native virtual-model API

Pi уже имеет `pi.registerVirtualModel()`: стабильный logical selection,
physical dispatch, `reason=user/continuation/retry/direct`,
`previous/failed` routes и branch state.
Это близкий по смыслу аналог native Mod routing.

**Не мигрировать заодно с UI.** Текущий проект требует custom provider.
Отдельный spike должен проверить feature parity: explicit fallbacks до content,
Google signatures, abort, shared advisor flight, effort mapping, context limits,
стоимость скрытых failed attempts и resume/fork behavior.
Не переносить phase-based routing из примера `jev-router.ts):
оно противоречит политике этого проекта.

Источники: Pi `docs/virtual-models.md`,
локальные `core/extensions/types.d.ts:1365–1371`.

## 3. Switching: полезная идея, опасный перенос целиком

Claude policy:

1. Повторяющийся tool failure с edit между ошибками вызывает escalation/hold.
2. Без advice, при continuation mass или abstention остается incumbent.
3. Upgrade требует probability mass + consecutive votes; сильный jump проходит сразу.
4. Cache switching tax повышает threshold.
5. Downgrade требует последовательную поддержку и учитывает несколько будущих turns.
6. Cold write guard ограничивает automatic переход к credits-billed model.
7. Context/capability проверка может изменить предложенный route.

Источники: Claude `lib/policy.mjs:13–115`,
`lib/native-cost.mjs:24–88`, `lib/native-router.mjs:85–150`.

**Что не переносить:**

- Local escalation по нормализованному тексту tool errors.
  У проекта Pi явный запрет mechanical intent/tier detectors.
  Ошибка hook/network/environment не доказывает нехватку model capability.
  В Claude changelog 0.8.0 уже описан такой негативный опыт.
- “Нет advice → навсегда incumbent”. В Pi abstention/failure ведут к
  configured eligible baseline. Скрытая hysteresis изменила бы этот контракт.
- Автоматические upgrade floors, phase inference, quality rankings по цене.
- TTL “fresh” как доказательство будущего cache hit.
- `billing:plan/credits` из предположения о backend login.
  Pi owns auth; явные operator billing declarations — отдельная возможная политика.
- Понижение tier внутри active tool loop ради цены.
- Подмена невалидного pin “доступным другим tier”.

**Что сохранить в Pi:**

Validated same-turn tool route; eligibility до advisor и перед generation;
explicit pin; soft budget; один candidate на tier; один advisor path;
strict Jev validation; abort без baseline generation;
fallback только в явном порядке и до visible content.
Неподдерживаемый effort отображать как requested → effective,
с действующим Pi nearest-level mapping, не Claude clamp-down.

Источники: [architecture](../architecture.md),
[routing.ts](../../extensions/routing.ts),
[provider.ts](../../extensions/provider.ts).

### Как осторожно улучшить policy

**Этап 1 — без behavioral change.**
Записывать proposed vs actual pair, switches только между user turns,
same-model effort changes отдельно, причины bypass,
observed usage/attempts и advisor latency.
Проверить, есть ли вообще дорогой route oscillation.

**Этап 2 — shadow economics.**
Для того же workload сравнивать current/candidate tariffs и cache scenarios.
Показывать uncertainty, source и coverage.
Не применять совет, если невозможно установить цену или сопоставимость контекста.

**Этап 3 — только после отдельного согласования контракта.**
Ограниченная user-turn downgrade hysteresis:
валидированная semantic advice поддерживает более дешевую eligible пару;
pin/abort/capability/continuation правила не меняются.
Не задерживать сильный quality upgrade ради небольшой предполагаемой экономии.
Не применять persistence к ошибке advisor: сохранить baseline fallback.
Без evidence качества и сравнимых runs такую политику не включать по умолчанию.

Vote streak и расчет horizon — идеи для эксперимента, не готовые Pi defaults.
Сначала сравнить качество, full-run cost, latency, switches и retries
на одинаковых задачах.

У Claude native replay пока только 37 advised main decisions, причем
на них old/new policy дали одинаковые route/reason. Это не доказательство
экономии нового Mod. Источник: Claude `docs/evaluation.md:25–40`.

### Обнаруженный риск в Claude: credits cap проверяется не везде

Независимый разбор указал на пропуск, подтвержденный прямым запуском
`decide()` из текущего Claude checkout.

`cashGate()` вызывается только в upgrade branch.
При automatic downgrade и выборе baseline без advice cold-write cap
не проверяется. Это не новый дефект UI 1.1.0.
При default plan-billed моделях ограничение неактивно, но конфигурация
позволяет `billing: "credits"`.

Воспроизводимый synthetic case: Sonnet объявлен credits, cap $0.10,
100k input + 1k предыдущего output, incumbent high, два голоса low
с probability mass 1. Оценка cold write — **$0.404**.
Policy возвращает **low / downgrade**, несмотря на cap.
С тем же credits baseline и без advice возвращает **low / no-advice**.

Рекомендация для отдельного исправления Claude:
проверять guard на каждом новом unpinned automatic target, а не только
при upgrade. Добавить regression cases для downgrade и baseline.
Это guard конкретного estimated cold write, не hard session spending cap.
Исходники Claude не изменены.

Источники: Claude `lib/policy.mjs:30–61,96–115`,
`lib/config.mjs:16–74`; прямой Node invocation 5 октября.

## 4. Cache и cost: что учитывать

### Хорошая граница в Claude

UI читает `$.session.usage()` и подписывает cost “by Claude”.
Router не ведет второй authoritative billing ledger.
Cache benefit вычисляется из last observed read counters и configured tariffs.

Источники: Claude `lib/native-display.mjs:81–109`,
`lib/native-panel.mjs:228–240`, `hooks/native-router.mjs:582`.

“cache saved” лучше назвать **read-price benefit on last response**:
это не routing savings, не session aggregate и не invoice.
Гипотетическая генерация могла бы иначе использовать cache.

### Почему дешевый candidate может оказаться дорогим сейчас

На тарифах в Claude config, пример: 100k input и 1k output.

- Warm Opus: `100k × $0.2/M + 1k × $20/M = $0.04`.
- Cold Sonnet при 1h write: `100k × ($2/M × 2) + 1k × $10/M = $0.41`.
- Следующий warm Sonnet при тех же counters: `$0.03`.

Первый переход дороже на $0.37 при возможной дальнейшей разнице $0.01/request.
Это **условный scenario**, не forecast и не доказанный payback.
Неизвестны будущие cache hits, workload, output, число turns и качество.
Даже возврат к ранее использованной модели не гарантирует сохранение prefix.

Источники тарифов: Claude `lib/config.mjs:16–58`.
`isWarm` использует observed prefix, время и 5m conservative TTL/margin;
ни equality всего prefix, ни фактический hit следующего запроса это не подтверждает
(`lib/native-cost.mjs:34–52`).

### Pi уже делает важную часть правильно

- Disjoint input/read/write counters.
- Суммирование `usage.cost.total` каждого terminal attempt, включая failure
  перед fallback.
- Unknown cost при missing usage; без выдуманного cache warmth.
- Same-workload all-read/all-new scenarios не влияют на routing.
- Цена от Pi registry/stream, не собственная таблица тарифов Router.

Источники: [economics.ts:15–89](../../extensions/economics.ts),
[provider.ts:1031–1060](../../extensions/provider.ts),
[types.ts:281–305](../../extensions/types.ts).

В Pi AI 1.0.2 `calculateCost` уже обрабатывает price tiers и
`cacheWrite1h`. Не копировать Anthropic multipliers в router поверх
готового `usage.cost`. Текущий shadow использует base rates и потому
не эквивалентен полной тарифной модели.

### Что улучшить первым

1. **Отделить generation budget от session total.**
   Compaction, summaries, nested model calls, cache warming и advisors имеют
   собственные виды расходов. Generation-only soft budget назвать именно так.

2. **Показывать coverage.**
   Сейчас missing usage делает request cost unknown, но накопленная сумма
   сохраняется. UI не должен выдавать ее за полный расход:
   “known catalog cost; N attempts with unknown usage”.

3. **Stats не из debug ring.**
   Максимум 50 решений и log-off непригодны для lifetime totals.
   Pi native entries дают assistant usage, tool usage, usage entries,
   compaction и branch summaries.
   Собрать представление из `getEntries()` для whole-session scope;
   `getBranch()` использовать только для явно названной текущей ветки.

4. **Не потерять скрытые attempts.**
   Pi Router перехватывает failures до visible content.
   Не считать, что every attempt автоматически попал в transcript.
   Для таких расходов нужны allowlisted attempt metadata и явная сверка;
   нельзя суммировать forwarded assistant cost второй раз.
   Native ledger — источник host totals, router diagnostics — объяснение
   attempts/coverage, не альтернативный invoice.

5. **Сохранить TTL split и provenance, когда доступны.**
   `cacheWrite1h`, cost components, attempt outcome, actual model и pricing basis.
   Исторический reported cost не переписывать по сегодняшним registry prices.

6. **Deduplicate advisors.**
   User turns, generation requests, tool continuations, HTTP attempts и unique
   advice requests — разные счетчики. В Pi уже есть request-ID dedupe,
   но только внутри retained history.

7. **Не обещать warming для router.**
   Pi имеет core cache warming, но выбранный logical `router/*` сейчас не
   объявляет lifetime/real tariff. Core также защищается от warming
   redirected/virtual routes. Простое выставление `promptCache` на wrapper
   не обеспечивает безопасный refresh конкретного target.
   Integration требует отдельной проверки; UI: “managed by Pi / unknown”.

8. **Не смешивать catalog и billing.**
   Unknown/zero tariff не означает free request.
   Subscription utilization и invoice должны быть отдельными,
   только если источник действительно доступен.

Источники: Pi `core/agent-session.js:3340–3400`
(whole-session entry aggregation), `core/extensions/types.d.ts:223`
(read-only session manager), `core/sdk.js:200–265` (warming checks);
[ui.ts:218–291](../../extensions/ui.ts),
[index.ts:171–176,344–396](../../extensions/index.ts),
[constants.ts:12](../../extensions/constants.ts).

## 5. Предлагаемый UI

### Постоянно: только actionable summary

Status: profile, actual tier/model/effort, local reason.
Band: actual route, advisor/bypass, observed cache counters,
catalog cost + coverage, переход к подробностям.
В узком terminal width убрать economics/advisor detail раньше actual route/errors.

Не брать footer/editor ownership. Не заводить polling loop для stats;
обновлять view по routing/message/session events и запросам пользователя.

### Router screen

- **Now:** selected/proposed/actual, requested/effective effort,
  next-request overrides, continuation/fallback, last usage, unknowns.
- **Config:** effective merged profile + source каждого значения;
  отдельные session controls и file draft.
- **Advisor:** authorization, active-profile privacy opt-in, bounded context,
  timeout и acceptance; без ключа и remote explanations.
- **Stats:** явно branch/session scope, cost components/coverage,
  user turns vs generations, tier/model/effort mix, unique advisor calls,
  transitions, failed attempts и overhead.
- **Events:** последние локальные reason codes; no transcript text.

Новые `/router config`, `/router stats`, `/router screen` — предложения.
Существующие profile/pin/thinking/log/widget/reload команды сохранить.

### Config saving

Сохранить Claude draft/base pattern, но улучшить:

- Явно выбрать user или project файл; показать provenance/override.
- Редактировать raw выбранного файла, не записывать merged config целиком.
- Перед save перечитать файл; preserve untouched fields.
- Если то же поле изменилось с момента открытия draft — показать conflict,
  а не молча перезаписать его.
- Validate → diff → confirm → atomic write → reload; ошибки без file values.
- Managed/symlink config не перезаписывать; предложить изменение maintained source.
- Jev credentials и profile opt-in только operator-owned user config.
  Project не должен получить ключи или разрешение отправлять private context.

Источники: Claude `withRoutes/withTuning` и `saveConfig`;
Pi [config.ts:548–568,747–768](../../extensions/config.ts).

## 6. Минимальный порядок реализации

| Приоритет | Изменение | Проверка |
| --- | --- | --- |
| P0 | Compact status + 2–3-line band + Now/Events screen | narrow width, resize, themes, no focus theft |
| P0 | Cost coverage, actual/proposed separation, scope labels | missing usage, charged failure, no double count |
| P1 | Effective config viewer + session controls | pin isolation, requested/effective effort, resume/fork |
| P1 | Full-session stats over native usage + missing-attempt metadata | log-off, >50 decisions, rewind, compaction, retries |
| P2 | File editor with draft/diff/conflict/save | symlink, stale draft, user/project merge, privacy |
| P2 | Extended shadow economics | long-context prices, 1h writes, unknown tariff, truncation |
| Later | Optional downgrade hysteresis / native virtual-model spike | agreed contract + comparable quality/cost runs |

В production придерживаться текущих модулей:
`ui.ts` — projections/components, `commands.ts` — входы,
`state.ts` — allowlisted metadata/snapshots,
`economics.ts` — catalog comparisons,
`routing.ts` — только утвержденная policy.
Не писать второй provider runtime или React layer.

## 7. Прототип и проверка

Файл: [router-ui.html](../prototypes/router-ui.html).
Самодостаточный HTML/CSS/JS, без dependencies, network, localStorage
или настоящих config writes.

В нем есть status/band, пять tabs, session controls, выбор файла,
partial config patch с tier model/effort/fallback, text statistics,
keyboard navigation, light/dark и width preview.
Шесть routing scenarios: advice selected, continuation, timeout,
generation fallback, soft budget, unknown tariff.

Все counters и rates synthetic. Last-response scenarios и stats ledger —
отдельные fixtures, явно подписаны. Future cache неизвестен.
Ни “savings”, ни “invoice” не выдаются за измеренный результат.

Проверено:

- Chromium headless: interactions, keyboard, config patch, unknown pricing,
  desktop 1440 px, mobile 390 px, без document horizontal overflow.
- Light/dark, wide/narrow, status-only.
- Browser JS errors: 0; screenshot evidence в `/tmp/playwright-router-*.png`.
- `npm run check`: passed.
- `npm test`: 15 suites, **662 tests passed**.
- Независимый read-only разбор Claude завершен; его выводы сверены.
  Credits-cap gap воспроизведен отдельно без изменения исходников.
- Markdown links: 13 checked, 0 broken. Prose lint: advisory замечания
  к смешанному RU/EN тексту и пунктуации; Mermaid diagrams не добавлялись.

HTML не внедрен в Pi. Actual TUI rendering, terminal IME, resize/focus
и coexistence с установленными extensions потребуют проверки при реализации.
Live Jev/provider calls, Claude engine acceptance и реальные счета не проверялись.
