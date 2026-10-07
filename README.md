# Цифровой набор для кафе — сайт и партнёрская программа

- `index.html` — страница набора для владельцев кафе (сюда ведут реф-ссылки партнёров)
- `partner/` — регистрация, вход и кабинет партнёра
- `admin/` — админка: заявки, статусы, партнёры, выплаты
- `config.js` — настройки: адрес сервера, телефон, ссылка на пример меню
- `backend/` — сервер (Cloudflare Worker) и таблицы базы D1
- `.github/workflows/deploy-server.yml` — автоматически выкладывает сервер в Cloudflare при каждом изменении папки `backend`

## Секреты репозитория (Settings → Secrets and variables → Actions)

| Имя | Что это |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Ключ API Cloudflare с правами на Workers и D1 |
| `CLOUDFLARE_ACCOUNT_ID` | ID аккаунта Cloudflare |
| `ADMIN_PASSWORD` | Пароль от админки |
| `TOKEN_SECRET` | Длинная случайная строка для входа партнёров. Не менять после запуска |

Ручной запуск развёртывания: вкладка Actions → «Развернуть сервер в Cloudflare» → Run workflow.

## Адреса

- Страница набора: https://ivan432123.github.io/qr-nabor/
- Партнёрам: https://ivan432123.github.io/qr-nabor/partner/
- Админка: https://ivan432123.github.io/qr-nabor/admin/
