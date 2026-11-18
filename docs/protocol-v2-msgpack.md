# WebSocket v2: MessagePack

M1 опубликован вместе с M2 18.11.2026; [CI и внешние проверки](transport-release.md). Единственная нормативная wire-спецификация перенесена в backend: [protocol-v2-msgpack.md](../../endless-drawing-backend/docs/protocol-v2-msgpack.md). JSON v1 сохраняется для совместимости. Внешние HTTPS/WSS проверки прошли; приёмка нового транспорта на iPhone/iPad остаётся отдельной.

Public и read-only admin используют общий codec boundary в `src/transport/`: согласование subprotocol, Binary/ArrayBuffer, float64, строковые UUID, byte/structural limits перед decode. HTTP Admin API и геометрия кистей прежние.

Диагностический baseline: 94 штриха / 21 430 точек — JSON 858 499 bytes, MessagePack 419 193 bytes. Методика и ограничения измерения находятся в нормативном документе; это не browser CPU benchmark.

Архитектура, карта файлов и этапы M2/M3 — [transport-v2-design.md](transport-v2-design.md). M2 реализован отдельным [manifest v3](protocol-v3-manifest.md). M3 задаёт приоритет видимой области и остаётся проектом.
