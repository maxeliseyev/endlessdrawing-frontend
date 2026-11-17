# Административный frontend

## Что реализовано

Отдельный Vite entry `admin/index.html` → `src/admin/main.ts`, URL `/admin/`. Публичный `/` не импортирует admin-код, не проверяет административную сессию и не содержит ссылок/пунктов входа. Обе части используют общий renderer, camera и модель штрихов; сборщик может вынести эти общие функции в shared asset, но административные API/формы не входят в публичный import graph.

**UI и транспорт реализованы; совместная production/HTTPS/Touch ID приёмка ещё не выполнена.** Наличие интерфейса не означает, что admin включён на сервере на VPS. Публичный `/` уже подключён к `/ws` (общий мир, см. README).

Единственный wire-контракт — `../endless-drawing-backend/docs/admin-api.md` (от корня frontend). В этой документации не вводятся альтернативные payload. Backend не изменялся.

## Запуск и сборка

```sh
npm ci
npm run dev
# Открыть вручную http://127.0.0.1:5173/admin/
npm run check
npm test
npm run test:e2e:all
npm run build
```

Vite proxy `/api/admin/*`, `/ws`, `/healthz`, `/readyz` направлен на `http://127.0.0.1:3000`, override — `BACKEND_DEV_URL`. Proxy не меняет Origin и не переписывает Secure cookies: для настоящей авторизации нужен настроенный доверенный **HTTPS origin** с совпадающими ADMIN_ORIGIN / RP ID / WS allowlist. HTTP localhost позволяет проверить разметку и тестовые native WebAuthn ceremonies, но не обходит серверные требования HTTPS/Secure cookie.

Сборка выдаёт **оба** HTML: `dist/index.html` и `dist/admin/index.html`, JS/CSS в `dist/assets/`, favicon в `dist/`. Backend уже имеет отдельный обработчик `/admin/`, читающий HTML из static dir. Передать целиком новый `dist/`, а не один admin HTML. Не включать SPA fallback, маскирующий API/неизвестные маршруты публичным index.

В dev/preview: `no-store` для ответов Vite, admin URL дополнительно получает noindex/no-referrer/anti-framing headers. В production эти HTTP-заголовки и CSP обеспечивают backend/reverse proxy: их нельзя гарантировать одним статическим HTML. Не раздавать служебные HTML/API через публичный кеш/CDN/service worker. Admin JS не содержит секретов, но знание URL/JS никогда не является разрешением на API.

## Вход и регистрация

1. При открытии запрашивается полная серверная session. До её валидации нет canvas/инструментов/WS.
2. Без сессии — форма логина и пароля. Login options → пароль → одноразовый challenge → `navigator.credentials.get()` → verify → полная сессия. `mfa_required` сам по себе не открывает модерацию.
3. Режим регистрации открывается только внутри admin entry. Оператор заранее создаёт аккаунт/enrollment token через закрытый серверный CLI по инструкции backend `docs/admin-operations.md`.
4. Ввести login/password/token/label и зарегистрировать passkey. После первой регистрации ввести данные заново для отдельного резервного credential. После второй — **новый обычный вход**. Enrollment никогда не считается административной сессией.
5. Passkey UI не требует аппаратной аттестации или attachment: platform/synced credentials разрешены, UV обязателен. Не обещается fingerprint-only: ОС вправе предложить другую системную проверку. Два credential ID не доказывают независимость резервного провайдера; это проверяет оператор.

ArrayBuffer-поля явно конвертируются в/из base64url; стандартные transports/mediation/extensions сохраняются, включая buffer-поля известных extensions. Не используется `JSON.stringify(browserCredential)` вместо wire-объекта. При отмене/ошибке/истечении challenge вводится пароль заново; нет password-only fallback или автоматического повторения assertion.

Пароль/token очищаются из формы при отправке; при переходах и pagehide формы/состояние уничтожаются. Никаких административных данных в Storage, URL, VITE, телеметрии или console. Сессия живёт только в серверной HttpOnly cookie; CSRF — в памяти admin entry. Во время выполнения JS невозможно обещать криптографическое стирание строк из памяти браузера.

`401`, idle/absolute deadline закрывают инструменты и WS, забывают выделение/операцию. При возврате фокуса сессия перепроверяется. Выход сначала закрывает локальный доступ, затем запрашивает серверный отзыв; при ошибке явно показывает, что logout не подтверждён, и предлагает повтор. Не выдаёт локальное закрытие за успешный серверный отзыв.

