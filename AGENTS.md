# Endless Drawing — инструкции для агентов

## Продукт: неизменные принципы

- Название: **Endless Drawing**. Домен: **endlessdrawing.com**.
- Фраза проекта: **One drawing. Everyone. Forever.** Сохранять написание и пунктуацию.
- Один общий белый бесконечный холст, доступный сразу, без регистрации.
- **Никакого приветственного экрана, никаких баннеров — только общий холст.**
- Не добавлять landing page, onboarding, заголовок, логотип поверх рисунка, постоянные панели, навигацию, рекламные/промо-баннеры, стартовые подсказки и декоративные штрихи.
- Название/фраза/домен уместны в метаданных и документации, не как overlay холста. Пользовательский favicon — `public/favicon.png`, исходник `docs/design/favicon-source.png`; не превращать его в логотип поверх рисунка. Превью для соцсетей — `public/og-image.jpg` (1200×628, исходник `docs/design/og-image-source.png`), только в метаданных `index.html`. Индексация — статические метаданные и JSON-LD в `index.html`, `public/robots.txt`, `public/sitemap.xml` (`/`, `/about`, `/privacy`) и `public/llms.txt`. `/admin/` в карту не входит и остаётся `noindex`. Не добавлять посадочную страницу ради SEO и не класть в репозиторий код подтверждения Search Console.
- По явному решению владельца 18.11.2026 отдельные `/about` и `/privacy` — минималистичные информационные страницы для iPad-приложения и TestFlight, не стартовый экран. EN/RU тексты — в `src/i18n.ts`, английский доступен без JavaScript. Не добавлять ссылки или UI поверх публичного холста. Эти страницы входят в sitemap.
- Закрытый служебный `/admin/` для модерации — ещё одно исключение, без ссылок/кнопок/скрытых DOM-элементов на публичном холсте. Требования — `docs/moderation.md`, реализация/запуск/gates — `docs/admin-frontend.md`. Frontend реализован, но совместный HTTPS/Touch ID/provisioning тест ещё не пройден; не объявлять admin включённым на VPS.
- Администратор: логин + сгенерированный сложный пароль (минимум 20 символов) + обязательный WebAuthn passkey с userVerification required. Владелец выбрал Touch ID: platform/synced passkeys разрешены, обязательная аппаратная аттестация/CA trust store отменены; wire policy — `passkey_uv`. По новому явному решению владельца достаточно одного UV passkey; Google Authenticator (TOTP) — альтернативный резерв вместо обязательного второго passkey. Обычный вход password+UV passkey, резервный password+TOTP, не password-only. Подключение/отключение TOTP требует fresh primary UV session; TOTP-session не меняет факторы. QR генерируется локально, seed/code/URI только RAM/DOM, без Storage/URL/логов/внешних QR services. Не обещать fingerprint-only: ОС может предложить другую системную проверку. Проверки обоих факторов и отзываемая HttpOnly/Secure cookie-сессия — на backend. Никаких admin-секретов в VITE/Storage/URL/WS hello, client-side bypass или password-only fallback. Скрытый URL не является авторизацией. Публичный ластик по-прежнему удаляет только собственные штрихи; админ-скрытие — отдельная серверная операция с аудитом и broadcast.
- Языки: английский по умолчанию, русский для `ru`/`ru-*`. При запуске выбирается первый поддерживаемый язык из `navigator.languages` в порядке предпочтений; при пустом списке — `navigator.language`, при отсутствии совпадений — `en`. Не добавлять экран выбора языка, баннер или постоянный переключатель; бренд/фраза не переводятся.
- Инструменты появляются только по запросу: правый клик / Shift+F10 / ContextMenu / долгое нажатие пальцем. Сеть и ошибки сохранения — только кратковременное ненавязчивое сообщение при реальной проблеме, не постоянный статус-баннер.
- SVG в `docs/design/` — референсы. `context-palette.svg` задаёт компактную белую палитру, скругления, нейтральные подписи и цвета. `viewport-diagram.svg` — схема подписки, **не** сетка/рамка для UI. Не заполнять пустой мир декоративными линиями из референсов.

## Источники требований

Смежный репозиторий (не изменять без отдельной задачи):

- `../endless-drawing-backend/docs/frontend.md`
- `../endless-drawing-backend/docs/protocol.md`
- `../endless-drawing-backend/docs/backend.md`
- `../endless-drawing-backend/docs/admin-api.md` — **единственный источник wire-форм Admin API**. Статус реализации/fixtures проверять в его разделе «Готовность». Не дублировать/изобретать login/hide/enrollment payload в frontend docs.

