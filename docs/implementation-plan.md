# План реализации

## 1. Принятые решения фронтенда

- Отдельный frontend-репозиторий; Vite-приложение в его корне. Соседний Rust-пакет не переносится.
- Vite + TypeScript + Canvas 2D, npm. Без фреймворка и платных сервисов.
- Продуктовые принципы, имя Endless Drawing, endlessdrawing.com, фраза и референсы: [product.md](product.md).
- i18n с первого этапа: типизированные EN/RU словари в `src/i18n.ts`; первый поддерживаемый язык из `navigator.languages`, fallback `navigator.language` при пустом списке, затем английский. Региональные теги сопоставляются по базовому языку. Язык выбирается при загрузке без Storage, отдельного экрана и постоянного переключателя; бренд/фраза не переводятся.
- Начальная кисть: round / #202020 / 6 / 1. Переключение инструмента её не сбрасывает.
- Ластик: допуск 4 CSS px; линия hit-test использует тот же Canvas path и стили, ширина увеличена на 8px. Это небольшой консервативный допуск для square-концов/скосов.
- Wheel: pixel как есть, line = 16 CSS px, page = размер viewport по соответствующей оси; с Ctrl/⌘ — зум (см. этап Z).
- Общий renderer: round/round, square/bevel, chisel (фиксированный плоский наконечник -45°) и spray (distance sampling, seed из lowercase UUID). Общая opacity за один stroke/fill; preview/ластик используют ту же геометрию. Enum и bounds приняты backend: [brushes.md](brushes.md).
- Preview использует тот же renderer. Минимальная дистанция между samples 0.75 world units; при 2000 точках прореживаем полный путь, сохраняя начало/конец, затем продолжаем ввод. Это ограниченный прототипный алгоритм: повторное прореживание может сглаживать длинный детальный жест, требуется визуальная проверка перед релизом.
- Кеш общего мира ограничен 20 000 штрихов / 1 000 000 точек, неподтверждённых — 64; переполнение/oversize дают кратковременное сообщение.
- Escape / pointercancel / lost capture / blur / hidden / resize отменяют незаконченный жест. При отмене панорамирования возвращаем начальную камеру; wheel отменяет текущий жест перед панорамированием.

## 2. Открыто перед интеграцией

Ниже — вопросы интеграции. Часть уже конкретизирована в backend docs: реализованный профиль WS v1 и admin-api.md. Read-only admin-клиент использует эти формы; совместная приёмка с настоящим backend/HTTPS и публичное серверное рисование остаются отдельными gates.

1. **Принять точный JSON v1:** hello.ack, поля ack/error, повтор delete, resync_required, нормализацию цвета, safe integer seq и chunking. В `../endless-drawing-backend/docs/protocol.md` эти детали всё ещё предложения. Следующий шаг — типы + общие fixtures для mock/сервера, не два расходящихся контракта.
2. **Геометрия:** подтвердить Canvas square/bevel и bounds square `width / sqrt(2) + 1`, round `width / 2 + epsilon`. Проверить толстые наклонные концы на границе подписки.
3. **Dev/prod:** выбрать backend-порт, Origin allowlist для http://127.0.0.1:5173 / localhost, путь к frontend `dist/`, способ доставки артефакта между репозиториями. Временный proxy target — http://127.0.0.1:3000, override `BACKEND_DEV_URL`. Production — https://endlessdrawing.com, WSS `/ws`; конфигурация backend/TLS ещё не сделана.
4. **Лимиты, влияющие на UX:** максимальные размеры подписки (prefetch = 3× viewport), длина/протяжённость штриха, частота delete/subscribe, rate-limit burst, heartbeat/таймауты, очереди и chunk bytes. 2000 points / 128KiB / 5 create/sec взяты из ТЗ; окончательный сервер может быть конфигурируемым.
5. **Публичный запуск:** политика модерации/хранения/backup — решение владельца и backend/DevOps. Фраза проекта сама по себе не определяет SLA хранения.
6. **Вход администратора:** backend передал `../endless-drawing-backend/docs/admin-api.md` — единственный источник wire-форм и статуса готовности. Пароль + WebAuthn passkey с UV required (policy `passkey_uv`), pre-auth/full cookies, CSRF в памяти, атомарный batch до 100 UUID и проверка operation при потере ответа уже описаны там. По решению владельца Touch ID/platform/synced passkeys разрешены, аттестация/CA trust store не требуются. Реальный backend/fixtures, Touch ID, резервный credential и cross-browser enrollment/login пока требуют совместной проверки. UI, enrollment двух credentials и HTTP/WS-клиенты реализованы, проверены mock E2E; есть native Chromium WebAuthn тест с виртуальными UV authenticators. Настоящий HTTPS provisioning/Touch ID ещё не выполнен: наличие UI не включает admin на VPS. Инструкция — [admin-frontend.md](admin-frontend.md). Продуктовые требования: [moderation.md](moderation.md).
7. **Новые кисти:** принять `chisel`/`spray` в enum, DB CHECK, snapshot/create и bounds на backend; общие fixtures и геометрический контракт — [brushes.md](brushes.md). Backend в этой итерации не менять параллельно административной работе владельца.

