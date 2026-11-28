# NRI Platform

NRI Platform — системно-независимый виртуальный стол. Ведущий управляет кампаниями, сценами, токенами и доступом игроков. Долгосрочная цель — платформа для создания собственных правил, автоматизации игры и симуляции миров.

**EVERDOOR** — согласованное имя продукта и слоган **Every door, a new adventure**; NRI Platform пока остаётся техническим именем проекта. Бренд и пользовательский путь описаны как `PLANNED` в [видении EVERDOOR](docs/design/EVERDOOR_BRAND_VISION.md); текущий интерфейс не меняется.

## Статус

**V0.1.1 — IN_PROGRESS.** Результаты аппаратных и эксплуатационных проверок собраны в [отчёте готовности](docs/releases/V0.1.1_FINAL_READINESS.md). Для ручной игры подготовлены [локальный HTTPS-стенд](docs/operations/LOCAL_HTTPS_ACCEPTANCE.md) и [чек-лист ведущего и двух игроков](docs/releases/V0.1.1_MANUAL_ACCEPTANCE.md). Изменения опубликованы в [Draft PR #1](https://github.com/Jerry93Sky/NRI/pull/1).

[Быстрый старт владельца](docs/operations/OWNER_QUICK_START_RU.md) описывает знакомство на одной машине и отдельную игровую приёмку. [Inventory & Equipment](docs/design/INVENTORY_EQUIPMENT.md), [Trading](docs/design/TRADING.md) и [Loot](docs/design/LOOT.md) имеют статус `PLANNED`.

[Обзор владельца](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md#самостоятельный-обзор-владельца--2026-11-28) зафиксировал положительную оценку функций после самостоятельного знакомства. [Master Studio](docs/design/MASTER_STUDIO.md) и [Adventure Builder](docs/design/ADVENTURE_BUILDER.md) имеют статус `PLANNED`. Мастер выбирает глубину подготовки и использует дополнительные инструменты по мере необходимости.

## Реализовано

- Повтор возвращает доступную копию токена после удаления источника. Очистка REST записей проверена на изолированной БД. Загрузка изображений ограничена двумя задачами обработки. Canary-тест охватывает логи API и изолированного PostgreSQL. [RT-RETRY](docs/architecture/COMMAND_RETRY_POLICY.md) · [SEC-OPS](docs/security/LOGGING_AND_REDACTION.md) · [Матрица жестов](docs/testing/PLAY_GESTURES_MATRIX.md)
- [Player Tabletop](docs/design/PLAYER_TABLETOP.md), [Character Studio](docs/design/CHARACTER_STUDIO.md) и [социальные отношения NPC](docs/architecture/SOCIAL_RELATIONS.md) описаны как `PLANNED`. [Коммерческая стратегия](docs/product/COMMERCIAL_STRATEGY_DRAFT.md) остаётся черновиком для обсуждения.

- Кампании и роли Owner/GM/Player, приглашения, активная сцена и черновики ведущего. Многопользовательские команды работают с PostgreSQL и Socket.IO.
- Сетка и калибровка, изображения, токены и приватные заметки, слои и объекты, групповые операции, рисование, линейка, указатель и выбор. Undo/Redo использует версии для движения, поддерживаемых свойств и жизненного цикла объектов.
- Одиночное движение и групповые изменения токенов используют общую транзакцию PostgreSQL для проверки доступа, версий и атомарной записи. Сетевые события движения публикуются после commit.
- Удаление и восстановление объектов сцены проходят атомарно с проверкой актуальных прав, слоёв и версий. Восстановление сохраняет идентификаторы объектов, доставка учитывает текущий доступ получателей.
- События создания, редактирования и переноса объектов и изменения слоёв учитывают права на момент отправки. После скрытия или удаления клиент обновляет разрешённый снимок. [Реестр событий](docs/security/REALTIME_EVENT_MATRIX.md)
- Указатель и метаданные активной сцены публикуются с проверкой актуальной аудитории и версии. Управляющие уведомления восстанавливают актуальные роли, сцену и разрешение рисования из авторизованного снимка. RT-ACL автоматически проверен; транзакционная авторизация оставшихся writer-команд перечислена в [плане закрытия](docs/releases/V0.1.1_CLOSURE_PLAN.md#следующий-конечный-пакет-cmd-acl).
- Общий и приватный чат, публичные и скрытые броски, инициатива, восстановление после переподключения и перезапуска. Создание и копирование токенов, объектов, сцен и кампаний, а также загрузка файлов поддерживают явный повтор после неопределённого исхода. Сервер проверяет актуальные права и хранит ID результатов до 90 дней. RT-RETRY имеет статус `AUTOMATED_TESTS_PASSED`. Подробности в [политике повторов](docs/architecture/COMMAND_RETRY_POLICY.md) и [отчёте](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md). Будущие [Campaign Lobby](docs/design/CAMPAIGN_LOBBY.md) и [GM Screen](docs/design/GM_SCREEN.md) имеют статус `PLANNED`.
- Демо **Amber Crossing: The Lantern Vault** с оригинальными материалами, копированием и [инструкцией для владельца](docs/releases/V0.1.1_MANUAL_ACCEPTANCE.md).
- Изолированно проверены [HTTPS-контур альфы](docs/operations/PRODUCTION_DEPLOYMENT.md), [backup/restore с SHA-256 и retention](docs/operations/BACKUP_RESTORE.md) и [профили A/B/C](docs/performance/LOAD_TEST_REPORT.md).

## Ограничения V0.1.1

- Полная игровая сессия с ведущим и двумя независимыми игроками ожидает ручной проверки. Для целевого контура открыты критерии из [отчёта готовности](docs/releases/V0.1.1_FINAL_READINESS.md).
- Производительность больших сцен на программном рендерере ограничена. Прогоны на GPU, длительная проверка памяти и дополнительное профилирование ещё впереди.
- V0.2 PR 1 добавляет редактор препятствий ведущего, версии стен, дверей и окон и локальное демо **Geometry Workshop**. [Реализация и проверки](docs/releases/V0.2_PR_01_RESULT.md) · [Дизайн Map & Scene Editor](docs/design/MAP_SCENE_EDITOR.md)
- V0.2 PR 2 добавляет настройку **Ограничить движение** для каждой сцены. Сервер проверяет весь отрезок движения токена и отклоняет групповое действие целиком, если хотя бы один путь заблокирован. [Контракт, тесты и демо](docs/releases/V0.2_PR_02_RESULT.md)

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

Приёмка V0.1.1 и разработка V0.2 Tactical Tabletop идут параллельно на рабочей ветке. Действующие критерии выпуска сохраняются. Права на код сохраняются за соответствующими владельцами.