Это рабочее ТЗ. Точные WS payload, геометрия и ряд лимитов в нём ещё помечены как предложения. Не объявлять их согласованными или проверенными с сервером. Решения/вопросы и этапы — `docs/implementation-plan.md`; бренд/референсы — `docs/product.md`; отдельный вход/модерация — `docs/moderation.md` (продуктовые требования); Admin API — только по backend `docs/admin-api.md`; backend прошёл локальные HTTP/WebAuthn/DB тесты, реальная браузерная интеграция и production-gates проверяются отдельно.

## Стек и команды

Vite multi-page (`/`, `/about`, `/privacy` и отдельный `/admin/`) + strict TypeScript + Canvas 2D, без React/Next/UI-фреймворков. npm, lockfile коммитить. Node >=22.12.

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
npm run test:integration  # реальный backend на :3000 со STATIC_DIR=dist
# Воспроизводимые замеры loading: npm run bench:loading -- --help; docs/loading-performance.md
npm run dev:lan   # для iPhone/iPad в локальной сети (Origin добавить в ALLOWED_ORIGINS)
```

`BACKEND_DEV_URL=http://127.0.0.1:3000` — default proxy для `/ws`, `/api/admin/*`, `/healthz`, `/readyz`. Для реальной админки нужны доверенный HTTPS и согласованные ADMIN_ORIGIN / RP ID / WS Origin; не переписывать cookie/Origin и не вводить HTTP/password-only bypass ради dev. Не использовать `VITE_*` для секретов. Production — один origin, HTTPS/WSS.

## Архитектура и инварианты

