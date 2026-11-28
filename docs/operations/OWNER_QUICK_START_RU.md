# EVERDOOR — быстрый старт владельца

Если локальный стенд уже запущен, откройте `https://127.0.0.1:35443` и войдите как `demo@nri.local`. Используйте пароль, который вы ввели при подготовке демо или который сохранили локально для этого стенда. Команды ниже выполняются в PowerShell из корня репозитория.

## Первый запуск

1. Создайте `.env.acceptance` по `.env.production.example`. Укажите `WEB_ORIGIN=https://127.0.0.1:35443`, `NRI_HTTPS_BIND=127.0.0.1`, `NRI_HTTPS_PORT=35443` и абсолютный `NRI_TLS_DIR`. Для БД и сессий сгенерируйте разные значения через `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Адрес БД внутри Compose — `postgres://nri:<пароль>@db:5432/nri_alpha`. Храните файл вне Git. [Подробная настройка](LOCAL_HTTPS_ACCEPTANCE.md)
2. Создайте временный TLS-сертификат с `IP:127.0.0.1` в SAN по инструкции стенда. Поместите серверные `fullchain.pem` и `privkey.pem`, а также публичный `ca.pem` в каталог TLS. Добавляйте в браузерное хранилище доверия только проверенный публичный сертификат. На Windows владелец может отдельно разрешить импорт в хранилище своего пользователя `Cert:\CurrentUser\Root`. Если используется публичный `ca.cer`, команда импорта приведена ниже. Подключайтесь по тому же адресу IP. [Настройка TLS](LOCAL_HTTPS_ACCEPTANCE.md#настройка-один-раз) · [Импорт сертификата Windows](https://learn.microsoft.com/en-us/powershell/module/pki/import-certificate)

```powershell
openssl x509 -in '<путь_к_ca.pem>' -outform der -out '<путь_к_ca.cer>'
Import-Certificate -FilePath '<путь_к_публичному_ca.cer>' -CertStoreLocation 'Cert:\CurrentUser\Root'
```

3. Запустите стенд, дождитесь `{"status":"ready"}` и загрузите Amber Crossing. Для первого seed задайте отдельный пароль от 12 символов через скрытый ввод. Сохраните его в локальном менеджере паролей. Повторный seed сохраняет существующий аккаунт и кампанию.

```powershell
./scripts/acceptance-compose.ps1 up -EnvFile .env.acceptance
./scripts/acceptance-compose.ps1 status -EnvFile .env.acceptance
$env:DEMO_PASSWORD = Read-Host 'Пароль тестового ведущего' -MaskInput
try {
  ./scripts/acceptance-compose.ps1 seed -EnvFile .env.acceptance
} finally {
  Remove-Item Env:DEMO_PASSWORD
}
```

## А. Ознакомление на одном компьютере

1. Войдите как `demo@nri.local`, сделайте копию **Amber Crossing: The Lantern Vault** и откройте её. Начните с **The Copper Kettle**, затем посмотрите **Blueglass Lane** и черновик **The Tollkeeper’s Vault**.
2. Проверьте карту, сетку, масштаб, панораму, токены и слои. Переместите токен, добавьте фигуру, попробуйте Undo/Redo. Отправьте сообщение, бросьте `d20` и переключите ход в инициативе.
3. Нажмите «Пригласить игроков». Откройте ссылку в отдельном профиле браузера, создайте тестового пользователя и сравните его стол с GM. Для двух игроков используйте два независимых профиля или разные браузеры. Две вкладки одного профиля разделяют аккаунт. Проверьте сохранение после обновления и запишите замечания.

Сценарий А позволяет освоить текущие возможности. Результаты совместной приёмки отмечаются только после сценария Б.

## Б. Игровая приёмка

Один GM и два независимых игрока проходят 30–60 минут в копии Amber Crossing. Для разных устройств нужен согласованный закрытый хост с доверенным HTTPS. Loopback доступен только с машины стенда. В чек-листе и плане остаются PERF-GPU, OPS-DEPLOY, OPS-RESTORE, OPS-RECOVERY и QA-OWNER. Все ручные отметки заполняют участники. [Сценарий приёмки](../releases/V0.1.1_MANUAL_ACCEPTANCE.md) · [Оставшиеся критерии](../releases/V0.1.1_FINAL_READINESS.md)

## Остановка и повторный запуск

```powershell
./scripts/acceptance-compose.ps1 down -EnvFile .env.acceptance
./scripts/acceptance-compose.ps1 up -EnvFile .env.acceptance
```

Остановка сохраняет тома PostgreSQL и media. Для проекта, запущенного с `-Project`, повторите тот же параметр в обеих командах.
