# Локальный HTTPS-стенд EVERDOOR

Стенд использует те же образы API, PostgreSQL и Nginx, что и закрытая альфа. Отдельный Compose-проект создаёт собственные тома. Наружу доступен только HTTPS на `127.0.0.1`. Локальный профиль ограничивает API 768 МиБ.

Для знакомства с приложением и первой игровой сессии используйте [быстрый старт владельца](OWNER_QUICK_START_RU.md).

## Настройка один раз

1. В корне репозитория создайте приватный `.env.acceptance` по `.env.production.example`. Сгенерируйте отдельные значения `NRI_DATABASE_PASSWORD` и `SESSION_SECRET` командой `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Заполните остальные поля по примеру ниже. Для порта восстановления используйте отдельный файл с `35444` и отдельный Compose-проект.

```env
DATABASE_URL=postgres://nri:<пароль_из_NRI_DATABASE_PASSWORD>@db:5432/nri_alpha
WEB_ORIGIN=https://127.0.0.1:35443
NRI_HTTPS_BIND=127.0.0.1
NRI_HTTPS_PORT=35443
NRI_TLS_DIR=<абсолютный_путь_к_приватной_папке_сертификата>
```

2. Поместите в папку `fullchain.pem` и `privkey.pem`. Сертификат должен содержать `IP:127.0.0.1` в SAN. Для изолированного теста можно выпустить временный сертификат уже доступным OpenSSL. В каталоге TLS выполните команды ниже. `ca.pem` требуется CLI для проверки. Для браузера используйте цепочку, которой доверяет выделенный тестовый профиль либо тестовое устройство. Для домашнего или рабочего профиля сначала согласуйте способ доверия с владельцем.

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=127.0.0.1 \
  -addext subjectAltName=IP:127.0.0.1 -keyout privkey.pem -out fullchain.pem
```

Скопируйте открытый `fullchain.pem` в `ca.pem` для CLI. TLS-папка, файл окружения и тестовые учётные данные хранятся вне Git.

## Команды из корня репозитория

| Действие | Команда PowerShell |
| --- | --- |
| Запустить, собрать и применить миграции | `./scripts/acceptance-compose.ps1 up -EnvFile .env.acceptance` |
| Проверить HTTPS readiness | `./scripts/acceptance-compose.ps1 status -EnvFile .env.acceptance` |
| Подготовить Amber Crossing | Задайте `$env:DEMO_PASSWORD` длиной от 12 символов в текущей оболочке. Выполните `./scripts/acceptance-compose.ps1 seed -EnvFile .env.acceptance` |
| Получить безопасную диагностику сервисов | `./scripts/acceptance-compose.ps1 logs -EnvFile .env.acceptance` |
| Очистить просроченные receipts вручную | `./scripts/acceptance-compose.ps1 prune -EnvFile .env.acceptance` |
| Остановить стенд и сохранить тома | `./scripts/acceptance-compose.ps1 down -EnvFile .env.acceptance` |
| Сделать backup в окно обслуживания | `./scripts/acceptance-compose.ps1 backup -EnvFile .env.acceptance -BackupName amber-acceptance` |
| Восстановить копию в новые тома | `./scripts/acceptance-compose.ps1 restore -EnvFile .env.acceptance-restore -Project nri-acceptance-restore -BackupName amber-acceptance` |

Перед backup остановите внешние задания записи. Команда останавливает proxy и API, затем копирует media и сверяет манифест. Исходный стенд остаётся остановленным до запуска `up`. Restore проверяет манифест, пустоту нового Compose-проекта и новым процессом загружает копию. После запуска сверяйте игровые данные и права GM/Player. В конфигурации восстановления должен быть отдельный HTTPS-порт. [Порядок проверки backup/restore](BACKUP_RESTORE.md)

Ведущий открывает `https://127.0.0.1:35443`, входит локальным `demo@nri.local` с выбранным паролем и делает копию **Amber Crossing: The Lantern Vault**. Два игрока регистрируются через приглашения в независимых браузерных профилях. Loopback-сценарий предназначен для одной машины. Для других устройств нужен выбранный владельцем закрытый хост и сертификат с именем этого хоста. [Подключение устройств к закрытой альфе](PRODUCTION_DEPLOYMENT.md) · [Сценарий игры](../releases/V0.1.1_MANUAL_ACCEPTANCE.md)
