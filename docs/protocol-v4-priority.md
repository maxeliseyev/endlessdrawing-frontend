# WebSocket v4: приоритет видимой области

M3 реализован локально 18.11.2026. Нормативный контракт находится только в backend: [protocol-v4-priority.md](../../endless-drawing-backend/docs/protocol-v4-priority.md). Public и read-only admin предпочитают MessagePack v4, затем v3/v2/JSON. Публикация M3 ещё не выполнена.

Клиент передаёт пересечение видимого окна с подпиской и миром. Сервер сначала отдаёт geometry, чьи bounds пересекают эту область, затем запас. Всё относится к одному согласованному snapshot; full загрузка не требует дополнительного manifest round trip, warm загрузка использует M2 и запрашивает только missing ids в порядке приоритета. Композиция остаётся по seq, удаления отсутствующих id — только на end.

Новых DB migrations нет. Выбор v4 отключается серверным `WS_PRIORITY_ENABLED=false`, при этом новые соединения выбирают v3. Перед rollout обновить серверный Compose штатным процессом: CI доставляет образ, но не Compose. Реальные iPhone/iPad и production WAN performance не заменяются локальным стендом. [Методика и результаты](loading-performance.md), [план](transport-v2-design.md#6-m3-сначала-видимая-область).