- `src/i18n.ts`: определение locale и типизированные словари EN/RU. Публичные строки (включая ошибки и aria-label) — здесь; admin EN/RU каталог — `src/admin/i18n.ts`, не DOM-код. Новые ключи добавлять во все переводы; настройки/WS-значения brush/tool не локализовать. `html.lang` синхронизируется с locale, проценты — через Intl. Язык не хранится в Storage, изменение настроек браузера подхватывается при следующей загрузке.
- `src/model.ts`: векторные draft/серверные типы, настройки и лимиты.
- `src/camera.ts`: чистая геометрия, CSS pixels. Ограниченный зум `zoom ∈ [0.16, 4]` (CSS px на world unit; отсутствие поля = 1, так работает admin), зум вокруг курсора/центра pinch, подписка 3× видимой области, но не шире 30000 по оси (`VIEWPORT_MAX_SPAN`), сдвинута на 35% запаса вперёд по направлению pan; переподписка, когда впереди остаётся меньше половины запаса (`PREFETCH_LEAD < 1 - RESUBSCRIBE_AT`, иначе свежая подписка перезапускает себя). Ширина кисти — в world units, допуск ластика — 4 CSS px на экране при любом зуме.
- `src/renderer.ts`: общий renderer/hit-test round/square/chisel/spray. Opacity один раз за stroke/fill; line и effect Path2D в world units относительно первой точки кешируются в WeakMap по неизменяемой готовой геометрии (preview допускает append/decimation), проекция — через transform (`drawProjected`). Backing canvas учитывает DPR, геометрия — нет. Перерисовка по dirty RAF, не постоянный цикл.
- `src/scene-renderer.ts`: граница рендер-бэкенда публичного холста (`SceneRenderer`: resize/invalidate/dispose + added/removed). `main.ts` не трогает контекст экранного холста; выбор бэкенда — только `createSceneRenderer`. По умолчанию WebGL2 (`src/webgl/`): свой буфер на штрих и GPU-тайлы с теми же правилами, что Canvas-кеш (кадр копирует тайлы; новый верхний штрих дорисовывается в затронутые; сдвиг не пересобирает уже видимые). При отсутствии контекста или `?renderer=canvas2d` — Canvas 2D + тайлы. Хит-тест ластика — на отдельном `createHitContext()`. Владелец 18.11.2026 на iPad Pro M4 визуально не заметил лагов прокрутки и рисования; числа кадра и память вершин не сняты — `docs/webgl.md`. Следующий кусок рендера не начинать по одному этому наблюдению.
- `src/tiles.ts`: кеш confirmed-штрихов пути Canvas 2D — непрозрачные тайлы 512×512 backing px, привязанные к миру, по масштабу zoom×DPR. Кадр копирует тайлы целыми пикселями, сверху — pending и preview по snapped-камере. Новые тайлы — ближние первыми в бюджете ~6 мс/кадр, недостающие показываются растянутым ближайшим масштабом; в покое — prefetch одного кольца. Во время зума — уровни √2, через 180 мс — точный масштаб. Штрих поверх (seq больше всех в тайле) дорисовывается инкрементально, остальное перерисовывает только затронутые тайлы. Память ограничена (LRU, ≥48 тайлов); если canvas не выделяется (iOS), прямой рендер. Те же правила у GPU-тайлов. Admin тайлы не использует.
- `src/brush-geometry.ts`: косое перо -45° (swept rectangle) и воспроизводимый спрей (FNV-1a lowercase UUID → xorshift32, distance-based sampling). Не использовать Math.random/время/DPR в spray. Hit-test спрея аналитический по реальным кругам с допуском 4px. Константы, bounds и backend handoff — `docs/brushes.md`; `chisel`/`spray` приняты backend (enum, миграция 0003, bounds). По явному решению владельца 18.11.2026 диаметр частиц ограничен 1 world unit для всех штрихов без обратной совместимости; следующие изменения алгоритма требуют отдельного решения/версионирования.
- Точка входа: новая вкладка (нет камеры в sessionStorage) берёт необязательный `spawn` из `hello.ack` — случайный живой штрих ± 400, обновляется сервером раз в 30 с; без подсказки — локальный [-250, 250]. Если пользователь сдвинул камеру раньше ответа или это reload/reconnect — подсказка игнорируется.
- `src/storage.ts`: валидируемые versioned настройки в localStorage; камера (с zoom), сессионный секрет и undo-стек UUID — в sessionStorage; ошибка/запрет Storage не должны ломать приложение (секрет тогда живёт в RAM страницы).
- `src/transport/`: общий кодек public/read-only admin; subprotocol `endless-drawing.msgpack.v4` / `endless-drawing.msgpack.v3` / `endless-drawing.msgpack.v2` / `endless-drawing.json.v1`, Binary/ArrayBuffer v2, float64 и строковые UUID. Никакого угадывания кодека или секрета в handshake headers. Bounded preflight до decode; byte limits, max depth/nodes, safe integers и duplicate keys. Backend сохраняет legacy JSON; сначала выкладывать dual-profile backend. Контракт v2 — только backend `docs/protocol-v2-msgpack.md`; HTTP Admin API прежний. M2 manifest/missing geometry реализован: контракт только backend `docs/protocol-v3-manifest.md`, membership и токен ограничены текущим соединением. Первый вход/reconnect/resync — full; повтор области — только missing geometry. Сохранять cache object identity, authoritative end, own ack до begin и tombstones; не держать DB transaction в ожидании fetch. M1+M2 опубликованы 18.11.2026. M3 реализован локально: v4 передаёт clipped `visible_bounds`, один snapshot идёт visible-first, композиция по seq; нормативный контракт — backend `docs/protocol-v4-priority.md`. Cold/reconnect не добавляют manifest RTT; warm сохраняет M2. M3 ещё не опубликован.
- `src/wire.ts`: общие runtime guards и `parseStroke` для public/admin. `src/scene.ts`: чистое состояние публичного мира (confirmed по seq, staging snapshot, pending, hidden, tombstones, лимиты) и `SceneListener` — ровно одно added/removed на каждое изменение отрисовываемого множества (confirmed ∪ staging без hidden), им живёт кеш тайлов. `src/world.ts`: единственный WS публичной вкладки — hello/subscribe/outbox/rate-limit/ack timeout/reconnect/undo.
- `src/palette.ts`: контекстные настройки, Undo и масштаб внутри палитры, клавиатура, focus management, ограничение границами окна/safe area; на узком touch-экране — bottom sheet. Resize/клавиатура iOS перепозиционируют палитру, а не закрывают её.
- `src/main.ts`: публичный ввод и сборка. Явная state machine указателей: mouse / pen / touch, pinch из двух touch pointerId, `blocked` до отпускания всех пальцев. Не смешивать DOM с чистыми функциями геометрии/состояния.
- `admin/index.html`, `src/admin/main.ts`: отдельная административная сборка. Никогда не импортировать в публичный entry. `src/admin/api.ts`/`contracts.ts` — typed HTTP, runtime guards, cookies same-origin/no-store, CSRF только в RAM; никакого отображения сырых server message.
- `src/admin/webauthn.ts`: standard buffer/base64url adapters для get/create/assertion/attestation/extensions, UV required и attestation none. Не сериализовать browserCredential одним JSON.stringify. Нет автоматического повторения assertion/challenge и password-only fallback.
- `src/admin/scene.ts`/`world.ts`/`view.ts`: read-only snapshot/live WS, собственный анонимный секрет только в RAM/hello, reconnect/resync, лимиты 20k strokes/1m points, dirty renderer. Никаких WS create/delete/подмены own; множественный выбор до 100 штрихов.
- Hide — только после списка UUID/причины/подтверждения, payload immutable. При неизвестном ответе только проверка operation или явный повтор того же operation_id/payload; 401/expiry/logout очищают инструменты, никогда не пересылать скрытие после нового входа. Не выдавать локальное закрытие UI за подтверждённый logout сервера.

