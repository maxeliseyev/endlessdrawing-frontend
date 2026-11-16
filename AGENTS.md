# Endless Drawing — инструкции для агентов

## Продукт: неизменные принципы

- Название: **Endless Drawing**. Домен: **endlessdrawing.com**.
- Фраза проекта: **One drawing. Everyone. Forever.** Сохранять написание и пунктуацию.
- Один общий белый бесконечный холст, доступный сразу, без регистрации.
- **Никакого приветственного экрана, никаких баннеров — только общий холст.**
- Не добавлять landing page, onboarding, заголовок, логотип поверх рисунка, постоянные панели, навигацию, рекламные/промо-баннеры, стартовые подсказки и декоративные штрихи.
- Название/фраза/домен уместны в метаданных и документации, не как overlay холста. Пользовательский favicon — `public/favicon.png`, исходник `docs/design/favicon-source.png`; не превращать его в логотип поверх рисунка.
- Единственное исключение из запрета дополнительных страниц — закрытый служебный `/admin/` для модерации, без ссылок/кнопок/скрытых DOM-элементов на публичном холсте. Требования — `docs/moderation.md`; сейчас это план, не работающая функция.
- Администратор: логин + сгенерированный сложный пароль (минимум 20 символов) + обязательный WebAuthn passkey с userVerification required. Владелец выбрал Touch ID: platform/synced passkeys разрешены, обязательная аппаратная аттестация/CA trust store отменены; wire policy — `passkey_uv`. Основной и резервный credentials пока регистрируются отдельно; один синхронизированный iCloud credential на Mac/iPhone не считать двумя независимыми ключами. Не обещать fingerprint-only: ОС может предложить другую системную проверку. Проверки обоих факторов и отзываемая HttpOnly/Secure cookie-сессия — на backend. Никаких admin-секретов в VITE/Storage/URL/WS hello, client-side bypass или password-only fallback. Скрытый URL не является авторизацией. Публичный ластик по-прежнему удаляет только собственные штрихи; админ-скрытие — отдельная серверная операция с аудитом и broadcast.
- Языки: английский по умолчанию, русский для `ru`/`ru-*`. При запуске выбирается первый поддерживаемый язык из `navigator.languages` в порядке предпочтений; при пустом списке — `navigator.language`, при отсутствии совпадений — `en`. Не добавлять экран выбора языка, баннер или постоянный переключатель; бренд/фраза не переводятся.
- Инструменты появляются только по запросу: правый клик / Shift+F10 / ContextMenu. Сеть и ошибки сохранения — только кратковременное ненавязчивое сообщение при реальной проблеме, не постоянный статус-баннер.
- SVG в `docs/design/` — референсы. `context-palette.svg` задаёт компактную белую палитру, скругления, нейтральные подписи и цвета. `viewport-diagram.svg` — схема подписки, **не** сетка/рамка для UI. Не заполнять пустой мир декоративными линиями из референсов.

## Источники требований

Смежный репозиторий (не изменять без отдельной задачи):

- `../endless-drawing-backend/docs/frontend.md`
- `../endless-drawing-backend/docs/protocol.md`
- `../endless-drawing-backend/docs/backend.md`
- `../endless-drawing-backend/docs/admin-api.md` — **единственный источник wire-форм Admin API**. Статус реализации/fixtures проверять в его разделе «Готовность». Не дублировать/изобретать login/hide/enrollment payload в frontend docs.

Это рабочее ТЗ. Точные WS payload, геометрия и ряд лимитов в нём ещё помечены как предложения. Не объявлять их согласованными или проверенными с сервером. Решения/вопросы и этапы — `docs/implementation-plan.md`; бренд/референсы — `docs/product.md`; отдельный вход/модерация — `docs/moderation.md` (продуктовые требования); Admin API — только по backend `docs/admin-api.md`, реализация пока в работе.

## Стек и команды

Vite + strict TypeScript + Canvas 2D, без React/Next/UI-фреймворков. npm, lockfile коммитить. Node >=22.12.

```sh
npm ci
npm run dev       # http://127.0.0.1:5173
npm run check
npm test          # unit, tests/unit/
npm run build     # tsc + dist/
npx playwright install chromium
npm run test:e2e  # Chromium
npx playwright install firefox webkit
npm run test:e2e:all  # Chromium + Firefox + WebKit
```