## 3. Этапы

### A. Основа и локальное взаимодействие — текущая итерация

- [x] Бренд, принципы и SVG-референсы, AGENTS.md; favicon пользователя в `public/favicon.png`, оригинал в `docs/design/favicon-source.png`.
- [x] Vite/strict TS, белый canvas без стартовых overlays.
- [x] CSS/world координаты, случайная начальная камера ±250, sessionStorage, DPR/resize.
- [x] Локальный preview, одиночный клик, round/square/chisel/spray, цвет/толщина/opacity, отмена жестов; формы доступны в EN/RU и восстанавливаются из Storage.
- [x] Компактная контекстная палитра, клавиатура, focus, границы окна, localStorage настроек.
- [x] Рука, Space+drag, средняя кнопка, двухосевой wheel без зума.
- [x] Прототипные локальные ластик/undo — только ephemeral drafts этой страницы, не серверная авторизация/undo.
- [x] Английский и русский по настройкам браузера, региональные теги и порядок предпочтений, fallback EN, локализованные aria-label/ошибки/подсказки, `html.lang` и Intl-формат процентов.
- [x] TypeScript + production build, 63 unit-теста, 75 E2E (25 сценариев × Chromium/Firefox/WebKit на macOS). Проверены чистый старт без overlays, metadata, preview/отмена, палитра/Tab/focus, настройки/reload, панорамирование, локальные ластик/undo, opacity/self-intersection, hit-test, resize, DPR=2, заблокированный Storage и локализация EN/RU/unsupported locales, favicon, новые формы/детерминизм/opacity/hit-test.
- [ ] Финальная ручная визуальная приёмка длинных детальных жестов и реальных desktop-браузеров, включая нижние поддерживаемые версии.

### B. Публичный транспорт и состояние — сделано (16.11.2026)

- [x] Типизированные сообщения и runtime-валидация входящего JSON (`src/wire.ts`, общая с admin).
- [x] Transport (`src/world.ts`) + детерминированный WS-двойник для E2E (`tests/e2e/support/world.ts`) и unit-тесты с фейковым сокетом: hello, chunks, ack/error, create/delete, сбои, повторы, rate limit, ack timeout.
- [x] Web Crypto 32-byte session secret, base64url, sessionStorage; hello без утечек (не в URL/логах/stroke).
- [x] Preview / pending / confirmed разделены; подтверждения по request_id; dedup по UUID.
- [x] Snapshot staging → атомарная замена на end; subscription_id; own ack во время staging не теряется. Chunks рисуются сразу, прерванный staging не мигает.
- [x] Ограниченный кеш (20k/1M) и prefetch 3× со сдвигом по направлению pan и ранней переподпиской, throttle подписок, cap 30000.
- [x] Граница рендер-бэкенда `SceneRenderer` и отдельный контекст хит-теста — подготовка к WebGL ([webgl.md](webgl.md)); сам WebGL не реализован.
- [x] Растровый кеш тайлов (`src/tiles.ts`): бюджет на кадр, fallback растянутым масштабом, prefetch кольца, √2-уровни во время зума, инкрементальная дорисовка, LRU и прямой рендер при нехватке памяти. Бенчмарк mock (4000 перекрывающихся штрихов, 1280×800): pan Chromium p95 200 → 17 мс.
- [x] Сессионный undo (sessionStorage) независимо от кеша, только подтверждённые; undo pending — до/после ack; ластик только own, максимальный seq.
- [x] Reconnect с backoff, новый hello/snapshot, resync, повтор идентичного create без дублей.

- [x] Точка входа новой сессии из `hello.ack.spawn` (случайный живой штрих ± 400 world units, backend `src/spawn.rs`): по мере расползания рисунка посетители стартуют всё дальше от центра.
- [ ] Бэклог: сохранить выделенную область в SVG — [export-svg-backlog.md](export-svg-backlog.md).

### C. Backend и совместная приёмка

- [x] Реальный `/ws`, раздача `dist/` backend-ом, origins по умолчанию для 5173/3000.
- [x] `npm run test:integration`: два независимых контекста против реального backend+PostgreSQL — создание, чужое удаление запрещено, reload/ownership, undo у всех, `chisel`/`spray`. Chromium + Firefox + WebKit.
- [ ] Гонки snapshot/create/delete и disconnect до ack с реальным сервером (сейчас — unit/mock E2E; серверная сторона покрыта backend-тестами).
- [ ] Визуальная сверка thick-stroke bounds на краю подписки в трёх движках, нагрузка плотных сцен на реальных устройствах (особенно spray при 16%, память тайлов на iPhone/iPad). Повторная пересылка перекрывающейся области при каждой переподписке остаётся ограничением протокола v1 (нет инкрементальной подписки).
- [ ] HTTPS/WSS стенд, production Origin.

