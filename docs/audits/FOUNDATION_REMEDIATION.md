# Исправления фундамента V0.1.1

## CMD-ACL package — current implementation evidence

At the task baseline `5e800355d038ce390249f3d97f1801dfbda25f2e`, token, scene, campaign, membership/invitation and asset routes had authorization checks or audit boundaries outside the state transaction. The implementation now locks current session and campaign membership before scoped scene/resource rows, commits state with required audit, and publishes only after commit. Token duplicate locks source/destination scenes in sorted ID order before token rows. Asset upload stages files without holding database locks, rechecks role at commit time, compensates staged/final files on injected failures, and documents process-crash windows. Original and thumbnail reads open/read only after current entitlement checks.

The new isolated PostgreSQL entry point `apps/server/scripts/command-authorization.mjs` passed 20 scenarios on `nri_command_test`, including real blockers, campaign audit rollback, invitation expiry/creator-demotion, asset upload role/archive races, concurrent version conflicts, seven file stage/SQL/rename injections, post-commit publication, hidden/cross-campaign media denial, and a five-sample local profile. The movement (23), object lifecycle (28), secure realtime (20) and private channel (21) PostgreSQL suites passed after the latest changes; multiplayer smoke passed. Latest full local browser run passed 8/9: API restart recovery passed, while membership-revocation timed out; the latter passed 1/1 when rerun alone against a fresh API. The suite-only timeout cause is unknown. Ubuntu 24.04 CI [#196](https://github.com/Jerry93Sky/NRI/actions/runs/46014338206) passed the complete browser suite 9/9 on the prior implementation SHA; CMD-ACL is `AUTOMATED_TESTS_PASSED`. See the [endpoint matrix](../security/COMMAND_AUTHORIZATION_MATRIX.md) and [profile](../performance/CMD_ACL_PROFILE.md). V0.1.1 remains `IN_PROGRESS` pending manual acceptance and operational gates.

Исходная точка `01860649c6864f5aa4198d3359204f6051cba7fb`. Дефекты и риски перечислены в [FOUNDATION_AUDIT.md](FOUNDATION_AUDIT.md).

| ID | Статус | Результат и доказательство |
| --- | --- | --- |
| ARC-01 | IN_PROGRESS | Сервер разделён на app, маршруты, realtime, доступ и проекции. Из браузера выделены синхронизация, API-клиент и история. Общие application services для части REST/socket-операций и декомпозиция панелей открыты |
| SEC-01 | AUTOMATED_TESTS_PASSED | PostgreSQL smoke подтвердил logout, ротацию и независимые сессии. Проверки пересечений истечения и команд открыты |
| SEC-02 | AUTOMATED_TESTS_PASSED | Smoke проверил роли нескольких сокетов, архивирование и бывшего владельца токена. Playwright проверил повышение и понижение роли |
| SEC-03 | IMPLEMENTED | Fastify логирует шаблоны маршрутов, время и типы ошибок. Проверка журналов по всем чувствительным операциям открыта |
| RT-01 | IN_PROGRESS | Снимки и события ограничены контекстом кампании, сцены и роли. Остались гонки между проверкой прав и записью на отдельных серверных путях |
| RT-02 | AUTOMATED_TESTS_PASSED | Smoke сохраняет 102 сообщения и приватное сообщение, затем сверяет последние 100 из REST |
| RT-03 | IN_PROGRESS | CAS и атомарные группы закрывают проверенные конфликты. Потеря ACK и общая дедупликация требуют отдельного сценария |
| PLAY-01 | AUTOMATED_TESTS_PASSED | Playwright проверил Ctrl+Z/Ctrl+Shift+Z для группы новых объектов, сохранение их ID и отклонение всей отмены при более свежей записи |
| OPS-01 | AUTOMATED_TESTS_PASSED | Compose loopback HTTPS, миграции, readiness, cookies, Socket.IO и SIGTERM. [Процедура](../operations/PRODUCTION_DEPLOYMENT.md) |
| OPS-02 | AUTOMATED_TESTS_PASSED | Quiesced backup и восстановление Amber в отдельную БД. [Совпадения](../operations/BACKUP_RESTORE.md) |
| CI-01 | IMPLEMENTED | Добавлены dependency audit, операционные проверки, фильтр секретов и smoke production-рендерера |
| UX-01 | IN_PROGRESS | Инициатива и основные подсказки чата используют EN/RU. Полный проход доступности и совместная сессия открыты |
| PERF-01 | IN_PROGRESS | Прогоны A/B/C и сравнение перерисовки. [Сравнение и границы замера](../performance/LOAD_TEST_REPORT.md) |
| SEC-04 | NOT_STARTED | Открыт вопрос пикового запаса памяти при параллельной декомпрессии допустимых загрузок |

## Жизненный цикл объектов сцены

Исходный SHA `4fd8fb16b5d054d8a2c9064fd1a5e74f6fe4bd8c`. Групповая запись уже была атомарной, но сессия, роль и сцена проверялись заранее, а слой читался без блокировки. Точечное удаление публиковало событие до отдельной записи аудита. Новый сервис согласует блокировки с изменениями прав, слоя и объекта и публикует только после общей фиксации. [Подтверждённые дефекты и границы](../security/V0.1.1_REVIEW.md#object-lifecycle-audit--2026-11-27)

Для этой операции статус `AUTOMATED_TESTS_PASSED`. 28 PostgreSQL-сценариев проверили атомарность, порядок конкурентных операций, rollback и приватность доставки. Следующий этап распространил проверку получателей на обычное создание и редактирование объектов и события слоёв. [Проверки и замеры](../releases/V0.1.1_ACCEPTANCE_REPORT.md#transactional-scene-object-lifecycle)

## Доставка событий объектов и слоёв

На исходном SHA `7fd3d6be` проверены все 24 исходящих события. Защищены обычное создание, копирование, редактирование, перенос и изменения слоёв. События отправляются после общей фиксации изменения и аудита. Снимки и публикация используют текущие права, а устаревшие положительные события подавляются. Операция имеет статус `AUTOMATED_TESTS_PASSED` по 20 PostgreSQL-сценариям и браузерной проверке повторной доставки. Риски других прямых отправок и границы очереди Socket.IO записаны в реестре. [Реестр](../security/REALTIME_EVENT_MATRIX.md) · [Профиль](../performance/SCENE_REALTIME_PROFILE.md)

## Приватные каналы и закрытие фундамента

На исходном SHA `1fedb6f3af7585c27d599ceaefd682d9641661ee` подтверждены раздельные проверки записи и доставки чата и бросков, отсутствие сцены и согласованного снимка инициативы, а также доставка заметки по результату прежнего назначения. Общая пакетная авторизация получателей теперь применяется к этим каналам и успешным ACK чата и бросков. Миграция `0019_initiative_scene_scope` сохраняет старые записи и останавливает трекеры, которые нельзя однозначно отнести к текущей сцене.

Статус этапа `AUTOMATED_TESTS_PASSED` для 15 сценариев PostgreSQL. Статус выпуска — `IN_PROGRESS`. Оставшиеся прямые события, команды, проверки оборудования, deployment и ручная приёмка перечислены с критериями в плане. [Матрица](../security/REALTIME_EVENT_MATRIX.md) · [План завершения](../releases/V0.1.1_CLOSURE_PLAN.md)

## RT-RETRY initial implementation — 2026-11-27

Миграция `0020_chat_dice_retry_ids` добавляет client ID/digest для chat и request ID/digest для dice. Начальный контракт ограничен этими двумя Socket.IO append-командами. Тестовый gate (`NODE_ENV=test` и явный `NRI_ENABLE_TEST_FAULTS=true`) может отбросить успешный ACK после commit; в обычной и production конфигурации marker не включает fault.

Изолированный PostgreSQL сценарий прошёл потерю ACK после commit, повтор, четыре конкурентных повтора с одним ID, отклонение изменённого payload, намеренные одинаковые тексты с разными ID, private chat, демоцию после скрытого броска, отзыв членства, одну сохранённую строку и отсутствие повторной публикации. Локальные chat/dice P50/P95 и размер строк — только Windows loopback и отражены в отчёте приёмки.

Token/object/scene/campaign create/copy и asset upload ещё не имеют устойчивых request IDs. Resource UI теперь сообщает о неопределённом исходе, перечитывает авторизованный snapshot и не выполняет действие с новой версией автоматически. Поэтому RT-RETRY остаётся `IN_PROGRESS`. Следующий конечный validation scope подготовлен в [SEC_OPS_PLAY_GESTURES_SCOPE.md](../releases/SEC_OPS_PLAY_GESTURES_SCOPE.md), реализация не начиналась.

## Realtime ACL завершение

RT-ACL защищает pointer и публикацию текущей сцены с проверкой сессии, кампании, членства и ролей. Scene settings/background требуют точной текущей версии; activation, role, removal, archive и drawing уведомления служат сигналами для повторного чтения авторизованного snapshot. Уведомление об удалении остаётся персональным после удаления членства; задержанный ответ после повторного приглашения запускает новый server join.

21 PostgreSQL private-channel/RT-ACL scenarios проходят, включая шесть новых race/delivery cases. Восьмиотправительный loopback профиль показал 75.88 pointer/s, ACK P95 60.553 ms и смешанный chat P95 71.975 ms в коротком шумном sample. Это доказательство локальной автоматизации, не production benchmark. Следующий конечный пакет и endpoint families перечислены в [Closure Plan](../releases/V0.1.1_CLOSURE_PLAN.md#следующий-конечный-пакет-cmd-acl).
