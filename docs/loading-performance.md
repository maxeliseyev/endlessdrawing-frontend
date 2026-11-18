# M3: измерения загрузки

Статус 18.11.2026: M3 опубликован через [Actions 44364578357](https://github.com/maxeliseyev/endlessdrawing-backend/actions/runs/44364578357). Ниже — локальные контрольные измерения, не production WAN benchmark. Нормативный контракт — [backend v4](../../endless-drawing-backend/docs/protocol-v4-priority.md). [Сводные данные 30 повторов](performance/m3-statistics.json).

## Методика

Реальный локальный Rust backend и PostgreSQL; отдельная случайная БД, удаляемая после каждого прогона. Один и тот же backend умеет v3 и v4; WS proxy фиксирует выбранный профиль, использует bounded queues и моделирует 256 КиБ/с с 40 мс задержки в одну сторону. TLS, WAN и браузерная загрузка HTML/JS здесь не моделируются. Часы начинаются непосредственно перед отправкой подписки. Секреты/сырые frames не пишутся в результаты; SQL-корпус синтетический.

Harness использует настоящий SharedWorld и createSceneRenderer, включая staging, codec, M2 и тайлы. Первый видимый кадр определяется чтением пикселей из canvas после callback painted; первый сетевой chunk сам по себе недостаточен. Момент физического вывода на дисплей этим не измеряется. Для пустого вида значение первого видимого кадра отсутствует. На warm/reconnect первый кадр может показывать старый кеш до авторитетного end; этот показатель не означает завершения свежей синхронизации.

Основная сцена: 300 старых offscreen штрихов, затем 10 видимых, по 64 точки; полный снимок — 310 штрихов / 19 840 точек. Для pan подготовлена соседняя группа; новая подписка содержит 610 штрихов с частично тёплым кешем. Масштабы размещены в непересекающихся областях, fixture SHA-256 `c471e027cfaae3b4128b0996a5c1dd39b59c8961edf935a62ac127d463ef6572`.

## Контрольный результат

Chromium 159.0.8154.6, WebGL2, 100%, DPR 1, 30 cold+warm повторов каждого профиля. В таблице — p50 / p95 в мс; p95 — nearest rank.

| Метрика | v3 | v4 |
| --- | ---: | ---: |
| Первая видимая geometry | 1685.2 / 1687.7 | 141.4 / 144.8 |
| Первый видимый кадр | 1818.5 / 1838.9 | 261.6 / 269.5 |
| Вся видимая часть в кадре | 1819.3 / 1839.9 | 262.5 / 270.4 |
| snapshot.end | 1685.5 / 1688.1 | 1674.5 / 1683.0 |

Первый видимый кадр p95 снизился с 1838.9 до 269.5 мс (на 85.3%, примерно в 6.8 раза) на этой специально выбранной сцене. Не универсальный коэффициент для всех рисунков и сетей. Приёмочная цель для этого корпуса — уменьшение p95 минимум вдвое, рост полного end не более 15%, download bytes не более 1%; проверяет `scripts/compare-loading.py`.

В обоих профилях cold download — 415 506 bytes и 19 840 точек; warm — 12 400 bytes manifest/control и 0 geometry. Хеши конечной сцены и canvas совпали во всех 30 cold/warm прогонах v3/v4. Этот статистический контроль использовал PNG-хеш Chromium; итоговая межбраузерная матрица сравнивает сырые RGBA-пиксели. В Firefox диагностическая пара дала одинаковые RGBA при разных PNG-хешах даже для белого холста; PNG-сериализация исключена из итогового pixel gate. Это application payload сервера без hello, upload hint и TLS/TCP/WS overhead.

Decode replay и диагностический подсчёт geometry измеряются после завершения загрузки, отдельно от горячего пути; handling включает реальный decode/validate/scene и синхронную подготовку GPU geometry, поэтому эти значения нельзя складывать как независимые фазы. geometry_prepare — время renderer.added; frame_times — CPU-время подготовки/отправки кадра до измерительных pixel probes (не GPU timer query), frame_intervals также включают ожидание сетевых сообщений. heap_bytes — текущий JS heap там, где API доступен; это не peak/GPU memory. Peak памяти, физические iPhone/iPad и production WAN в этом стенде не измерены.

## Воспроизведение

Нужны built backend с v3/v4, frontend `npm ci`/`npm run build`, Playwright Chromium/Firefox/WebKit, локальная dev PostgreSQL `endless-drawing-backend-postgres-1` на 55432 и Python с зависимостью из `tests/performance/requirements.txt`. Скрипт допускает только local Unix Docker endpoint; основной dev DB не используется. Для другого имени контейнера — `BENCH_POSTGRES_CONTAINER`. Порты 3300/3301/5173 должны быть свободны.

```sh
npm run bench:loading -- --backend /absolute/path/to/endless-drawing-server --profile v3 --project chromium --runs 30 --scenarios cold,warm --output /private/tmp/loading-v3.jsonl
npm run bench:loading -- --backend /absolute/path/to/endless-drawing-server --profile v4 --project chromium --runs 30 --scenarios cold,warm --output /private/tmp/loading-v4.jsonl
python3 scripts/compare-loading.py /private/tmp/loading-v3.jsonl /private/tmp/loading-v4.jsonl --output /private/tmp/loading-comparison.json
```

Полная функциональная матрица: для каждого профиля отдельно `--runs 1 --zooms 0.16,1,4 --dprs 1,2` (без `--project` — три браузера), сценарии cold/warm/pan/reconnect/empty. Один повтор каждой комбинации проверяет корректность, а не надёжную статистику p95. JSONL и metadata-файл сохранять вместе. Повторные файлы не перезаписываются; использовать новый output path.

## Расширенная матрица

[Результаты CSV](performance/m3-matrix.csv): 90 сопоставленных групп — три браузера × три масштаба × два DPR × пять сценариев. В каждом профиле прошли 90 прогонов; scene и RGBA hashes совпали для каждой пары v3/v4, warm везде передал 0 точек. Это один повтор комбинации для проверки корректности, не статистический benchmark каждой группы. Real public integration отдельно прошёл в трёх браузерах; real localhost HTTPS admin — с виртуальным UV authenticator. Физические iPhone/iPad и WAN этим не проверяются.