### Z. Ограниченный зум — сделано (16.11.2026, решение владельца)

- [x] `zoom ∈ [0.16, 4]` (до 17.11.2026 — 0.25): Ctrl/⌘+wheel и pinch трекпада вокруг курсора, Safari GestureEvent, Ctrl/⌘ `=`/`-`/`0`, кнопки в палитре, pinch двумя пальцами.
- [x] Ширина в world units, допуск ластика 4 CSS px на экране; effect-геометрия масштабируется без потери точности на больших координатах.
- [x] Подписка в world units, ≤ `VIEWPORT_MAX_SPAN`; камера с zoom в sessionStorage. Admin остаётся на 1×.

### D. Закрытая модерация — обязательно до публичного запуска

- [x] Зафиксированы требование входа, отсутствие публичных элементов администратора, логин/сложный пароль + FIDO2, отдельная серверная авторизация/аудит: [moderation.md](moderation.md).
- [x] Отдельный typed client/runtime guards и WebAuthn/base64url adapters по backend `docs/admin-api.md`, cookie same-origin/no-store, CSRF только RAM, UV required, безопасные ошибки и Retry-After.
- [ ] Проверить backend auth: Argon2id, WebAuthn challenge/verify, closed enrollment двух ключей/recovery, rate limits, cookie/CSRF, logout/expiry/revocation. Учесть policy `passkey_uv`: UV обязателен, platform/synced passkeys разрешены, password-only fallback запрещён; один iCloud credential на нескольких устройствах не считать двумя независимыми регистрациями.
- [x] Frontend hide по атомарному API: immutable operation_id/payload, UUID/причина/подтверждение, валидация полного результата, check operation/явный идентичный retry, никакого успеха по одному WS-событию или автоповтора после re-login. Серверный аудит/commit/broadcast проверяются совместно.
- [x] Отдельный `/admin/` entry EN/RU: пароль → passkey → verify, closed enrollment двух credentials → новый login, real read-only WS-клиент, выделение нескольких штрихов кликами, подтверждение/причина, 401/expiry/logout. Никакого локального admin-флага или mock-кода в production.
- [x] Ограниченная authoritative scene, multi-chunk snapshot, старые subscription_id, tombstones после hide, resync/reconnect/backoff/deadlines, общий renderer/DPR; public entry не импортирует admin.
- [x] 97 unit-тестов; 127 E2E passed, 2 CDP-only skips в Firefox/WebKit. Admin HTTP/WS E2E — mocks; отдельный Chromium native WebAuthn с двумя virtual UV authenticators, не настоящий Touch ID.
- [x] Multi-entry build `dist/admin/index.html`, favicon/assets, noindex metadata и dev/preview privacy headers. Публичный import graph и отсутствие API/session checks проверяются тестами.
- [ ] Совместная production-раздача целого dist через backend, no-store/noindex/CSP/anti-framing на HTTPS; реальный Touch ID, резервный провайдер и cookies/Origin/CSRF.
- [ ] Интеграционные проверки обоих факторов/запретов/CSRF/отзыва/аудита и два публичных контекста: скрытое исчезает у всех, не возвращается после snapshot/reload/повтора create.
- [ ] Согласовать правила модерации и хранения с владельцем, подготовить закрытую инструкцию администратора и восстановления доступа.

### E. Touch, Apple Pencil, iPhone/iPad — реализовано, ждёт проверки на устройствах

- [x] State machine mouse/pen/touch, pinch из двух pointerId, `blocked` после pinch/long press. Спецификация и числа — [tablet-input-backlog.md](tablet-input-backlog.md).
- [x] Перо рисует; после первого pen-события пальцы только навигируют; палец во время штриха пером игнорируется.
- [x] Второй палец отменяет незавершённый штрих без отправки; оставшийся палец не рисует.
- [x] Long press 500 мс / 10 px открывает палитру и отбрасывает точку; touch-ластик — по тапу/движению.
- [x] Undo и масштаб внутри палитры, цели ≥44 px, HEX 16 px, bottom sheet на телефоне, safe area, viewport-fit=cover, подавление нативных жестов/callout только на холсте.
- [ ] Приёмка на реальных iPhone/iPad (+ Apple Pencil): palm rejection, системные жесты, клавиатура iOS, ориентация, фон/возврат.

Публичный холст — общий мир через backend. Это ещё не публичный запуск: нужны HTTPS-стенд, модерация на VPS (этап D), ограничения по IP, бэкапы, нагрузочный тест и приёмка на реальных устройствах.
