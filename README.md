# NRI Platform

NRI Platform — системно-независимый виртуальный стол. Ведущий управляет кампаниями, сценами, токенами и доступом игроков. Долгосрочная цель — платформа для создания собственных правил, автоматизации игры и симуляции миров.

**EVERDOOR** — согласованное имя продукта и слоган **Every door, a new adventure**; NRI Platform пока остаётся техническим именем проекта. Бренд и пользовательский путь описаны как `PLANNED` в [видении EVERDOOR](docs/design/EVERDOOR_BRAND_VISION.md); текущий интерфейс не меняется.

## Статус

**V0.1.1 — IN_PROGRESS.** Текущий этап стабилизации зафиксирован в [отчёте V0.1.1](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md). В [Draft PR #1](https://github.com/Jerry93Sky/NRI/pull/1) продолжается работа над фундаментом.

## Реализовано

- Кампании и роли Owner/GM/Player, приглашения, активная сцена и черновики ведущего. Многопользовательские команды работают с PostgreSQL и Socket.IO.
- Сетка и калибровка, изображения, токены и приватные заметки, слои и объекты, групповые операции, рисование, линейка, указатель и выбор. Undo/Redo использует версии для движения, поддерживаемых свойств и жизненного цикла объектов.
- Одиночное движение и групповые изменения токенов используют общую транзакцию PostgreSQL для проверки доступа, версий и атомарной записи. Сетевые события движения публикуются после commit.
- Удаление и восстановление объектов сцены проходят атомарно с проверкой актуальных прав, слоёв и версий. Восстановление сохраняет идентификаторы объектов, доставка учитывает текущий доступ получателей.
- События создания, редактирования и переноса объектов и изменения слоёв учитывают права на момент отправки. После скрытия или удаления клиент обновляет разрешённый снимок. [Реестр событий](docs/security/REALTIME_EVENT_MATRIX.md)
- Указатель и метаданные активной сцены публикуются с проверкой актуальной аудитории и версии. Управляющие уведомления восстанавливают актуальные роли, сцену и разрешение рисования из авторизованного снимка. RT-ACL автоматически проверен; транзакционная авторизация оставшихся writer-команд перечислена в [плане закрытия](docs/releases/V0.1.1_CLOSURE_PLAN.md#следующий-конечный-пакет-cmd-acl).
- Общий и приватный чат, публичные и скрытые броски, инициатива, восстановление после переподключения и перезапуска. Chat/dice поддерживают scoped retry ID для безопасного возврата результата после потерянного ACK; гарантия пока не покрывает создание/копирование сцен, токенов, объектов, кампаний и загрузку файлов. RT-RETRY остаётся `IN_PROGRESS`. [Политика повторов](docs/architecture/COMMAND_RETRY_POLICY.md) · [План завершения V0.1.1](docs/releases/V0.1.1_CLOSURE_PLAN.md)
- Демо **Amber Crossing: The Lantern Vault** с оригинальными материалами, копированием и [инструкцией для владельца](docs/releases/V0.1.1_MANUAL_ACCEPTANCE.md).
- Изолированно проверены [HTTPS-контур альфы](docs/operations/PRODUCTION_DEPLOYMENT.md), [backup/restore с SHA-256 и retention](docs/operations/BACKUP_RESTORE.md) и [профили A/B/C](docs/performance/LOAD_TEST_REPORT.md).

## Ограничения V0.1.1

- Полная человеческая сессия и ручная приёмка владельцем открыты. CMD-ACL сейчас проверяет оставшиеся транзакционные команды по [матрице авторизации](docs/security/COMMAND_AUTHORIZATION_MATRIX.md); потерянные подтверждения остаются отдельной задачей.
- Производительность больших сцен на программном рендерере ограничена. Прогоны на GPU, длительная проверка памяти и дополнительное профилирование ещё впереди.
- [План V0.2 Tactical Tabletop](docs/releases/V0.2_IMPLEMENTATION_PLAN.md) описывает работу после закрытия текущего этапа.

## Стек

React, TypeScript, Vite, PixiJS, Zustand, i18next; Node.js 24.13, Fastify, Socket.IO, PostgreSQL 16, Drizzle, Zod, pnpm workspaces, Docker Compose, Vitest, GitHub Actions.

## Запуск и проверки

См. [инструкцию локального запуска](docs/development/LOCAL_SETUP.md). Основные команды:

```powershell
corepack pnpm@12.23.0 install --frozen-lockfile
docker compose up -d db
corepack pnpm@12.23.0 db:migrate
corepack pnpm@12.23.0 dev
```

В другом окне:

```powershell
corepack pnpm@12.23.0 build
corepack pnpm@12.23.0 typecheck
corepack pnpm@12.23.0 test
```

Интеграционный тест нескольких клиентов описан в [отчёте V0.1](docs/releases/V0.1_ACCEPTANCE_REPORT.md). Для конкурентных сценариев движения см. [отчёт V0.1.1](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md#transactional-token-movement--2026-11-27). Не публикуйте `.env`, пользовательские данные или загруженные карты.

## Документация и дорожная карта

- [Видение продукта](docs/product/PRODUCT_VISION.md) · [Дорожная карта](docs/product/ROADMAP.md) · [Объём V0.1](docs/product/V0_1_SCOPE.md)
- [Долгосрочный план и критерии релизов](docs/product/LONG_TERM_IMPLEMENTATION_PLAN.md) · [Лицензирование пакетов правил](docs/product/RULESET_LICENSING_STRATEGY.md)
- [Архитектура](docs/architecture/ARCHITECTURE.md) · [Модель данных](docs/architecture/DATA_MODEL.md) · [Протокол реального времени](docs/architecture/REALTIME_PROTOCOL.md)
- [Резервное копирование и восстановление](docs/operations/BACKUP_RESTORE.md)
- [Модель угроз](docs/security/THREAT_MODEL.md) · [Коммерческая стратегия](docs/product/COMMERCIAL_STRATEGY.md)
- [История изменений](CHANGELOG.md) · [Сторонние лицензии](THIRD_PARTY_NOTICES.md)

Активный этап — V0.1.1; V0.2 Tactical Tabletop начинается после его приёмки. Кодовая лицензия проекта не выбрана; все права сохраняются за соответствующими владельцами.
