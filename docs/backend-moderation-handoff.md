# Backend → frontend: координация модерации

По задаче владельца backend-сессия реализует модерацию параллельно с frontend-сессией. Этот файл — handoff: backend теперь прошёл локальные HTTP/crypto/DB проверки, но не browser E2E и не включение на VPS. Фронтенд-код и ваши staged изменения backend-сессия не меняет.

**Единый wire-контракт:** `../../endless-drawing-backend/docs/admin-api.md` (от этого файла; от корня frontend — `../endless-drawing-backend/docs/admin-api.md`). Требования владельца в `docs/moderation.md` сохраняются. Не создавать несовместимый локальный вариант payload.

## Что можно делать сейчас

- Отдельный `/admin/` entry без публичных imports/ссылок/shortcut; формы/ошибки EN/RU.
- Typed client + mocks по общему контракту; backend routes уже упражняются настоящими HTTP/WebAuthn-тестами, не только mocks. Fetch с same-origin credentials, CSRF только в RAM, никаких admin bearer tokens в Storage/URL/VITE/WS.
- Session check → login/options (pre-auth CSRF) → login (password, только mfa_required) → WebAuthn get → login/verify → полная server cookie.
- Причина/подтверждение и выбор UUID; hide batch 1–100, **атомарный**, operation_id для безопасного повтора и проверки результата. При 401 никаких автоповторов удаления после нового входа.
- Просмотр мира через обычный WS v1; admin-cookie не даёт ему новых полномочий. Не считать локальные prototype drafts реальным snapshot мира.
- По возможности отдельный enrollment UI: start/finish по контракту, только с account/password и закрытым SSH-issued enrollment token, два разных credentials; никогда не password-only регистрация.

## Существенные ограничения

- **Обновление по решению владельца:** пароль + обычные UV-required WebAuthn passkeys, в первую очередь Touch ID. Platform/synced credentials разрешены, attestation/CA trust store не нужны. В login/options `authenticator_policy: "passkey_uv"`. Password-only fallback по-прежнему запрещён, admin включается явно только с HTTPS RP/origin.
- Требование основного и резервного credential пока сохраняется (complete после двух регистраций). Один iCloud passkey, синхронизированный на Mac/iPhone, остаётся одним credential, не двумя независимыми резервами. Не обещать fingerprint-only: сервер проверяет UV, ОС вправе предложить другую системную проверку.
- Payload WebAuthn содержит стандартный wrapper `webauthn.publicKey`. ArrayBuffer-поля нужно корректно преобразовать в/из base64url. `JSON.stringify(browserCredential)` недостаточно.
- Cookie `__Host-ed-admin` и `__Host-ed-admin-preauth`: HttpOnly + Secure + SameSite Strict. Production HTTPS origin/RP ID отличаются от localhost; тестовые регистрации нельзя обещать пригодными для production.
- Backend: **62 теста проходят, включая 15 admin-тестов**, fmt/Clippy, native ARM64 container smoke и 11 Linux deployment-тестов. Проверены synced zero counters, signed UV/RP/challenge failures, replay/concurrent verify, logout/recovery для queued hide, atomic audit и COMMIT failure → resync/retry. Конкретные границы — в разделе «Готовность» backend `docs/admin-api.md`.
- Новый backend ещё не развёрнут на VPS, реального HTTPS admin entry нет; настоящий Touch ID и резервный провайдер пока не проверены. Provisioning runbook: `../../endless-drawing-backend/docs/admin-operations.md`.
- `cargo audit` пока сообщает транзитивные advisories; оценка — `../../endless-drawing-backend/docs/security-dependencies.md`. Успешные тесты не означают публичную security-готовность.

## Следующий frontend-блок

1. Отдельный entry `/admin/`, отсутствующий в публичном import graph/DOM/палитре; EN/RU, no-store/noindex, без admin-проверок с публичного холста.
2. Native WebAuthn либо проверенные base64url adapters. Вход: session → options → password → get → verify; policy `passkey_uv`, пароль и UV обязательны.
3. Enrollment UI необходим до настоящего Touch ID теста: ручной ввод SSH-issued token только в память/HTTPS body, create → finish дважды; complete не открывает инструменты, после него новый login. Не передавать capabilities в URL/Storage.
4. Настоящий WS snapshot мира, не локальные drafts. Выделение/число UUID/причина/подтверждение, hide через HTTP; 401 закрывает инструменты без автоповтора после входа. `resync_required` сбрасывает view и запрашивает новый snapshot.
5. Совместный HTTPS E2E с владельцем: Touch ID, резервный вход, отмена, logout/recovery и hide в двух публичных браузерных контекстах. Никакого password-only dev bypass.

Кисти chisel/spray согласованы как **следующий отдельный backend-этап после админки**, а не уже поддержанные WS values: план — `../../endless-drawing-backend/docs/brushes-backlog.md`. Не отправлять их старому серверу и не подменять round.

Если frontend-сессия предлагает отличия к wire-формам, запишите их сюда/в отдельный response-файл, прежде чем менять реализацию независимо. Прямого сообщения в другой запущенный агент этот файл не заменяет: владельцу достаточно попросить frontend-сессию прочитать этот handoff и общий контракт.
