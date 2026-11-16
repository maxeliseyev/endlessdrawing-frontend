# Endless Drawing

**[endlessdrawing.com](https://endlessdrawing.com)**

**One drawing. Everyone. Forever.**

Один общий бесконечный холст. Никакого приветственного экрана, никаких баннеров — только общий холст. Инструменты появляются по правому клику.

## Статус

Публичный `/`: **локальный desktop-прототип**, пока без WebSocket/backend. Отдельная `/admin/` уже имеет HTTP/WebAuthn и read-only WS-клиент; совместная проверка с настоящим backend/HTTPS/Touch ID ещё не выполнена. Штрихи находятся только в памяти страницы и исчезают после reload. Ластик/undo работают только с ними. Shared world, серверное сохранение, сессионное право удаления и reconnect — следующие этапы, не реализованные гарантии. Пометка локального режима видна в открытой палитре, но не перекрывает холст при запуске.

Реализованы Canvas 2D, DPR/resize, камера, round/square, косое перо (`chisel`), спрей (`spray`), цвет/толщина/opacity, палитра, рука, wheel, Space/средняя кнопка, отмена жеста, локальные ластик и undo. Favicon — пользовательская монолинейная иконка в `public/favicon.png` (64×64); исходник сохранён в `docs/design/favicon-source.png`, логотип поверх холста не добавляется.

Косое перо — плоский наконечник под -45°, спрей — воспроизводимые частицы от UUID и траектории. Настройки сохраняются, opacity применяется ко всему штриху. Для backend нужны новые enum-значения и bounds: [docs/brushes.md](docs/brushes.md); сервер в этой задаче не меняется.

## Запуск

Node >=22.12, npm:

```sh
npm ci
npm run dev           # http://127.0.0.1:5173
npm run check
npm test
npm run build         # dist/
npm run preview       # локальная проверка production-сборки
npx playwright install chromium
npm run test:e2e       # Chromium
npx playwright install firefox webkit
npm run test:e2e:all   # Chromium + Firefox + WebKit
```

Vite proxy `/ws`, `/api/admin/*`, `/healthz`, `/readyz` → `http://127.0.0.1:3000`. Для другого backend: `BACKEND_DEV_URL=http://127.0.0.1:8080 npm run dev`. Публичный прототип пока не обращается к API; admin entry делает настоящие HTTP/WS-запросы (без mock в production-коде). Сборка включает `dist/index.html`, `dist/admin/index.html` и общие assets: передавать backend целый `dist/`.

## Администратор и модерация

Предусмотрен отдельный служебный вход `/admin/`, без кнопок и ссылок на публичном холсте: логин + сложный пароль + обязательный WebAuthn passkey с user verification, включая Touch ID. Platform/synced passkeys разрешены; требуются основной и отдельный резервный credential, а не один синхронизированный ключ на двух устройствах. Нужны серверная сессия, CSRF-защита, выбор/подтверждение скрытия чужих штрихов с причиной, live-уведомление всех посетителей и закрытый аудит.

**Реализовано во фронтенде:** отдельный `/admin/` entry, EN/RU, server-session check, пароль → WebAuthn → verify, регистрация двух passkeys, read-only WS snapshot/live, панорамирование, выбор до 100 чужих штрихов, список UUID/причина/подтверждение, HTTP hide, проверка неопределённой операции/явный идентичный retry, 401/expiry/logout. Секреты/CSRF не сохраняются в Storage; публичный entry не загружает admin UI. Прямоугольное выделение пока не добавлено — множественный выбор кликами.

**Не считать production-интеграцию готовой:** API-контракт — `../endless-drawing-backend/docs/admin-api.md`, backend проверен локально; frontend HTTP/WS E2E использует mocks. Настоящие Touch ID, независимый резервный провайдер, cookie/CSRF/Origin на доверенном HTTPS, CLI provisioning и удаление в двух публичных контекстах нужно проверить совместно. HTTP Vite preview не обходит Secure cookies/серверную политику. Скрытый URL/Storage-флаг не авторизация. Инструкция и границы: [docs/admin-frontend.md](docs/admin-frontend.md).

## Управление

| Ввод | Действие |
| --- | --- |
| ЛКМ | Активный инструмент: кисть / рука / ластик |
| Правый клик, Shift+F10, ContextMenu | Палитра |
| Space + ЛКМ / средняя кнопка | Временное панорамирование |
| Wheel / trackpad | Двухосевое панорамирование, без зума |
| Ctrl/Cmd+Z | Удалить последний существующий локальный штрих |
| Escape | Закрыть палитру / отменить жест |

Палитра доступна с клавиатуры; ввод в её полях не перехватывается горячими клавишами холста. Переключение инструмента сохраняет настройки кисти. Ширина 1–64, opacity 0.01–1 в UI, произвольный `#RRGGBB`, 6 быстрых цветов. По умолчанию round, #202020, 6, opacity 1. Допуск ластика — 4 CSS px. Camera wheel line = 16px, page = viewport.

## Языки

Английский — по умолчанию, русский — для `ru` и региональных вариантов (`ru-RU`, `ru-KZ` и т. п.). При загрузке выбирается первый поддерживаемый язык из `navigator.languages` в порядке предпочтений браузера. При пустом списке используется `navigator.language`, без совпадений — английский. Например, `de-DE, ru-RU, en-US` → русский, `en-US, ru-RU` → английский.

Переведены палитра, подсказки, сообщения ошибок и accessibility-подписи; `html.lang` и формат процентов соответствуют языку. Название Endless Drawing и фраза проекта не переводятся. Язык не сохраняется в Storage, настройки кисти от него не зависят. После изменения языка браузера достаточно перезагрузить страницу. Никаких экранов выбора или постоянных переключателей.

Публичный словарь и чистая функция определения языка — `src/i18n.ts`, отдельный admin-каталог — `src/admin/i18n.ts`; новые ключи проверяются TypeScript для обоих переводов. Дополнительные библиотеки и сетевые запросы переводов не нужны.

## Хранение и ограничения

- `localStorage`: `endless-drawing.preferences.v1` — инструмент и кисть.
- `sessionStorage`: `endless-drawing.camera.v1` — центр камеры. Новая независимая сессия — случайный центр по каждой оси в [-250, 250].
- Геометрия: память страницы, не более 500 локальных штрихов по 2000 точек; не хранится в браузерном Storage. Undo — удаление из этого локального списка, не постоянный стек. На пределе points путь прореживается, не обрезается.
- Повреждённые/недоступные Storage не ломают приложение.
- Зум фиксирован: 1 world unit = 1 CSS px. DPR меняет только backing canvas.
- Единый Canvas renderer: round/round, square/bevel, swept chisel nib и детерминированный spray; opacity за один draw call на штрих. Effect Path2D кешируются, спрей ограничен 2048 stamps × 48 частиц. Перерисовка только dirty RAF.
- Публичный viewport-кеш/серверное рисование пока **не реализованы**. Admin отдельно хранит только текущую read-only сцену в RAM (до 20 000 штрихов / 1 000 000 точек), без history-cache. Его anonymous drawing secret/камера/CSRF/трекинг hide — только RAM; сессия — серверная HttpOnly cookie.

Целевая совместимость: актуальные desktop Chrome/Edge, Firefox, Safari (ориентир Chrome/Edge 120+, Firefox 121+, Safari 17+). Проверено: TypeScript и production build, 97 unit-тестов, 127 успешных E2E и 2 ожидаемых пропуска (CDP-only native WebAuthn тест недоступен в Firefox/WebKit); матрица Chromium/Firefox/WebKit на macOS. Матрица задаётся в `playwright.config.ts`. Это не заменяет ручную визуальную приёмку Safari/Edge и проверку нижних поддерживаемых версий; backend-интеграция ещё не проверялась. Планшеты с пером/touch записаны отдельным этапом после модерации: [бэклог](docs/tablet-input-backlog.md). Пока без реализации, зума и чувствительности к нажатию; полный mobile UX/телефоны не включены.

## Документы

- [Продукт и референсы](docs/product.md)
- [План, решения и открытые вопросы](docs/implementation-plan.md)
- [Закрытая модерация и вход администратора](docs/moderation.md)
- [Реализованный admin frontend: запуск, работа и оставшиеся gates](docs/admin-frontend.md)
- [Передача backend-сессии](docs/frontend-admin-handoff.md)
- [Косое перо, спрей и передача backend](docs/brushes.md)
- [Бэклог: планшеты с пером/touch после модерации](docs/tablet-input-backlog.md)
- [Инструкции для coding agents](AGENTS.md)
- API/ТЗ: `../endless-drawing-backend/docs/{frontend,protocol,backend}.md` (соседний репозиторий).
