# Закрытая альфа NRI

Приёмочные проверки, диагностика сети и Windows и ежедневная очистка REST записей описаны в [пакете PERF-GPU и OPS](PERF_GPU_OPS_HANDOFF.md).

Production-контур использует `docker-compose.production.yml`, отдельный проект Compose, постоянные тома PostgreSQL 16 и media, собранный frontend в Nginx и непривилегированный Node API. По умолчанию HTTPS публикуется на loopback. Для удалённой альфы ограничьте сетевой доступ группой участников и выдайте доверенный TLS-сертификат для заданного адреса.

## Первый запуск

1. Создайте локальный `.env.production` по `.env.production.example`. В качестве пароля БД и секрета сессии сгенерируйте разные значения. Команда `node -p "require('node:crypto').randomBytes(32).toString('hex')"` подходит для каждого значения. Ограничьте права доступа к файлу.
2. Задайте `NRI_DATABASE_PASSWORD`, `DATABASE_URL=postgres://nri:<password>@db:5432/nri_alpha`, `SESSION_SECRET` и `WEB_ORIGIN` как точный HTTPS origin, включая нестандартный порт. Поместите `fullchain.pem` и `privkey.pem` в `NRI_TLS_DIR`. API принимает один доверенный hop от Nginx. Nginx заменяет входящий заголовок X-Forwarded-For.
3. Соберите образы и примените миграции отдельным процессом. Запустите API и proxy после успешной миграции.

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build api proxy
docker compose --env-file .env.production -f docker-compose.production.yml up -d --wait db
docker compose --env-file .env.production -f docker-compose.production.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml up -d --wait api proxy
```

По HTTPS проверьте `/api/health`, `/api/ready`, вход и подключение стола. Readiness проверяет доступ к таблице кампаний и право записи в каталог media. Версия миграции контролируется отдельным шагом релиза.

## Обслуживание

- Внутренний `/api/metrics` доступен из loopback самого API. Для проверки запустите `node -e "fetch('http://127.0.0.1:3000/api/metrics').then(r=>r.text()).then(console.log)"` через `docker compose … exec api`. Метрики включают сокеты, запросы и ошибки, RSS, CPU и состояние пула PostgreSQL.
- API выдаёт JSON-журналы с шаблоном маршрута, статусом, request ID и длительностью. Обычные access-логи Nginx выключены. Обеспечьте ротацию контейнерных логов средствами хоста.
- `SIGTERM` прекращает приём WebSocket-соединений, завершает HTTP и закрывает пул PostgreSQL. Окно остановки контейнера составляет 25 секунд.
- Перед обновлением остановите proxy и API, остановите внешние задания записи, завершите проверенный backup базы и media. Соберите проверенную ревизию, выполните миграцию, поднимите сервисы и повторите проверку. Сохраните предыдущие теги образов. При несовместимой миграции восстановите проверенную копию в отдельные тома по [процедуре восстановления](BACKUP_RESTORE.md).

## Проверка

Локальный Compose drill запускался 27 ноября 2026 года на `https://localhost:54443` с отдельными томами и временным сертификатом. Прошли сборка двух образов, применение миграций, readiness, статическая страница, регистрация с Secure/HttpOnly/SameSite=Lax, запись кампании через HTTPS, WebSocket и бросок кубиков. Запрос внутренних метрик через reverse proxy получил 404. Docker SIGTERM завершил API с кодом 0. Публичное развёртывание отсутствует.