## Просмотр и выбор

- Read-only WS v1, один на admin entry. Отдельный анонимный секрет: 32 байта Web Crypto, только RAM и hello, **не** cookie/CSRF/admin-token. Ownership объектов не меняется.
- Hello → ack → подписка по prefetch bounds → begin/chunks/end. Свежая сцена видна после end, старые subscription_id игнорируются, id дедуплицируются, отрисовка по seq.
- Create/delete по WS отсутствуют: служебный просмотр не умеет рисовать и не использует пользовательский ластик. Скрытие — только HTTP API.
- Клик по любому штриху переключает выделение независимо от `own`, при наложении выбирает наибольший seq. Можно набрать до 100 штрихов, снять отдельный UUID из списка или очистить выделение. Прямоугольное выделение пока не добавлено.
- Режим «Перемещение», Space+drag, средняя кнопка и wheel панорамируют. Масштаб фиксирован; zoom/pressure/touch не добавлялись. Новая область сбрасывает выделение, чтобы не скрыть невидимые объекты случайно.
- Reconnect с backoff всегда проходит hello и новый snapshot; resync запрашивает новую подписку, не replay по seq. Есть hello/snapshot deadlines. Неоднократная потеря соединения не создаёт параллельных sockets.
- Геометрия только в RAM текущей области, без history-cache: максимум 20 000 штрихов / 1 000 000 точек; входящий text frame до 1 MiB. При превышении/некорректном потоке соединение останавливается и нет ложной полной сцены; можно переместиться и перезагрузить область. Это защитные client limits, не обещание производительности плотной сцены. Профилирование остаётся перед публичным запуском.

## Скрытие и неопределённый ответ

1. «Проверить скрытие» показывает модальный диалог с точным списком UUID. Нужна непустая причина после trim: максимум 1000 Unicode chars / 4000 UTF-8 bytes.
2. Escape/«Отмена» до подтверждения ничего не отправляет. При изменении сцены/выделения нужна повторная проверка.
3. После явного подтверждения создаётся неизменяемый operation_id/payload; инструменты изменения выделения блокируются. Серверный успех проверяется по operation_id и полному набору возвращённых UUID. Успешное подтверждение снимает геометрию идемпотентно; поздний chunk текущей загрузки не воскрешает скрытое.
4. Network/timeout/503/невалидный success response — **неизвестный исход**, не rollback и не успех. «Проверить результат» делает GET operation; «Повторить ту же операцию» отправляет прежние UUID/reason/operation_id. Автоматических mutation retries нет.
5. Неизвестная operation после GET не доказывает отсутствие commit: остаётся тот же неопределённый исход. При `429` клиент не посылает запросы до Retry-After. При `403`/конфликте/атомарном отказе нет локального обхода или молчаливой замены UUID.
6. После нового входа старая операция не пересылается. Трекинг операции только в RAM: reload/logout теряет локальный payload, но не отменяет возможный серверный commit. Перед уходом при неопределённом исходе проверить результат/сохранить несекретный operation ID для закрытой диагностики. Это не постоянная очередь отложенных удалений.

## Проверки и оставшиеся gates

Unit: contract validation, UUID/Unicode/byte limits, immutable operations/correlated results, explicit credential buffers/extensions/UV, API credentials/CSRF/Retry-After, authoritative scene/chunks/tombstones/resource caps, изоляция публичного import graph.

Browser: EN/RU login/logout, ожидание verify, отмена/retry passkey, enrollment двух credentials и новый login, selection/reason/Escape, hide/result lookup/идентичный retry, 401/403/429/503, logout failure, session deadline, resync/reconnect и отсутствие admin-кода на `/`. HTTP и WS здесь **mocked**, не заменяют совместный backend тест. Отдельно Chromium проходит настоящий `navigator.credentials.create/get` с двумя CDP virtual UV authenticators и mock HTTP; Firefox/WebKit этот CDP-only тест пропускают.

Перед включением: настоящий HTTPS origin, Touch ID/резервный provider и cookies/Origin/CSRF с реальным backend, закрытый CLI provisioning без захвата capability агентом, два независимых публичных read/write клиента для удаления/снимков, аудит/recovery/revocation, актуальные зависимости и эксплуатационные gates backend. Backend tests/audit status проверять в его документации; успешный frontend mock test не означает публичную security-готовность.