Публичный `/` подключён к общему миру через `/ws` (manifest MessagePack v3, MessagePack v2 либо JSON v1 по согласованному subprotocol; семантика мутаций прежняя). Prototype-хранилища штрихов больше нет: геометрия приходит только из snapshot/событий, сохраняет её сервер. Не подменять backend постоянным localStorage-хранилищем. Совместная проверка с реальным backend: `npm run test:integration` (см. README); production-нагрузка и HTTPS-стенд этим не проверяются.

Инварианты realtime (реализованы в `scene.ts`/`world.ts`, не ослаблять):

- Один WS на вкладку, hello → hello.ack → подписка → snapshot begin/chunks/end.
- Секрет — 32 байта Web Crypto, base64url, только sessionStorage и hello по WSS (localhost WS допустим). Не URL, логи, localStorage, публичные stroke.
- Разделять preview, pending, confirmed `Map<id, Stroke>`, staging snapshot и постоянный сессионный undo. Pending не входит в undo до подтверждения.
- Сервер — источник seq/own/bounds. Отрисовка confirmed по seq; ластик — только own:true, максимальный seq, допуск 4 CSS px; право удаления проверяет сервер.
- Повторы create используют тот же UUID и содержимое. Дедупликация ack/event по id.
- Snapshot заменяет актуальную сцену на end (удаление отсутствующих — только на end; штрихи из chunks рисуются сразу, недогруженный staging при новой подписке/resync/reconnect остаётся в устаревшем кеше до следующего end); старые subscription_id игнорируются. После reconnect всегда новый hello и snapshot. seq — не курсор удалений.
- Кеш геометрии ограничен; undo независим от viewport/вытеснения и сохраняется в sessionStorage.
- Pending создания рисуются поверх confirmed, отправляются с клиентским лимитом 5/1.1 с (delete 20/1.1 с); ack timeout 12 с → reconnect и повтор того же UUID. Undo неотправленного pending удаляет его локально; уже отправленного — помечает cancelled и удаляет после ack.
- Не добавлять аккаунты, комнаты, чат, redo, чужие курсоры, streaming незавершённых штрихов или экспорт. Исключение в бэклоге (владелец, 17.11.2026, не реализовано): сохранение выделенной области в SVG — строго по `docs/export-svg-backlog.md`. Зум ограничен 16–400% (25–400% по решению владельца 16.11.2026, нижняя граница опущена на две ступени ×1.25 по решению 17.11.2026); не расширять диапазон без пересмотра `VIEWPORT_MAX_SPAN`/лимитов сцены. При 16% окно шире ~4800 CSS px видит больше 30000 world units: подписка покрывает центральные 30000, `needsResubscribe` не требует больше, чем вмещает одна подписка.
- Touch/перо (iPhone/iPad, спецификация — `docs/tablet-input-backlog.md`): один палец — инструмент, два — pan + pinch-зум; второй палец отменяет незавершённый штрих без отправки; оставшийся палец не рисует; long press 500 мс без движения >10 px открывает палитру и отбрасывает точку; после первого pen-события пальцы только навигируют; Undo — внутри палитры; никаких постоянных touch-панелей. Нажим не используется. Владелец 18.11.2026 на iPad Pro M4 подтвердил: ладонь не рисует и не двигает холст, палец навигирует, поворот и уход в фон проходят. Жесты от краёв и iPhone ещё не описаны. Синтетические PointerEvent в E2E этого не доказывают. По решению владельца 18.11.2026 полное управление на iPad — отдельное нативное приложение на том же протоколе; в этом репозитории его не начинать и не добавлять жест корпуса или сжатие карандаша в веб-клиент.

## Перед завершением работы

Запустить `npm run check`, `npm test`, `npm run build`; при изменениях ввода/Canvas/палитры — `npm run test:e2e:all`; при изменениях транспорта/протокола — `npm run test:integration` с запущенным backend. Tab в палитре управляется явно: WebKit/macOS по умолчанию может пропускать кнопки без Full Keyboard Access; не убирать кросс-браузерную клавиатурную проверку. Геометрию и Storage покрывать unit-тестами, Canvas/pointer/focus/DPR — браузерными. Явно сообщать, какие браузеры/интеграции не проверены. Обновлять план и README при изменении возможностей, хранения и команд. Не менять соседний backend без явной задачи владельца и не переносить его директории неявно (расширение кистей 16.11.2026 сделано по такой задаче).
