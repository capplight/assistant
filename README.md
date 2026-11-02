# Память поездки — Telegram-бот

Пересылаешь боту рилсы, тиктоки, посты, скриншоты и брони, а он раскладывает всё по поездке и дням, отвечает на вопросы вроде «что я сохранял про еду?» и в нужный момент напоминает: о рейсе, о заселении, о месте, которое ты хотел посетить.

## Как устроено

```
Telegram ─► bot (aiogram) ─► items + jobs в Postgres ─► worker
                                                         ├─ oEmbed / файл / скриншот
                                                         ├─ Claude: смысл → JSON
                                                         ├─ место → Places API (кэш)
                                                         └─ эмбеддинг → «Сохранил: …»
scheduler ─► reminders (due_at) ─► сообщение пользователю
вопрос ─► qa: фильтры + SQL/PostGIS + поиск ─► ответ со ссылками на сохранённое
```

Один Postgres (pgvector + PostGIS) хранит данные, очередь задач и поиск. Отдельного Redis нет.

## Запуск локально

```bash
pip install -e ".[dev]"
cp .env.example .env        # заполнить BOT_TOKEN, ANTHROPIC_API_KEY и др.
docker compose up -d db     # нужен Docker Desktop
alembic upgrade head
python -m assistant.bot     # без WEBHOOK_BASE_URL работает через long polling
python -m assistant.worker
python -m assistant.scheduler
```

Тесты: `pytest`. Тесты с меткой `db` пропускаются, если не задан `DATABASE_URL`.

## Прод

`docker compose up -d` на сервере в Казахстане (QazCloud / PS Cloud): по закону 94-V персональные данные должны храниться в РК. Перед отправкой данных во внешние сервисы бот берёт явное согласие пользователя.

Правила разработки описаны в [CLAUDE.md](CLAUDE.md).
