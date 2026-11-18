# Проект изменений транспорта и загрузки областей

Статус на 18.11.2026: M1 реализован локально в frontend и подготовлен/проверен в backend. Wire-контракт перенесён в [backend MessagePack v2](../../endless-drawing-backend/docs/protocol-v2-msgpack.md). M2 реализован локально с отдельным v3-контрактом; M3 остаётся проектом. Production-выкладка, HTTPS и реальные iPhone/iPad не выполнены.

## 1. Последовательность и границы

| Этап | Результат | Что измеряем |
| --- | --- | --- |
| M1: бинарный профиль | MessagePack для всех WS-сообщений, dual-profile server/client, прежняя snapshot semantics | Bytes, encode/decode CPU, first paint, совместимость |
| M2: повторное использование геометрии | Авторитетный manifest области и передача только отсутствующих у клиента strokes | Повторные geometry bytes, память manifest, гонки deletes/hide |
| M3: видимое раньше запаса | Приоритет геометрии видимой области внутри того же согласованного снимка | Subscribe→first visible paint, время полной загрузки |

M1 можно проверить и откатить независимо от смены snapshot state machine. Работа над M2 обязательна в плане оптимизации загрузки: завершение M1 не означает устранение повторных snapshot. Сжатие — отдельный эксперимент после M1, не зависимость M2. Renderer, продуктовый UI, Storage и геометрия кистей не меняются ради новой сериализации.

## 2. M1: граница кодека на клиенте

Поток: WebSocket message → проверка профиля/byte limit → ограниченный decode → существующие runtime guards → SharedWorld / ReadOnlyWorld → scene → renderer.

Новый модуль `src/transport/codec.ts` должен владеть именами subprotocol, выбранной версией, `encode`/`decode` и byte limits. На вход decode — `unknown`, на выход — проверенный top-level record; application guards `parseStroke` продолжают проверять поля. Не смешивать negotiation и reconnect policy с pure decoder. Реализованный интерфейс кодека: `protocolVersion`, `encode(message): string | Uint8Array`, `decode(data: unknown): Record<string, unknown>`. Размер считается по фактическому encoded payload.

Отдельный `src/transport/msgpack.ts` оборачивает библиотеку и structural budget. Используется `@msgpack/msgpack 3.1.3`; существующий TypeScript target ES2022 не менялся. Общий chunk с кодеком/зависимостями после сборки около 38 KiB (gzip около 12.6 KiB); JSON/MessagePack interop проверяется pinned fixtures. `forceFloat32` выключен, BigInt не выходит в domain. Библиотечные max lengths не заменяют общий node/depth budget, запрет duplicate keys и проверку unsafe integers до округления в JS number. Если библиотека не предоставляет необходимых hooks, небольшой bounded structural preflight перед decode проверяет headers, map keys и 64-bit integer range; это gate M1, не новый самописный MessagePack encoder.

| Файл | Планируемое изменение |
| --- | --- |
| `src/world.ts` | Socket factory принимает protocols; сразу выставляет binaryType. В onopen выбирает codec по socket.protocol. Все send/receive идут через него, ack version берётся из профиля. Guards старого сокета, outbox и deadlines сохраняются |
| `src/admin/world.ts` | Тот же codec и negotiation; прежние RAM secret, read-only команды и очистка при stop/auth expiry |
| `src/wire.ts` | Остаётся codec-independent runtime validation. Нормализация/freeze завершённых points сохраняется |
| `src/model.ts`, `src/main.ts` | Аудит `fitsCreateMessage`: не оценивать binary bytes как JSON string length. На M1 сохранить консервативную JSON-проверку для офлайн draft/возможного JSON fallback и дополнительно проверять фактический выбранный encoding перед send; не расслаблять лимиты точек |
| `tests/unit/world.test.ts`, admin transport tests | FakeSocket учитывает offered/selected protocols, binaryType, string/Uint8Array payload и fake handshake |
| `tests/e2e/support/world.ts`, admin WS mock | Двойник умеет выбранный профиль, а не `String(binary)` → JSON.parse. Оставить сценарии legacy JSON и добавить binary/mixed profile |
| `tests/integration/backend.spec.ts` | Собирать и декодировать Text/Binary frame payload в semantic messages; readiness/ack проверять по типам, убрать JSON substring assumptions |

Никакого decode-пропуска в тестовом окружении. Та же проверка, которая будет в браузере, принимает golden fixtures. Конфликтующие byte limits public (сейчас 4 MiB) и admin (1 MiB) заменить общим v2 256 KiB hard limit; legacy лимиты пересматривать отдельно, не ломая v1 под видом codec refactor.

