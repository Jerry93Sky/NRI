# Базовая производительность V0.1.1

Замер от 27 ноября 2026 года выполнен на Windows с Docker PostgreSQL 16.15 и собранными Node API и Vite frontend. Headless Chromium использовал ANGLE/SwiftShader. Значения относятся к программному рендерингу на loopback.

| Профиль | GM / Player | Токены | Объекты | Карта |
| --- | ---: | ---: | ---: | ---: |
| A | 1 / 4 | 30 | 100 | 2048×2048 |
| B | 1 / 6 | 100 | 500 | 4096×4096 |
| C | 1 / 12 | 500 | 2000 | 4096×4096 |

Socket.IO-клиенты подключаются от всех аккаунтов. Одна вкладка GM рендерит стол в Chromium 1366×768. Тест делает 24 перемещения и шесть переходов туда и обратно между заполненной и пустой сценой. Он использует процедурные PNG и реальные записи, сессии и команды PostgreSQL. Для C выбрана карта 4096 из-за лимита декодированных пикселей. Тестовый WebGL сообщил `MAX_TEXTURE_SIZE = 8192`.

## Воспроизведение

1. Создайте изолированную локальную PostgreSQL `nri_load`. Укажите её через `DATABASE_URL` и задайте отдельный `UPLOAD_DIR`. Для SQL-счётчиков запустите PostgreSQL с `shared_preload_libraries=pg_stat_statements` и создайте одноимённое расширение. Передайте имя контейнера через `NRI_LOAD_PG_CONTAINER`.
2. Выполните `corepack pnpm@12.23.0 db:migrate` и `node apps/server/scripts/seed-load-profiles.mjs` из корня репозитория. Файл `.data/nri-load/fixture.json` содержит краткоживущие тестовые сессии. Для нового набора переместите предыдущий файл.
3. Выполните `corepack pnpm@12.23.0 build`. Запустите `node dist/index.js` из `apps/server` с `PORT=3345`, `HOST=127.0.0.1`, `WEB_ORIGIN=http://127.0.0.1:4183` и тем же `UPLOAD_DIR`. Запустите `corepack pnpm@12.23.0 --filter @nri/web exec vite preview --host 127.0.0.1 --port 4183 --strictPort` с `API_PROXY_TARGET=http://127.0.0.1:3345`.
4. Установите Chromium Playwright и запустите `node apps/web/scripts/load-tabletop.mjs` из корня. JSON и скриншоты сохраняются локально в `.data/nri-load/`.

Длительность кадра измеряется через `requestAnimationFrame`. ACK и приход события на Player Socket.IO измеряются на одном монотонном таймере. Переключение сцены измеряется до получения снимка и двух paint callbacks. HTTP bytes и Socket.IO payload bytes получаются из Chrome DevTools Protocol. SQL и CPU/RSS API измеряются через `pg_stat_statements` и внутренний endpoint. Результаты и ограничения указаны в [LOAD_TEST_REPORT.md](LOAD_TEST_REPORT.md).