`BACKEND_DEV_URL=http://127.0.0.1:3000` — временный default proxy для `/ws`, `/healthz`, `/readyz`, не утверждённый серверный порт. Не использовать `VITE_*` для секретов. Production — один origin, HTTPS/WSS.

## Архитектура и инварианты

- `src/i18n.ts`: определение locale и типизированные словари EN/RU. Все пользовательские строки (включая ошибки и aria-label) — здесь, не в DOM-коде. Новые ключи добавлять во все переводы; настройки/WS-значения brush/tool не локализовать. `html.lang` синхронизируется с locale, проценты — через Intl. Язык не хранится в Storage, изменение настроек браузера подхватывается при следующей загрузке.
- `src/model.ts`: векторные draft/серверные типы, настройки и лимиты.
- `src/camera.ts`: чистая геометрия, CSS pixels; 1 world unit = 1 CSS pixel, зума нет.
- `src/renderer.ts`: общий renderer/hit-test round/square/chisel/spray. Opacity один раз за stroke/fill; effect Path2D кешируются в WeakMap по неизменяемой готовой геометрии (preview допускает append/decimation). Backing canvas учитывает DPR, геометрия — нет. Перерисовка по dirty RAF, не постоянный цикл.
- `src/brush-geometry.ts`: косое перо -45° (swept rectangle) и воспроизводимый спрей (FNV-1a lowercase UUID → xorshift32, distance-based sampling). Не использовать Math.random/время/DPR в spray. Hit-test спрея аналитический по реальным кругам с допуском 4px. Константы, bounds и backend handoff — `docs/brushes.md`; новые значения `chisel`/`spray` пока локальны и требуют серверного enum/DB CHECK/protocol обновления перед WS-интеграцией.
- `src/storage.ts`: валидируемые versioned настройки в localStorage и камера в sessionStorage; ошибка/запрет Storage не должны ломать приложение.
- `src/palette.ts`: контекстные настройки, клавиатура, focus management, ограничение границами окна.
- `src/main.ts`: ввод и сборка. Не смешивать DOM с чистыми функциями геометрии/состояния.

Сейчас реализован **локальный прототип**, а не общий серверный мир: completed drafts хранятся только в памяти страницы. Локальные undo/ластик не имитируют серверные ownership/seq/ack. Пометка прототипа находится внутри открываемой палитры, не на холсте. Не обещать сохранение рисунков и не подменять backend постоянным localStorage-хранилищем.

При реализации realtime:

- Один WS на вкладку, hello → hello.ack → подписка → snapshot begin/chunks/end.
- Секрет — 32 байта Web Crypto, base64url, только sessionStorage и hello по WSS (localhost WS допустим). Не URL, логи, localStorage, публичные stroke.
- Разделять preview, pending, confirmed `Map<id, Stroke>`, staging snapshot и постоянный сессионный undo. Pending не входит в undo до подтверждения.
- Сервер — источник seq/own/bounds. Отрисовка confirmed по seq; ластик — только own:true, максимальный seq, допуск 4 CSS px; право удаления проверяет сервер.
- Повторы create используют тот же UUID и содержимое. Дедупликация ack/event по id.
- Snapshot заменяет актуальную сцену на end; старые subscription_id игнорируются. После reconnect всегда новый hello и snapshot. seq — не курсор удалений.
- Кеш геометрии ограничен; undo независим от viewport/вытеснения и сохраняется в sessionStorage.
- Не добавлять аккаунты, комнаты, чат, зум, redo, чужие курсоры, streaming незавершённых штрихов, экспорт или mobile UX в текущей итерации. Планшеты с пером/touch — отдельно запланированный этап **после модерации**, только бэклог: `docs/tablet-input-backlog.md`. Второй палец/long press обязаны отменять незавершённый штрих без отправки, Undo — внутри открытой палитры, никаких постоянных touch-панелей. Palm rejection проверяется на реальных устройствах; zoom/pressure и телефоны не входят в первый планшетный этап.

## Перед завершением работы

Запустить `npm run check`, `npm test`, `npm run build`; при изменениях ввода/Canvas/палитры — `npm run test:e2e:all`. Tab в палитре управляется явно: WebKit/macOS по умолчанию может пропускать кнопки без Full Keyboard Access; не убирать кросс-браузерную клавиатурную проверку. Геометрию и Storage покрывать unit-тестами, Canvas/pointer/focus/DPR — браузерными. Явно сообщать, какие браузеры/интеграции не проверены. Обновлять план и README при изменении возможностей, хранения и команд. Не менять соседний backend и не переносить его директории неявно.
