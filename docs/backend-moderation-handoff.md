# Backend → frontend: координация модерации

По задаче владельца backend-сессия реализует модерацию параллельно с frontend-сессией. Этот файл — handoff, не подтверждение готовности API. Фронтенд-код и ваши staged изменения backend-сессия не меняет.

**Единый wire-контракт:** `../../endless-drawing-backend/docs/admin-api.md` (от этого файла; от корня frontend — `../endless-drawing-backend/docs/admin-api.md`). Требования владельца в `docs/moderation.md` сохраняются. Не создавать несовместимый локальный вариант payload.

## Что можно делать сейчас

- Отдельный `/admin/` entry без публичных imports/ссылок/shortcut; формы/ошибки EN/RU.
- Typed client + mocks по общему контракту. Fetch с same-origin credentials, CSRF только в RAM, никаких admin bearer tokens в Storage/URL/VITE/WS.
- Session check → login/options (pre-auth CSRF) → login (password, только mfa_required) → WebAuthn get → login/verify → полная server cookie.
- Причина/подтверждение и выбор UUID; hide batch 1–100, **атомарный**, operation_id для безопасного повтора и проверки результата. При 401 никаких автоповторов удаления после нового входа.
- Просмотр мира через обычный WS v1; admin-cookie не даёт ему новых полномочий. Не считать локальные prototype drafts реальным snapshot мира.
- По возможности отдельный enrollment UI: start/finish по контракту, только с account/password и закрытым SSH-issued enrollment token, два разных credentials; никогда не password-only регистрация.

## Существенные ограничения

- **Обновление по решению владельца:** пароль + обычные UV-required WebAuthn passkeys, в первую очередь Touch ID. Platform/synced credentials разрешены, attestation/CA trust store не нужны. В login/options `authenticator_policy: "passkey_uv"`. Password-only fallback по-прежнему запрещён, admin включается явно только с HTTPS RP/origin.
- Требование основного и резервного credential пока сохраняется (complete после двух регистраций). Один iCloud passkey, синхронизированный на Mac/iPhone, остаётся одним credential, не двумя независимыми резервами. Не обещать fingerprint-only: сервер проверяет UV, ОС вправе предложить другую системную проверку.
- Payload WebAuthn содержит стандартный wrapper `webauthn.publicKey`. ArrayBuffer-поля нужно корректно преобразовать в/из base64url. `JSON.stringify(browserCredential)` недостаточно.
- Cookie `__Host-ed-admin` и `__Host-ed-admin-preauth`: HttpOnly + Secure + SameSite Strict. Production HTTPS origin/RP ID отличаются от localhost; тестовые регистрации нельзя обещать пригодными для production.
- Все admin endpoints и provisioning пока **в работе**. Конкретно проверенные возможности и ограничения отмечаются в разделе «Готовность» backend `docs/admin-api.md`.

Если frontend-сессия предлагает отличия к wire-формам, запишите их сюда/в отдельный response-файл, прежде чем менять реализацию независимо. Прямого сообщения в другой запущенный агент этот файл не заменяет: владельцу достаточно попросить frontend-сессию прочитать этот handoff и общий контракт.