Проверять deadline на `snapshot.end` даже при повторном snapshot без новых рисуемых id. В текущем public flow очистка зависит от результата `scene.accept`; новые tests должны сохранять корректность на пустом и полностью перекрывающемся снимке, включая snapshot, прерванный новым subscribe.

## 3. M1: серверный codec boundary

Это карта M1-изменений в `/Users/maximeliseyev/Code/endless-drawing-backend`. Сначала они подготовлены и проверены в изолированной копии, затем переносятся в основной репозиторий без изменения БД/production. Применяется существующий Rust skill; перед редактированием учитывать инструкции backend-репозитория.

| Файл backend | Планируемое изменение |
| --- | --- |
| `src/ws.rs` | Проверка offer/выбор subprotocol до upgrade; один enum профиля на connection; decode Text/Binary согласно профилю; единый bounded error path |
| `src/protocol.rs` | Версия ack зависит от connection profile; wire DTO с явным UUID string для MessagePack; domain не превращается в transport DTO |
| Новый codec module | JSON и MessagePack (`rmp-serde` как кандидат), строгий single-value decode, structural limits, safe seq и сериализация maps с именами полей |
| `src/snapshot.rs` | Packing учитывает реально выбранный codec и byte/point/count limits; целевой chunk 64 KiB для v2; queue остаётся ограниченной |
| `src/realtime_settings.rs`, config | Явный server gate выбора v2 для rollout/rollback; новые лимиты согласованы с profile caps, legacy JSON продолжает работать |
| `src/realtime_tests.rs` и codec tests | Dual-profile/mixed clients, real Postgres snapshot/events, malformed binary, stringify UUID, reconnect/retry/idempotency |
| `docs/protocol.md`, новый v2 contract | Перенести согласованный нормативный текст; документы frontend ссылаются на единственный серверный контракт |

Не передавать сериализованный binary вместо typed domain events через writer/DB. Создание, нормализация, idempotency и PostgreSQL остаются прежними. Изменение wire не требует миграции хранимых points. Snapshot сегодня сериализует stroke для расчёта JSON length, затем целое сообщение ещё раз; новый packing должен избегать лишней полной сериализации, но сначала доказать эквивалентность и точный byte limit. Предварительная оценка длины без финальной проверки размера недостаточна.

## 4. Общие fixtures до подключения сокетов

Канонический корпус предлагается хранить в backend `tests/fixtures/ws-v2/`: описание semantic values, `.msgpack` файлы и SHA-256 manifest. Frontend получает неизменяемую копию с revision/hash и source link; CI проверяет соответствие корпуса, не скачивает moving main во время теста. Полноценная спецификация — в backend; фикстуры доступны обеим сторонам.

Положительные fixtures: каждый type/ack/error, отсутствующий spawn, 4 кисти, точка и 2000 points, width/opacity границы, координаты возле ±1e9 с дробной частью, seq возле MAX_SAFE_INTEGER, обе integer/float64 формы точного целого, lowercase UUID и normalization. Negative fixtures: текст вместо binary, trailing object, truncated map/array/float, integer вне safe range, float32 output regression, bin UUID, ext, duplicate/non-string/опасные map keys, огромные length headers и глубина.

Сначала TS encoder → Rust decoder и Rust encoder → TS decoder. Отдельно semantic equality с JSON v1. Проверка только encode→decode одной библиотекой не доказывает совместимость двух клиентов. Секреты в fixtures — искусственные, не реальные hello captures.

## 5. M2: manifest вместо повторной геометрии — реализовано локально

Нормативный wire-контракт — только [backend protocol-v3-manifest.md](../../endless-drawing-backend/docs/protocol-v3-manifest.md). Предпочитается отдельный subprotocol v3 с откатом на v2/JSON. Первый вход/reconnect/resync сохраняют полный snapshot, повторная область на том же соединении получает авторитетное membership и запрашивает только отсутствующую geometry.

`src/transport/manifest.ts` управляет membership, token, ограниченными stop-and-wait batches и проверкой полноты. `SharedScene.retain` / `AdminScene.retain` помещают в staging существующие immutable objects напрямую, сохраняя renderer cache identity. Новый snapshot не снимает старые strokes до end. Admin сохраняет текущий кеш при смене области; stop/auth expiry очищает и scene, и manifest state.

На сервере `src/manifest.rs` получает membership из согласованного DB snapshot, читая id/seq/point_count без передачи points из PostgreSQL. Read transaction закрывается до ожидания клиента. Недостающая geometry читается ограниченными pages из неизменяемых rows, включая soft-deleted строки — membership относится к старой DB-границе, delete/hide event следует после end. Исчезновение строки/смена seq требует resync; новый механизм редактирования points обязан пересмотреть этот контракт.

