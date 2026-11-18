# Публикация M1 + M2

Состояние на 18.11.2026: M1/M2 опубликованы на действующем HTTPS-сайте через [Actions 44320255728](https://github.com/maxeliseyev/endlessdrawing-backend/actions/runs/44320255728), все jobs successful. Проверены 210 unit, 205 E2E (2 CDP-only skips), три public browser integrations, backend/PostgreSQL/WS suite, fmt/clippy/doc и real localhost HTTPS admin gate с виртуальным UV authenticator, manifest refresh и hide. Реальные Touch ID/iPhone/iPad для нового транспорта, browser paint/CPU/memory и нагрузочный WAN baseline ещё не проверены; внешние read-only HTTPS/WSS проверки выполнены после выкладки. M3 не требуется ждать для ближайшей выкладки.

Существующая инфраструктура — действующий публичный HTTPS-сайт (открыт 17.11.2026). Backend workflow `Deploy staging` запускается вручную и собирает одну пару frontend/backend в одном образе. Push, PR и обновление frontend сами ничего не выкладывают. Название workflow и environment `staging` сохранено исторически. Обновление приложения сохраняет действующую политику доступа. Текущий статус площадки — [backend publication.md](../../endless-drawing-backend/docs/publication.md), операционные команды — [deployment.md](../../endless-drawing-backend/docs/deployment.md).

1. Зафиксировать и проверить оба repository commits; передавать workflow точный frontend SHA, сохранять оба SHA в release metadata. Backend и frontend должны включать совместимые v1/v2/v3 контракты и общий fixture corpus.
2. Проверить актуальный серверный Compose обычным deployment-процессом: он должен передавать `WS_MSGPACK_ENABLED` и `WS_MANIFEST_ENABLED`. Локальная правка Compose не меняет файл на VPS. Новые DB migrations и runtime credentials для M1/M2 не нужны.
3. Выполнить CI, полный public/admin browser gate и сборку образа. Функциональные mocks не заменяют real backend/DB gate. Затем пройти проверки environment `staging` (включая approval, если он настроен) и активировать immutable image обычным helper с pre-deploy backup/readiness/rollback.
4. На действующем HTTPS-сайте проверить выбранный subprotocol v3, первый full snapshot, pan/повторную область без повторной geometry, live create/delete/hide, reconnect, реальные Safari iPhone/iPad и сеть с задержкой. Не публиковать реальные secret-bearing hello captures.
5. При проблеме M2 выключить выбор v3 (`WS_MANIFEST_ENABLED=false`) для новых соединений, оставив v2. При проблеме M1 выключить оба binary профиля (`WS_MSGPACK_ENABLED=false`): новый клиент предложит JSON v1. Открытый сокет меняет формат только после reconnect. Откат на старый backend без subprotocol требует учитывать уже открытые новые вкладки; предпочтителен dual-profile/v3-aware rollback образ.

После успешных CI gates существующий workflow выкладывает M1+M2 на действующий HTTPS-сайт. Пара SHA сохраняется в release metadata; завершение workflow и readiness проверяются отдельно.

## Подтверждённая выкладка 18.11.2026

- Backend: `3bdb9887e7e2c8bf93e3542610f6c1a739a7a19b`; frontend кода в образе: `eb531f071d5e90fcd757b914a28bd5950c360a09`. Образ: `endlessdrawing-app:3bdb9887e7e2c8bf93e3542610f6c1a739a7a19b-44320255728-1`. Последующая правка этой документации не меняет приложение в образе.
- Обычный Backend CI и release verify/build/deploy завершились успешно. В release проверены реальные HTTPS admin и public Chromium/Firefox/WebKit, контейнер, backup recovery и Caddy.
- Серверный Compose обновлён только двумя переменными протокола, с проверкой SHA-256 исходной версии. Runtime credentials, DB schema и правила доступа не менялись; штатный preflight прошёл. Предыдущий образ сохранён: `endlessdrawing-app:4103b38d946b4ea53de29a6b6aeedbe5dd0aaa59-44298629102-1`.
- Внешний HTTPS: `/readyz` → 200 ready; public/admin HTML → 200; хеши всех JS/CSS, указанных обоими entry, совпали с локальной сборкой; admin session без cookie → 401.
- Read-only WSS: v3/v2/explicit JSON и legacy JSON приняты. Одна и та же область: 34 штриха / 4757 точек; JSON 192317 bytes, MessagePack 94883 bytes. Два повторных v3 snapshot: по 1910 bytes manifest/control, **0 geometry chunks / 0 переданных точек**. Штрихи не создавались и не удалялись. Это размеры application payload конкретной области без TLS/TCP/WS overhead, не универсальный коэффициент и не browser latency benchmark.

## Обновление спрея, 18.11.2026

Максимальный диаметр частиц уменьшен до 1 world unit (1 CSS px при 100%) для всех штрихов по решению владельца, без legacy-ветки. [Actions 44325301431](https://github.com/maxeliseyev/endlessdrawing-backend/actions/runs/44325301431) завершился успешно: verify/build/deploy, реальные HTTPS admin/public browser, image/backup/Caddy gates.

- Frontend кода: `1e6eef298a1bdc775fe62063bd4ee972290c0971`; backend прежний `3bdb9887e7e2c8bf93e3542610f6c1a739a7a19b`. Локально прошли check/build, 213 unit и 205 E2E в Chromium/Firefox/WebKit (2 CDP-only skips).
- Активный образ: `endlessdrawing-app:3bdb9887e7e2c8bf93e3542610f6c1a739a7a19b-44325301431-1`; сохранённый образ отката: `endlessdrawing-app:3bdb9887e7e2c8bf93e3542610f6c1a739a7a19b-44320255728-1`.
- Внешний HTTPS: readyz 200 ready, public/admin HTML и все указанные ими JS/CSS сверены по хешам с локальной сборкой; admin session без cookie — 401. WSS v3/v2/explicit JSON/legacy JSON работают. В текущей выборке 23 штриха / 1996 точек: два повторных v3 snapshot передали по 1492 bytes control и 0 geometry. Это другая область, не сравнение производительности с предыдущей выборкой; проверка была read-only.
- Следующий выбранный владельцем этап — [M3: видимая область раньше запаса](transport-v2-design.md#6-m3-сначала-видимая-область). План зафиксирован отдельно; M3 в этот образ не входит.
