# WebSocket v3: повторное использование геометрии

M2 опубликован 18.11.2026. Единственный нормативный контракт находится в backend: [protocol-v3-manifest.md](../../endless-drawing-backend/docs/protocol-v3-manifest.md). Public и read-only admin предпочитают MessagePack v3, затем v2 и JSON v1. Пара frontend/backend прошла release CI и внешние read-only проверки; [результат публикации](transport-release.md).

При повторной подписке передаются UUID выбранной области и только отсутствующие у клиента strokes. Первый вход/reconnect остаются full snapshot. Отсутствующие из membership strokes снимаются на end; кеш geometry остаётся ограниченным и только в RAM. Удаления и own ack проверяются с прежней семантикой. Подробнее — [архитектура](transport-v2-design.md) и [публикация](transport-release.md).
