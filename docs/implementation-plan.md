# План реализации

## 1. Принятые решения фронтенда

- Отдельный frontend-репозиторий; Vite-приложение в его корне. Соседний Rust-пакет не переносится.
- Vite + TypeScript + Canvas 2D, npm. Без фреймворка и платных сервисов.
- Продуктовые принципы, имя Endless Drawing, endlessdrawing.com, фраза и референсы: [product.md](product.md).
- i18n с первого этапа: типизированные EN/RU словари в `src/i18n.ts`; первый поддерживаемый язык из `navigator.languages`, fallback `navigator.language` при пустом списке, затем английский. Региональные теги сопоставляются по базовому языку. Язык выбирается при загрузке без Storage, отдельного экрана и постоянного переключателя; бренд/фраза не переводятся.
- Начальная кисть: round / #202020 / 6 / 1. Переключение инструмента её не сбрасывает.
- Ластик: допуск 4 CSS px; линия hit-test использует тот же Canvas path и стили, ширина увеличена на 8px. Это небольшой консервативный допуск для square-концов/скосов.
- Wheel: pixel как есть, line = 16 CSS px, page = размер viewport по соответствующей оси. Масштаб всегда 1.
- Предлагаемые renderer-стили приняты **в локальном прототипе**: round/round и square/bevel, отдельная точка circle/axis-aligned square, один stroke()/fill() с общей opacity.
- Preview использует тот же renderer. Минимальная дистанция между samples 0.75 world units; при 2000 точках прореживаем полный путь, сохраняя начало/конец, затем продолжаем ввод. Это ограниченный прототипный алгоритм: повторное прореживание может сглаживать длинный детальный жест, требуется визуальная проверка перед релизом.
- Лимит локального прототипа: 500 completed drafts в памяти, без тихого вытеснения; переполнение/oversize дают кратковременную ошибку. Ограничение кеша общего мира будет отдельным.
- Escape / pointercancel / lost capture / blur / hidden / resize отменяют незаконченный жест. При отмене панорамирования возвращаем начальную камеру; wheel отменяет текущий жест перед панорамированием.

## 2. Открыто перед интеграцией

Это вопросы из backend docs, а не блокеры для локальной геометрии. Ответы команды ещё не получены.

1. **Принять точный JSON v1:** hello.ack, поля ack/error, повтор delete, resync_required, нормализацию цвета, safe integer seq и chunking. В `../endless-drawing-backend/docs/protocol.md` эти детали всё ещё предложения. Следующий шаг — типы + общие fixtures для mock/сервера, не два расходящихся контракта.
2. **Геометрия:** подтвердить Canvas square/bevel и bounds square `width / sqrt(2) + 1`, round `width / 2 + epsilon`. Проверить толстые наклонные концы на границе подписки.
3. **Dev/prod:** выбрать backend-порт, Origin allowlist для http://127.0.0.1:5173 / localhost, путь к frontend `dist/`, способ доставки артефакта между репозиториями. Временный proxy target — http://127.0.0.1:3000, override `BACKEND_DEV_URL`. Production — https://endlessdrawing.com, WSS `/ws`; конфигурация backend/TLS ещё не сделана.
4. **Лимиты, влияющие на UX:** максимальные размеры подписки (prefetch = 3× viewport), длина/протяжённость штриха, частота delete/subscribe, rate-limit burst, heartbeat/таймауты, очереди и chunk bytes. 2000 points / 128KiB / 5 create/sec взяты из ТЗ; окончательный сервер может быть конфигурируемым.
5. **Публичный запуск:** политика модерации/хранения/backup — решение владельца и backend/DevOps. Фраза проекта сама по себе не определяет SLA хранения.

## 3. Этапы

### A. Основа и локальное взаимодействие — текущая итерация

- [x] Бренд, принципы и SVG-референсы, AGENTS.md.
- [x] Vite/strict TS, белый canvas без стартовых overlays.
- [x] CSS/world координаты, случайная начальная камера ±250, sessionStorage, DPR/resize.
- [x] Локальный preview, одиночный клик, round/square, цвет/толщина/opacity, отмена жестов.
- [x] Компактная контекстная палитра, клавиатура, focus, границы окна, localStorage настроек.
- [x] Рука, Space+drag, средняя кнопка, двухосевой wheel без зума.
- [x] Прототипные локальные ластик/undo — только ephemeral drafts этой страницы, не серверная авторизация/undo.
- [x] Английский и русский по настройкам браузера, региональные теги и порядок предпочтений, fallback EN, локализованные aria-label/ошибки/подсказки, `html.lang` и Intl-формат процентов.
- [x] TypeScript + production build, 41 unit-тест, 57 E2E (19 сценариев × Chromium/Firefox/WebKit на macOS). Проверены чистый старт без overlays, metadata, preview/отмена, палитра/Tab/focus, настройки/reload, панорамирование, локальные ластик/undo, opacity/self-intersection, hit-test, resize, DPR=2, заблокированный Storage и локализация EN/RU/unsupported locales.
- [ ] Финальная ручная визуальная приёмка длинных детальных жестов и реальных desktop-браузеров, включая нижние поддерживаемые версии.

### B. Транспорт и состояние — следующая итерация

- [ ] Типизированные сообщения и runtime-валидация входящего JSON.
- [ ] Transport interface + детерминированный mock WS: hello, chunks, ack/error, create/delete, сбои и повторы.
- [ ] Web Crypto 32-byte session secret, base64url, sessionStorage; hello без утечек.
- [ ] Preview / pending / confirmed разделены; подтверждения по request_id; dedup по UUID.
- [ ] Snapshot staging → атомарная замена на end; subscription_id; события/ack во время snapshot.
- [ ] Ограниченный viewport-кеш и prefetch, throttle подписок.
- [ ] Сессионный undo независимо от кеша, только подтверждённые создания; ownership и seq для ластика.
- [ ] Reconnect с backoff, новый hello/snapshot, resync, повтор идентичного create без дублей.

### C. Backend и совместная приёмка

- [ ] Реальный `/ws`, раздача `dist/`, согласование proxy/origins.
- [ ] E2E с двумя независимыми контекстами: создание/чужое удаление/собственное удаление/reload.
- [ ] Гонки snapshot/create/delete, disconnect до ack, повтор UUID, старые подписки, rate limits.
- [ ] Chromium + Firefox + WebKit, одинаковая композиция и thick-stroke bounds.

Локальный прототип **не является** завершённым MVP, общим миром или системой постоянного хранения. В `sessionStorage` сейчас только камера, в `localStorage` — инструмент/кисть; геометрия и локальный undo исчезают при reload. Секрет и постоянный undo будут добавлены вместе с транспортом, не заранее без работающего backend-пути.
