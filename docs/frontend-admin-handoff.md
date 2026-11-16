# Frontend → backend: admin entry готов к совместной приёмке

## Передаваемый результат

- Vite multi-entry: `dist/index.html`, `dist/admin/index.html`, `dist/assets/*`, favicon. Передавать целый `dist/`.
- Публичный `/` не импортирует admin entry и не проверяет admin-session; публичное рисование пока локальный прототип, не полноценный серверный WS-клиент.
- Admin `/admin/`: EN/RU, session/options/password/get/verify, closed enrollment create/finish двух credentials и новый login, logout/expiry/401 без mutation replay.
- HTTP клиент следует **единственному** контракту backend `docs/admin-api.md`. CSRF только RAM, fetch same-origin/no-store; нет токенов в Storage/URL/VITE и нет обхода MFA.
- Явные base64url adapters для стандартных WebAuthn buffers/extension buffers, UV required, attestation none, без forcing attachment/биометрии.
- Read-only WS v1: отдельный случайный drawing secret в RAM; hello/chunks/staging/end/live, bounded scene, old subscription ignore, reconnect/resync/backoff. Никаких WS create/delete/подмены own.
- До 100 UUID: множественный выбор кликами, подсветка/список, причина/подтверждение, атомарный hide через HTTP. Неизвестный исход — check operation или явный тот же operation_id/payload. Успех только по валидированному HTTP result; поздний chunk не воскрешает подтверждённо скрытое.
- Публичный и admin просмотр используют общий renderer. `chisel`/`spray` остаются отдельным backend-бэклогом: старому серверу их не отправляем (admin вообще не создаёт штрихи).

Реализация и инструкция: [admin-frontend.md](admin-frontend.md). Соседний backend и его контракт не изменялись.

## Что реально проверено

TypeScript/production build, unit и Chromium/Firefox/WebKit browser tests. Admin HTTP/WS в browser suite **mocked**, проверяют UI/state/wire, а не серверную криптографию. Дополнительно Chromium проходит настоящие navigator.credentials.create/get с двумя CDP virtual UV authenticators и mock HTTP; Firefox/WebKit этот CDP-only тест пропускают. Это не Touch ID/iCloud и не реальные независимые резервные устройства.

Backend по своему admin-api.md отдельно прошёл локальные HTTP/crypto/DB проверки. Не складывать два набора отдельных тестов в ложное утверждение о пройденном совместном HTTPS E2E.

## Следующие шаги вместе с владельцем

1. Раздать новый полный dist существующим backend `/admin/` handler на закрытом доверенном HTTPS origin. Проверить no-store/noindex/CSP/anti-framing и исключение административных ответов из кеширования proxy/CDN.
2. Сверить ADMIN_ORIGIN / RP ID / WS ALLOWED_ORIGINS. Не переписывать Origin/Secure cookies ради HTTP dev.
3. Владелец сам выполняет интерактивный CLI create/recover по backend `docs/admin-operations.md`. **Не захватывать реальные password/enrollment capability агентом, в лог/trace/переписку.** Ввести token непосредственно в служебную форму на HTTPS.
4. Регистрация настоящих основного/резервного credentials; login/logout/отмена/неверный пароль/recovery/отзыв. Проверить Touch ID, другой провайдер/устройство и поддерживаемые браузеры; не обещать fingerprint-only.
5. Создать тестовые штрихи двумя независимыми реальными WS/browser клиентами (публичный `/` ещё не подключён). Проверить hide, audit, live delete, reload/snapshot, reconnect/потерю ответа и прежний operation_id. Затем завершить публичный read/write transport.
6. Проверить эксплуатационные/security/retention gates backend, включая его текущие dependency advisories. Admin по умолчанию выключен; frontend сам не активирует ADMIN_ENABLED и ничего не выкладывает на VPS.

Прямоугольное выделение и восстановление UI-трекинга неопределённой операции после reload пока не реализованы. Трекинг только RAM; logout/re-login никогда не переотправляет скрытие автоматически.