Сервер хранит только bounded metadata/requested UUID и ограничивает число одновременных cached snapshots. Busy admission или чрезмерная плотность дают явный fallback, а не неполное membership. Публичный клиент начинает full snapshot; admin при scene limit использует существующее завершение с ошибкой лимита. Общие byte/node/scene limits не расширялись.

Клиент сверяет actual cache, не полагается на серверное «уже отправляли». Отсутствующие UUID снимаются на authoritative end; известный tombstone запрещает повторный показ поздней geometry. Own ack после subscribe сохраняется даже до snapshot.begin. Подмена UUID/token/batch, отменённая подписка, незавершённый staging, physical purge и переполнение live event ring проверяются отдельно.

Приёмка: общие Rust/TS fixtures `tests/fixtures/ws-v3`; unit-тесты cache identity, ack/hide races и stop-and-wait >1000 ids; PostgreSQL/WS tests warm/partial cache, soft delete, scope, busy/timeout/cancellation, dense limits, pool release и resync. Реальный browser integration в трёх движках создаёт stroke вне старой подписки, затем проверяет догрузку только этого stroke при overlap и 0 geometry chunks при тёплом возврате. Manifest/control traffic сохраняется. Cold-cache RTT M1 не меняется.

## 6. M3: сначала видимая область

Для следующего расширения после v3 рассмотреть отдельные `visible_bounds` внутри subscription bounds. Проверять вложенность/диапазон на сервере. Видимые geometry отправлять первыми в рамках одного согласованного снимка, затем prefetch. Не запрашивать сначала маленькую полную подписку, а затем большую полную: это добавит лишнюю повторную загрузку.

В M1 остаётся v1 порядок chunks по seq. Приоритет M3 меняет порядок поступления geometry, но порядок композиции всегда seq; вставка более старого штриха инвалидирует только затронутые tiles. Для большого stroke достаточно bounds intersection, не дорогой проверки каждого пикселя. Критерий — время первого реально видимого paint, а не первый chunk, который мог содержать только offscreen geometry. Cold-cache первый ответ с видимой geometry без manifest round trip — отдельный вариант для benchmark перед выбором окончательного wire.

## 7. Измерения и приёмка

Фиксированный синтетический корпус с seed/хешем: sparse, плотные перекрывающиеся round/square, длинные chisel, плотный spray. Одни и те же world data и camera path; 16%, 100%, 400%; DPR 1/2. Отдельно первый вход, повтор области, pan на 0.55 экрана, zoom-out, reconnect и пустая область. Production captures не коммитить; корпуса не содержат session secrets.

Локально и на staging записывать aggregate timings/counts/bytes без payload: handshake; subscribe→first chunk; manifest/fetch round trips для M2; decode/validate; geometry preparation; first visible paint; snapshot.end; p50/p95; peak scene/staging/GPU memory. Отдельно encode/DB/server-send и network, если доступна серверная instrumentation. Отсчёт network bytes в DevTools не заменяет application counters, а snapshot.end не равен последнему paint.

Команды frontend: `npm run check`, `npm test`, `npm run build`; для транспортных изменений — `npm run test:integration` с реальным backend; binary browser/palette/canvas regressions — `npm run test:e2e:all`. Серверный этап: fmt, clippy, tests по его инструкциям, PostgreSQL/WS tests и mixed clients. HTTPS/WSS, реальный Safari на iPhone/iPad и slow WAN — отдельные gates, их нельзя заменять synthetic PointerEvent или одним CLI snapshot.

## 8. Первый пакет реализации

Начать с fixtures и pure codecs, сохраняя текущий production entry на JSON до готовности сервера. Затем dual-profile backend, затем public/read-only admin frontend, обновлённые mocks и integration harness. После паритета и baseline включить v2 на staging. M1+M2 прошли локальную приёмку; следующий release gate — согласованная пара commit SHA и CI для обновления действующего HTTPS-сайта. M3 остаётся отдельным будущим изменением; full performance/device baseline остаётся отдельной проверкой.

## 9. Выявленная при интеграции регрессия WebGL

На больших абсолютных координатах thin strokes отсутствовали у Firefox/WebKit при исправных WS-сообщениях. Контрольный JSON v1 воспроизвёл ту же проблему, Canvas 2D прошёл; на небольших координатах WebGL проходил. Для uniform stroke-pass разность origin/camera теперь считается в JS float64 до отправки в shader, который получает относительные float32 hi/lo pairs. Геометрия/тайлы/порядок seq не меняются. Добавлен браузерный сценарий round/chisel/spray в двух вкладках на `(64223135, 91962556)` и `(-999000000, 999000000)`. Это точечная правка точности, не новый этап renderer.
