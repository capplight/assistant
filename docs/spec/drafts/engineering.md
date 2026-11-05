# ТЗ — Инженерная часть (черновик)

Автор: инженерный лид. Дата: 2026-11-03. Основа: `00-brief.md` (решения основателя — базовая линия), `01-materials.md`, осмотр текущего кода `app/src/assistant`.
Смежные разделы пишут параллельно: продукт (`drafts/product.md`), дизайн (`drafts/design.md`), рынок и право (`drafts/market-legal.md`). Здесь — как это построить; что и зачем — у них.

Принцип раздела: решения основателя заложены как поведение по умолчанию. Там, где инженерия не согласна (#3, #5, #8, сроки и др.), альтернатива включается **настройкой** (`config`/feature flag), без переделки кода; сами разногласия — в разделе 13.

---

## 1. Архитектура

### 1.1 Схема

```
                    ┌──────────────────────────── ТЕЛЕФОН (iOS / Android, Expo) ────────────────────────────┐
                    │  Share-extension / intent  Микрофон  Камера/скан  Файлы   Уведомления/будильники        │
                    │        │                     │          │          │            ▲                      │
                    │        ▼                     ▼          ▼          ▼            │ (локальное расписание)│
                    │  ┌──────────────── SQLite (SQLCipher): items, reminders, outbox, FTS5 ───────────────┐ │
                    │  │ офлайн-сохранение · мгновенный поиск · очередь мутаций (client_id) · курсор sync  │ │
                    │  └───────────────────────────────┬──────────────────────────────────────────────────┘ │
                    │  Native-модули: alarms (AlarmKit iOS 26+ / AlarmManager Android), OCR (Apple Vision)    │
                    └──────────────────────────────────┼───────────────────────────────────────────────────────┘
                                                       │ HTTPS (TLS 1.2+), JWT; REST + SSE; presigned PUT в S3
════════════════════════════════════ КАЗАХСТАН (хостинг в KZ, закон 94-V ст.12) ════════════════════════════════════
                                                       ▼
   ┌─────────────── API (FastAPI, 2+ реплики) ───────────────┐        ┌──────── Object Storage (S3, KZ) ────────┐
   │ auth · consent gate · rate limits · entitlements        │──────▶ │ originals/ trash/ pinned/ renders/      │
   │ items · sync · search · ask(SSE) · reminders · КП       │        │ exports/  (SSE-шифрование, lifecycle)   │
   │ actions/undo · pending_actions("Да") · imports · export │        └─────────────────────────────────────────┘
   └──────┬───────────────────────────────┬──────────────────┘
          │ SQL                           │ enqueue (jobs)
          ▼                               ▼
   ┌──────────────── PostgreSQL 16/17 + pgvector + pg_trgm (managed, KZ) ─────────────────┐
   │ users, consents, items, chunks(vector), files, reminders, documents, actions,       │
   │ pending_actions, provider_usage, budgets, jobs (очередь SKIP LOCKED), imports       │
   └──────▲──────────────▲────────────────▲──────────────────▲───────────────▲────────────┘
          │              │                │                  │               │
   ┌──────┴─────┐ ┌──────┴──────┐ ┌───────┴───────┐ ┌────────┴──────┐ ┌──────┴────────────┐
   │ worker:    │ │ worker:     │ │ worker:       │ │ scheduler     │ │ worker: import     │
   │ ingest     │ │ ai (enrich, │ │ embed         │ │ push-фолбэк   │ │ (Telegram, изолир.)│
   │ STT·OCR·   │ │ КП, dedup-  │ │ bge-m3 (TEI,  │ │ напоминаний,  │ │ Takeout / export-  │
   │ PDF/DOCX/  │ │ judge,      │ │ CPU, в KZ)    │ │ корзина,      │ │ файл / бот         │
   │ XLSX/link  │ │ stacks)     │ └───────────────┘ │ бюджеты,      │ └────────────────────┘
   │ render PDF │ └──────┬──────┘                   │ дайджест      │
   └─────┬──────┘        │                          └───────┬───────┘
         │               │                                  │
═════════╪═══════════════╪══════════════════════════════════╪══════ ВЫХОД ЗА ПРЕДЕЛЫ KZ (только после согласия) ═══
         ▼               ▼                                  ▼
   STT: Groq Whisper   Provider Router ──▶ Anthropic (Claude Haiku/Sonnet 5.5)          FCM (Google) / APNs (Apple)
   → OpenAI transcribe  (circuit breaker,  ──▶ OpenAI (gpt-6-luna / gpt-6.1-terra)        минимальный payload
                        бюджеты, валидация)──▶ Google Gemini (2.5 Flash-Lite)
```

### 1.2 Компоненты

| Компонент | Ответственность | Процесс |
|---|---|---|
| Мобильное приложение | Захват (share/голос/фото/файлы), офлайн-хранилище и поиск, локальное расписание будильников, UI «Главная · Найти · Дела», подтверждения «Да», отправка через share sheet | Expo (dev build, не Expo Go) |
| API | Авторизация, consent gate, лимиты, CRUD, sync, SSE-ответы, выдача presigned URL | `python -m assistant.api` (uvicorn) |
| worker-ingest | Нормализация входа: STT, OCR, парсинг PDF/DOCX/XLSX, ссылки, письма; рендер PDF/DOCX КП (WeasyPrint тяжёлый — держим здесь, не в API) | `python -m assistant.worker --queues ingest,render` |
| worker-ai | «Конверт обогащения», намерения, КП-генерация/правки, near-dup судья, имена стопок, ответы фоновых задач | `--queues ai` |
| worker-embed | Чанкинг + эмбеддинги bge-m3 через локальный TEI-контейнер (CPU) | `--queues embed` |
| scheduler | Push-фолбэк напоминаний (нет ack), очистка корзины оригиналов, сброс бюджетов, пересчёт стопок, дайджест, истечение pending_actions | `python -m assistant.scheduler` (переиспользуем каркас) |
| worker-import | Импорт Telegram (изолирован: свой контейнер, свои секреты, без доступа к S3 кроме `imports/`) | `--queues import` |
| TEI | `text-embeddings-inference` (CPU) с моделью `BAAI/bge-m3` | контейнер, только внутренняя сеть |
| Наблюдаемость | Prometheus + Grafana + Loki, GlitchTip/Sentry self-hosted — всё в KZ | контейнеры на ops-VM |

Правила (переносятся из текущего `CLAUDE.md`): модули общаются только через схему БД, очередь `jobs` и публичные функции пакетов; ни одна транзакция не открыта во время сетевого вызова; сначала коммит результата, потом уведомление; внешние клиенты — маленькие классы, в тестах заменяемые фейками.

### 1.3 Развёртывание в KZ

- **Хостинг**: облако с регионом в Казахстане (кандидаты — Yandex Cloud KZ, PS Cloud, QazCloud/Казахтелеком; выбор — неделя 0 по чек-листу: managed Postgres с `pgvector` и `pg_trgm`, S3-совместимое хранилище, KMS, бэкапы/PITR, SLA, юрлицо и договор в KZ). Вопрос собственности/санкционных рисков — в разделе 13 (И-8).
- **Старт (до ~5 000 пользователей)**:
  - Managed PostgreSQL: 2 vCPU / 8 GB / 100 GB SSD, PITR 7 дней, реплика — позже.
  - VM-1 (app): 4 vCPU / 8 GB — API ×2, worker-ingest, worker-ai, scheduler, Caddy (TLS).
  - VM-2 (ml): 8 vCPU / 16 GB — TEI bge-m3, worker-embed, Tesseract-OCR, ffmpeg; worker-import в отдельном контейнере.
  - VM-3 (ops, маленькая): Prometheus, Grafana, Loki, GlitchTip.
  - Object Storage в KZ; бакеты `prod-originals`, `prod-renders`, `prod-exports`, `prod-backups`.
  - Ориентир фикс. затрат ~$200–230/мес (CFO).
- **Деплой**: Docker-образы из CI → registry в KZ (или GHCR, образ без данных) → `docker compose pull && up` по SSH с blue/green для API (две реплики за Caddy). Миграции — отдельный one-shot контейнер `migrate` (как сейчас в `docker-compose.yml`) до выкатки кода, только «расширяющие» миграции (expand → migrate → contract).
- **Сеть**: наружу открыт только 443 (Caddy). Postgres/TEI — во внутренней сети. Исходящий трафик за рубеж — только к allowlist доменов провайдеров ИИ/STT, FCM, APNs, SMS-шлюза.
- **CI вне KZ**: GitHub Actions работают только с синтетическими данными; прод-данные никогда не попадают в CI.

---

## 2. Стек

### 2.1 Мобильное приложение

- **React Native + Expo** (актуальный стабильный SDK на момент старта, New Architecture), TypeScript strict. **EAS Build / EAS Submit**, dev build (нужны свои native-модули). `expo-updates` — только для JS-фиксов; нативные изменения — через стор.
- Навигация: `expo-router` (3 вкладки «Главная · Найти · Дела» + модальные экраны).
- Состояние: TanStack Query (серверное), Zustand (UI), локальная БД — `expo-sqlite` с SQLCipher (config plugin) + `drizzle-orm` для схемы/миграций на устройстве; FTS5 для офлайн-поиска.
- **Share intent**: `expo-share-intent` (iOS Share Extension + Android intent-filters `SEND`/`SEND_MULTIPLE` для text/plain, image/*, application/pdf, office-типов, audio/*). Share Extension сам ничего не обрабатывает: кладёт файл в App Group контейнер + запись в общую SQLite-очередь, приложение отправляет при следующем запуске/фоне. Проверить лимит памяти extension (~120 MB) на больших PDF.
- **Аудио**: `expo-audio` (запись AAC-LC моно 16 kHz ~24 kbps; 1 мин ≈ 180 KB), индикатор уровня, лимит 10 мин на запись.
- **Камера/скан**: `expo-image-picker`, `expo-camera`; скан документов — VisionKit (iOS) / ML Kit Document Scanner (Android) через проверенный community-модуль или свой (Expo Modules API). Фото сжимаются на устройстве до 2048px JPEG q0.8 перед загрузкой.
- **OCR на устройстве**: iOS — Apple Vision (`VNRecognizeTextRequest`, языки проверяем в рантайме через `supportedRecognitionLanguages`; казахский — проверить); Android — ML Kit **не поддерживает кириллицу** → OCR на сервере. Флаг `ocr.on_device_ios`.
- **Файлы**: `expo-document-picker`, `expo-file-system`, загрузка напрямую в S3 по presigned PUT (`uploadAsync`, фоновые сессии на iOS).
- **Уведомления и будильники**:
  - `expo-notifications` — разрешения, обычные/time-sensitive уведомления, категории действий («Готово», «Отложить 10 мин»), получение **нативных** токенов (`getDevicePushTokenAsync`) — шлём сами через FCM HTTP v1 / APNs, **не через Expo Push Service** (лишний зарубежный посредник).
  - Свой native-модуль `alarms` (Expo Modules API):
    - iOS 26+: **AlarmKit** (`AlarmManager.schedule`, `NSAlarmKitUsageDescription`), обходит беззвучный режим и фокус; Live Activity для обратного отсчёта.
    - iOS < 26: time-sensitive local notifications (entitlement), критичные звуки — нет (Critical Alerts требуют одобрения Apple — заявку подать, но не рассчитывать).
    - Android: `AlarmManager.setAlarmClock()` для «будильника», `setExactAndAllowWhileIdle()` для обычных; `SCHEDULE_EXACT_ALARM` (на 14+ по умолчанию выключено — экран-объяснение + переход в настройки); `USE_FULL_SCREEN_INTENT` (декларация в Play; если не выдано — heads-up уведомление на канале с высоким приоритетом и звуком будильника); `RECEIVE_BOOT_COMPLETED` + `TIME_SET`/`TIMEZONE_CHANGED` для перепланирования; foreground-activity экрана будильника с кнопками «Выключить / Отложить».
  - Модуль `battery-guide`: определяет производителя (Xiaomi/HyperOS, Samsung, Tecno/Infinix, Huawei), проверяет `isIgnoringBatteryOptimizations`, открывает нужный экран настроек (автозапуск MIUI, «Без ограничений» Samsung) — экраны-подсказки в дизайне.
- Фон: `expo-background-task` (периодический sync, пополнение «скользящего окна» iOS-уведомлений), silent push для пополнения.
- Безопасность: `expo-secure-store` (refresh token, ключ SQLCipher), опционально `expo-local-authentication` (вход по Face ID/отпечатку).
- Отправка: `expo-sharing` (PDF → WhatsApp/любое приложение), `expo-mail-composer` (письмо с вложением в почтовом приложении), `Linking` для `whatsapp://send?phone=&text=` (только текст).
- Стриминг SSE: `expo/fetch` (поддерживает stream) или `react-native-sse`.
- i18n: `i18next` RU/KK, плюрализация для казахского; шрифты с казахскими глифами (ә ғ қ ң ө ұ ү һ і) — проверка в дизайне.
- Анимация: `react-native-reanimated` (стопки), списки — `@shopify/flash-list`.
- Ошибки: `@sentry/react-native` → self-hosted GlitchTip/Sentry в KZ, скраббинг текста пользователя.
- Тесты: Jest + React Native Testing Library; E2E — Maestro (Android-эмулятор в CI, реальные телефоны вручную).

### 2.2 Backend

- Python 3.13, FastAPI, Uvicorn, Pydantic v2, SQLAlchemy 2 async + asyncpg, Alembic (замороженные SQL-миграции — как сейчас), `sse-starlette`.
- PostgreSQL 16/17 + `pgvector` (HNSW) + `pg_trgm` (опечатки, казахская морфология — стеммера для kk в Postgres нет). **PostGIS больше не нужен** (места/гео — травел-наследие) → проще managed-БД.
- Очередь — существующая Postgres-очередь `jobs` (`FOR UPDATE SKIP LOCKED`), доработанная (раздел 3/8). Redis в MVP не вводим.
- Хранилище — S3-совместимое в KZ (`aioboto3`), presigned PUT/GET с коротким TTL.
- Парсинг: `pdfplumber` + `pypdfium2` (не PyMuPDF — AGPL), `python-docx`, `python-calamine`/`openpyxl`, `trafilatura` (ссылки), `email` stdlib (.eml), `ffmpeg` (аудио), Tesseract 5 (`rus+kaz+eng`) — серверный OCR.
- ИИ-SDK: `anthropic`, `openai`, `google-genai` — каждый только внутри своего адаптера.
- КП: `jsonpatch` (RFC 6902), `decimal`, Jinja2 + **WeasyPrint** (PDF), `docxtpl` (DOCX), `openpyxl` (XLSX), `num2words` (сумма прописью RU; KK — проверить поддержку, иначе свой модуль).
- Даты/время: `dateparser` + собственные правила RU/KK для напоминаний; `zoneinfo`.
- Дедупликация: `rapidfuzz`, `datasketch` (MinHash/LSH) или SimHash; pg_trgm `similarity()`.
- Эмбеддинги: TEI + `BAAI/bge-m3` (1024 dim — совпадает с текущим `EMBEDDING_DIM`).
- Push: FCM HTTP v1 (httpx + service account JWT), APNs HTTP/2 (`aioapns` или httpx[http2]).
- SMS OTP: казахстанский шлюз (Mobizon / SMSC.kz — выбрать), за адаптером `SmsSender`.
- Telegram-импорт: Telethon (Takeout API) — за флагом (раздел 6.1.9).
- Наблюдаемость: `prometheus-client`, `sentry-sdk` (на self-hosted DSN), существующий `assistant.logs`.
- Качество: ruff, mypy (постепенно, на новых пакетах strict), pytest, pytest-asyncio, hypothesis (КП), testcontainers не нужен — в CI сервис-контейнер Postgres.

### 2.3 Инфраструктура и CI

- GitHub Actions:
  1. `backend-lint`: ruff, mypy.
  2. `backend-unit`: pytest без БД (фейки сети).
  3. `backend-db`: service-контейнер `pgvector/pgvector:pg17` → `alembic upgrade head` → `pytest -m db` → `alembic downgrade` на один шаг и обратно (проверка обратимости expand-миграций). **Обязателен для merge.**
  4. `golden` (ночью + по label `prompts` в PR): прогон golden set на всех включённых провайдерах с реальными ключами тестового аккаунта, отчёт в артефакт, падение при регрессии > порога.
  5. `mobile`: tsc, eslint, jest; Maestro на Android-эмуляторе для 5 ключевых сценариев.
  6. `release`: тег → Docker-образы → деплой staging → ручное подтверждение → prod; EAS Build по тегу `mobile-v*`, EAS Submit во внутреннее тестирование.
- Окружения: `dev` (docker compose локально), `staging` (в KZ, синтетические данные), `prod`.
- Секреты: GitHub Environments (CI), на серверах — файлы `.env` с правами 600 или секрет-менеджер облака; ключ шифрования полей — в KMS облака (KZ).
- Бэкапы: PITR managed-БД 7 дней + ежедневный зашифрованный `pg_dump` в `prod-backups` (хранение 30 дней) + ежемесячная проверка восстановления.

---

## 3. Модель данных

Соглашения: внутренние PK — `bigint` (как сейчас, меньше переделок); наружу и для офлайн-создания — `public_id uuid` (UUIDv7) и `client_id uuid` с `UNIQUE(user_id, client_id)` = идемпотентность. Каждая синхронизируемая таблица имеет `seq bigint` (из общей последовательности `sync_seq`, обновляется триггером на insert/update) и `deleted_at`. Перечисления — `text + CHECK` вместо Postgres `ENUM` (текущие enum-типы тяжело расширять). Время — aware UTC + IANA tz где важно.

### 3.1 Пользователи, вход, устройства, согласия

**users**: `id`, `public_id`, `display_name`, `locale` (ru|kk), `tz` (default `Asia/Almaty`), `country` (из номера/стора), `autonomy_mode` (ask_always|do_small, default ask_always), `plan` (free|…, хук для тарифов), `status` (active|deleting|deleted), `delete_requested_at`, `created_at`, `last_seen_at`, `telegram_id` (nullable, наследие), `consent_at` (deprecated, перенесено в consents).

**auth_identities**: `id`, `user_id`, `provider` (anon_device|phone|apple|google), `subject_hash` (HMAC-SHA256 от E.164/sub), `subject_enc` (AES-GCM, телефон нужен для SMS), `verified_at`, `created_at`; `UNIQUE(provider, subject_hash)`.

**auth_sessions**: `id`, `user_id`, `device_id`, `refresh_hash`, `expires_at` (60 дней, скользящий), `rotated_from`, `revoked_at`, `created_ip_hash`.

**otp_challenges**: `id`, `phone_hash`, `code_hash`, `attempts`, `expires_at` (5 мин), `device_id`, `ip_hash`, `created_at`. Лимиты: 3 SMS/час на номер, 10/сутки на устройство, защита от SMS-pumping (Play Integrity / App Attest токен обязателен для запроса OTP).

**devices**: `id`, `public_id`, `user_id`, `platform` (ios|android), `os_version`, `manufacturer`, `model`, `app_version`, `push_provider` (fcm|apns), `push_token`, `locale`, `tz`, `capabilities jsonb` (alarmkit, exact_alarm_granted, full_screen_intent, notifications_granted, battery_unrestricted, ocr_on_device_langs), `last_sync_seq`, `last_seen_at`, `revoked_at`.

**consents**: `id`, `user_id`, `kind` (ai_cross_border | telegram_import | push_content | analytics), `version` (например `ai-2026-11-v1`), `providers text[]` (явный список: Anthropic, OpenAI, Google, Groq, Apple/Google push), `text_hash` (хэш показанного текста), `locale`, `granted_at`, `revoked_at`, `device_id`, `ip_hash`. Активное согласие = последнее не отозванное по `kind`.

### 3.2 Память

**items** (одна сохранённая «вещь»): `id`, `public_id`, `client_id`, `user_id`,
`kind` (note|voice|image|screenshot|pdf|docx|xlsx|link|email|tg_message|kp|file_other),
`source` (typed|mic|share|camera|files|import_telegram|email_forward|system),
`status` (pending|processing|ready|needs_review|failed),
`title`, `text` (каноничный извлечённый текст — то, что храним вместо оригинала), `text_lang`, `summary`,
`envelope jsonb` (конверт обогащения, раздел 6.2) + `envelope_version`, `confidence`, `review_fields jsonb` (что подсветить «проверьте»: номера, суммы, телефоны из OCR/STT),
`source_meta jsonb` (имя файла, длительность, страниц, URL, отправитель, tg chat/msg id, исходная дата),
`occurred_at` (когда событие/запись произошло по смыслу), `content_hash` (sha256 нормализованного текста), `original_sha256`, `simhash bigint`,
`canonical_item_id` (если склеен как дубль), `hidden_reason` (duplicate_merged|trashed|null),
`tsv_simple tsvector`, `tsv_ru tsvector` (два конфига: без стемминга для kk/смеси и `russian`), `seq`, `created_at`, `updated_at`, `processed_at`, `deleted_at`, `error`.
Индексы: GIN по обоим tsv, GIN trgm по `title`, `(user_id, seq)`, `(user_id, content_hash)`, `(user_id, original_sha256)`, `(user_id, occurred_at)`.

**chunks**: `id`, `item_id`, `user_id`, `ord`, `text`, `token_count`, `embedding vector(1024)`, `embedding_model` (`bge-m3@<rev>`), `embedded_at`. HNSW-индекс **частичный** `WHERE embedding_model = '<текущая>'`; смена модели = новый частичный индекс + фоновый re-embed, поиск переключается флагом. Короткие заметки = 1 чанк; документы — ~400 токенов, перекрытие 50, границы по абзацам/строкам таблиц.

**files** (оригиналы и производные файлы): `id`, `user_id`, `item_id` (nullable), `role` (original|company_logo|company_template|kp_render|price_list|export), `storage_key`, `mime`, `bytes`, `sha256`,
`state` (active|trash|pinned|purged), `pinned_by` (user|auto_rule|policy), `keep_reason` (low_confidence|size_rule|deal_active|template|user_pin), `trash_until`, `purged_at`, `created_at`.
Политика хранения — раздел 7.1.

**tasks** (вкладка «Дела», списки покупок): `id`, `public_id`, `client_id`, `user_id`, `item_id`, `list_key` (shopping|todo|…), `title`, `due_date`, `done_at`, `seq`, `deleted_at`.

**collections** (стопки/умные группы): `id`, `public_id`, `user_id`, `kind` (smart|duplicates|deal|manual), `title`, `title_kk`, `rule jsonb` (ключ темы/сущности, порог), `item_count`, `before_after jsonb` (например `{"before":37,"after":1}`), `created_by` (agent|user), `last_opened_at`, `hidden_at` (скрыта, если 30 дней не открывали), `seq`, `deleted_at`.
**collection_items**: `collection_id`, `item_id`, `score`, `added_by`, PK(collection_id, item_id).

**duplicates**: `id`, `user_id`, `item_a`, `item_b` (a<b), `kind` (exact|near), `score`, `method` (hash|simhash|trgm|embedding|llm_judge), `status` (suggested|merged|dismissed|undone), `action_id`, `created_at`; `UNIQUE(item_a,item_b)`.

### 3.3 Напоминания

**reminders**: `id`, `public_id`, `client_id`, `user_id`, `item_id`, `title`, `body`, `due_at` (UTC), `tz`, `rrule` (RFC 5545, nullable), `level` (normal|important|alarm), `status` (scheduled|fired|acked|snoozed|done|cancelled|missed), `parse_source` (rules|llm|user_edit), `snooze_until`, `next_occurrence_at`, `push_fallback_after` (due + 3–5 мин), `push_sent_at`, `attempts`, `version` (оптимистическая блокировка), `seq`, `created_at`, `updated_at`, `deleted_at`.

**reminder_events**: `id`, `reminder_id`, `occurrence_at`, `device_id`, `event` (scheduled_local|schedule_failed|fired_local|shown|acked|snoozed|dismissed|push_sent|push_failed|missed), `at`, `meta jsonb` (тип планировщика: alarmkit/exact/inexact/notification). Источник метрики «доставляемость напоминаний».

### 3.4 Документы / КП

**company_profiles**: `id`, `user_id`, `name`, `legal_form` (ИП|ТОО|…), `bin_iin`, `address`, `bank jsonb` (IBAN, БИК, банк, КБе), `contacts jsonb`, `vat_payer bool`, `logo_file_id`, `template_id`, `default_terms jsonb` (оплата, срок поставки, срок действия), `updated_at`.

**doc_templates**: `id`, `owner` (system|user), `kind` (kp), `engine` (html|docx), `version`, `storage_key`, `fonts_hash`, `created_at`. Шаблон версии неизменяем → рендер воспроизводим.

**price_lists** / **price_list_items**: `id`, `user_id`, `file_id`, `uploaded_at` / `id`, `price_list_id`, `sku`, `name`, `unit`, `price numeric(14,2)`, `currency`, `name_tsv`, `name_trgm`.

**documents**: `id`, `public_id`, `user_id`, `kind` (kp|letter), `title`, `client jsonb`, `status` (draft|ready|sent|archived), `current_version_id`, `source_item_ids bigint[]` (ТЗ клиента), `deal_active bool` (пока true — оригиналы ТЗ не удаляются, если включено), `seq`, `created_at`, `updated_at`, `deleted_at`.

**document_versions**: `id`, `document_id`, `n`, `data jsonb` (каноничная модель КП без итогов), `totals jsonb` (вычислено кодом), `calc_version` (версия алгоритма расчёта), `vat_rate numeric(5,2)` (зафиксированная на момент версии), `template_id`, `patch jsonb` (RFC 6902 от предыдущей), `author` (initial|tap_edit|agent_request|revert), `request_text`, `render_file_id` (nullable; по политике — только для отправленных версий или никогда), `created_at`; `UNIQUE(document_id, n)`.

### 3.5 Действия агента, подтверждения, импорт

**actions** («Что я сделал»): `id`, `public_id`, `user_id`, `kind` (save_item|merge_duplicates|create_reminder|create_stack|edit_kp|create_kp|delete_item|send_external|import_batch|…), `scope` (internal|external), `initiated_by` (user|agent), `summary jsonb` (`{"ru": "...", "kk": "..."}`), `payload jsonb`, `inverse jsonb` (рецепт отмены: список операций обратного применения), `undoable_until` (default +30 дней; для external — `null`, отменить нельзя), `undone_at`, `undo_of_action_id`, `source_item_ids`, `seq`, `created_at`.

**pending_actions** (внешние/необратимые, ждут «Да»): `id`, `public_id`, `user_id`, `kind` (send_whatsapp|send_email|share_file|delete_permanently|change_reminder|share_third_party|start_import), `preview jsonb` (критичные детали, **сформированные кодом** из структурных данных: получатель, сумма, время, файл), `confirm_token_hash`, `status` (proposed|confirmed|rejected|expired|executed|failed|cancelled_by_user), `expires_at` (24 ч), `origin_action_id`, `decided_at`, `executed_at`, `result jsonb`, `seq`.

**imports**: `id`, `user_id`, `source` (telegram_takeout|telegram_export_file|telegram_bot_forward|files_bulk|email_mbox), `status` (created|awaiting_code|running|paused_budget|done|failed|cancelled), `consent_id`, `total`, `processed`, `skipped_dups`, `failed`, `cursor jsonb`, `session_enc bytea` (только Takeout, AES-GCM, TTL ≤ 60 мин), `session_expires_at`, `budget_usd`, `cost_usd`, `started_at`, `finished_at`, `error`.

### 3.6 Деньги, лимиты, очередь

**provider_usage** (партиционирование по месяцу): `id`, `user_id` (nullable — системные задачи), `task` (enrich|intent|answer|kp_extract|kp_edit|draft|stack_name|dup_judge|vision_ocr|stt|import_summarize), `provider`, `model`, `request_id`, `tokens_in`, `tokens_out`, `cached_in`, `audio_seconds`, `images`, `cost_usd numeric(12,6)`, `latency_ms`, `outcome` (ok|rate_limited|quota|server_error|timeout|invalid_output|refused|circuit_open|budget_blocked), `fallback_from`, `attempt`, `job_id`, `created_at`.

**budgets**: `id`, `scope` (provider|user|user_import|global), `key`, `period` (day|month|once), `limit_usd`, `spent_usd`, `period_start`, `state` (ok|warn|off), `updated_at`. Обновление атомарно (`UPDATE … SET spent_usd = spent_usd + $1 RETURNING`).

**usage_counters** (хуки бесплатных лимитов): `user_id`, `period_start`, `counter` (items|questions|kp|voice_minutes|import_items), `value`; PK(user_id, period_start, counter). Значения лимитов — в `config` (продукт решит позже, решение #4).

**jobs** (доработка существующей): + `queue` (ingest|ai|embed|render|import|maintenance), `priority smallint`, `user_id`, `idempotency_key` (`UNIQUE` где не null), `stale_after interval` (вместо глобальных 30 мин), `result jsonb`, `finished_at`.

**sync_tombstones**: `user_id`, `entity`, `public_id`, `seq` — для удалений при синхронизации (или `deleted_at` + `seq` в самих таблицах; tombstones — для жёстко удалённых).

**audit_log**: `id`, `user_id`, `event` (login|otp_failed|export|delete_request|consent_change|original_downloaded|import_started), `meta jsonb` (без содержимого), `created_at`. Хранение 1 год.

### 3.7 План миграции с текущей (травел) схемы

Текущая схема: `users(telegram_id NOT NULL UNIQUE, consent_at)`, `trips`, `items(trip_id, telegram_chat_id/message_id NOT NULL, url UNIQUE на пользователя, category/city/country, embedding vector(1024), tsv simple)`, `places/item_places/place_queries` (PostGIS), `bookings`, `reminders(trip_id, booking_id, kind)`, `jobs`, `processed_updates`. Миграция `0001` заморожена.

Шаг 0 (неделя 0): поднять БД в CI, `alembic upgrade head`, прогнать все 300 тестов **с** БД; зафиксировать фактическое состояние. Выяснить, есть ли прод-данные травел-бота. Если реальных пользователей нет — допустим укороченный путь (0002 сразу архивирует всё травел-специфичное).

| Миграция | Что делает |
|---|---|
| `0002_core_generalize` (expand) | Новые таблицы: auth_identities, auth_sessions, otp_challenges, devices, consents, files, chunks, tasks, collections, collection_items, duplicates, reminder_events, actions, pending_actions, imports, provider_usage, budgets, usage_counters, sync_tombstones, audit_log; последовательность `sync_seq` + триггеры `seq`. `users`: `telegram_id` → nullable, + public_id/locale/status/autonomy_mode/plan; backfill `consents` из `users.consent_at` (kind=ai_cross_border, version=`legacy-bot`). `items`: `telegram_chat_id/message_id` → nullable (копия в `source_meta`), + новые колонки; enum-колонки `kind/source/status` → `text + CHECK` (через `ALTER COLUMN … TYPE text USING …`), маппинг значений (photo→image, document→pdf/file_other, done→ready). `UNIQUE(user_id,url_hash)` → обычный индекс (дубль ссылки = запись в duplicates, а не отказ). Второй tsvector `tsv_ru` + обновлённый триггер. `jobs`: новые колонки. |
| `0003_reminders_generalize` | `reminders`: + новые колонки, `kind` сохраняем как legacy; FK на trips/bookings → nullable, перенос в `payload`. Статусы → text + CHECK. |
| `0004_chunks_backfill` | Перенос `items.embedding` не делаем (Voyage ≠ bge-m3): ставим job `reembed_all` → заполняет `chunks`. Колонку `items.embedding` и её HNSW удаляем в contract-миграции после проверки. |
| `0005_documents` | company_profiles, doc_templates, price_lists(+items), documents, document_versions. |
| `0006_legacy_archive` (contract) | `CREATE SCHEMA legacy`; `ALTER TABLE trips, places, item_places, place_queries, bookings SET SCHEMA legacy`; удалить `items.trip_id/category/city/country`, `items.embedding`; drop `processed_updates`, если бот не остаётся каналом импорта (вариант «пересылка в бота» — оставить). PostGIS-расширение удалить после переноса legacy в дамп. |

Код при этом: `db/models.py` переписывается под новую схему; legacy-модели — в `db/legacy.py` только для скрипта переноса.

---

## 4. API

База `https://api.<домен>/v1`, JSON, JWT access (15 мин) в `Authorization`, refresh — ротация. Все мутирующие запросы принимают `Idempotency-Key` (или `client_id` в теле); повтор возвращает тот же ответ (таблица `idempotency_keys` с TTL 48 ч). Ошибки — `{code, message_ru, message_kk, retry_after?}`. Версия схемы ответа — заголовок `X-Api-Version`; клиент сообщает `X-App-Version` (сервер может потребовать обновление).

### 4.1 Вход и профиль
| Метод | Назначение |
|---|---|
| `POST /auth/anonymous` | Первый запуск: регистрирует устройство, создаёт анонимного пользователя (вход без логина в первые 60 с), выдаёт токены |
| `POST /auth/otp/request` | SMS-код на номер (с App Attest / Play Integrity токеном, лимиты) |
| `POST /auth/otp/verify` | Привязать номер к анонимному аккаунту или войти в существующий (слияние данных устройства) |
| `POST /auth/apple`, `POST /auth/google` | Опционально (после MVP), за флагом |
| `POST /auth/refresh`, `POST /auth/logout` | Ротация/отзыв сессии |
| `GET /me`, `PATCH /me` | Имя, язык, tz, режим автономии |
| `GET /me/usage` | Потребление лимитов (хуки тарифов) |

### 4.2 Согласия и устройства
| `GET /consents/text?kind=&locale=` | Текст согласия + список провайдеров + версия (для App Store 5.1.2(i)) |
|---|---|
| `POST /consents` | Дать согласие (kind, version, text_hash) |
| `DELETE /consents/{kind}` | Отозвать: ИИ-функции отключаются, сохранение/напоминания/поиск по тексту работают |
| `GET /consents` | История |
| `POST /devices`, `PATCH /devices/{id}`, `DELETE /devices/{id}` | Регистрация, push-токен, возможности (exact alarm, AlarmKit, батарея) |

### 4.3 Захват и память
| `POST /uploads` | Presigned PUT в S3 (mime, size ≤ 50 MB, sha256) → `upload_id` |
|---|---|
| `POST /uploads/{id}/complete` | Подтвердить загрузку |
| `POST /items` | Создать вещь: текст / upload_id / url / source; идемпотентно по `client_id`; ставит job ingest |
| `GET /items?cursor=&kind=&collection=` | Список |
| `GET /items/{id}` | Вещь с источником («из голосового, 3 ноя, 0:42»), review_fields |
| `PATCH /items/{id}` | Исправить текст/название, подтвердить поля «проверьте» (исправления → обучающий сигнал для golden set) |
| `DELETE /items/{id}`, `POST /items/{id}/restore` | В корзину / вернуть (внутреннее действие, с undo) |
| `POST /items/{id}/original/pin`, `DELETE …/pin` | «Сохранить оригинал» / снять |
| `GET /items/{id}/original` | Presigned GET (TTL 5 мин), запись в audit_log |
| `POST /commands` (SSE) | Единая точка «Скажите что угодно»: фраза/голос → намерение (сохранить / напомнить / спросить / КП / черновик / найти) → результат или предложение. События: `understood` (как понято — показываем до действия), `action`, `pending_action`, `answer_token`, `sources`, `done` |

### 4.4 Синхронизация, поиск, ответы
| `GET /sync?since=<seq>&limit=` | Дельта по items, reminders, tasks, collections, actions, pending_actions, documents(meta) + tombstones; `next_seq` |
|---|---|
| `POST /sync/push` | Пакет офлайн-мутаций с `client_id`, `base_version`; ответ — по каждой: applied/conflict(server_state) |
| `GET /search?q=&kind=&from=&to=&collection=` | Без LLM: FTS (simple+ru) + trgm + вектор + фильтры → RRF; сниппеты с подсветкой |
| `POST /ask` (SSE) | Вопрос по всем данным: события `status`, `sources` (до текста), `token`, `citations`, `done`, `error`; при недоступности ИИ — `deferred` («Сохранил вопрос, ответ пришлю») |
| `GET /home` | Сегодня / Я сделал / Предложения / Стопки (агрегат для главной; кэшируется на устройстве) |

### 4.5 Напоминания и дела
| `POST /reminders`, `PATCH /reminders/{id}` (с `version`), `DELETE /reminders/{id}` | CRUD; изменение существующего, предложенное агентом, идёт через pending_action |
|---|---|
| `GET /reminders?from=&to=` | Окно для локального планирования |
| `POST /reminders/events` | Пакет событий устройства: scheduled_local / fired / shown / acked / snoozed / dismissed — **ack** |
| `POST /reminders/parse` | Разбор фразы без сохранения (для предпросмотра «Завтра 10:00 позвонить Ерлану») |
| `/tasks` CRUD | Дела и списки покупок |

### 4.6 Дубли и стопки
| `GET /duplicates?status=suggested` | Предложенные группы |
|---|---|
| `POST /duplicates/cleanup` | Разовая уборка: строит план, применяет точные дубли (internal, undo), near — как предложение |
| `POST /duplicates/{id}/merge`, `/dismiss` | Решение пользователя |
| `GET /collections`, `GET /collections/{id}`, `PATCH /collections/{id}` | Стопки: открыть, переименовать, скрыть |

### 4.7 Документы / КП и черновики
| `GET/PUT /company-profile` | Реквизиты, логотип, условия |
|---|---|
| `POST /company-profile/extract` | Из фото визитки / старого КП → предзаполнение (с подтверждением) |
| `POST /price-lists` | Загрузка прайса (XLSX/PDF) → позиции |
| `POST /documents/kp` | Из item_ids (ТЗ клиента) + пожелания → job → черновик КП |
| `GET /documents/{id}`, `GET /documents/{id}/versions/{n}` | Данные + вычисленные итоги + diff |
| `POST /documents/{id}/edit` | Правка обычной фразой → предпросмотр патча «было → стало» |
| `POST /documents/{id}/patch` | Применить JSON Patch (тап-правки без ИИ или подтверждённый предпросмотр), `base_version` |
| `POST /documents/{id}/revert` | Вернуть версию n |
| `POST /documents/{id}/render?format=pdf\|docx\|xlsx` | Файл → presigned GET |
| `POST /documents/{id}/send` | Создаёт pending_action (WhatsApp/почта/поделиться) |
| `POST /drafts` | Черновик сообщения/письма из контекста → pending_action |

### 4.8 Действия и подтверждения
| `GET /actions?cursor=` | «Что я сделал» |
|---|---|
| `POST /actions/{id}/undo` | Отмена (применяет `inverse`; создаёт новое action с `undo_of_action_id`) |
| `GET /pending-actions` | Ждут «Да» |
| `POST /pending-actions/{id}/confirm` | «Да» → возвращает исполнимый payload для устройства (share-параметры, mailto, файл) |
| `POST /pending-actions/{id}/reject` | «Не сейчас» |
| `POST /pending-actions/{id}/result` | Устройство сообщает: открыт share sheet / пользователь отменил / отправлено |

### 4.9 Импорт, экспорт, удаление
| `POST /imports/telegram/file` | Загрузка экспорта Telegram Desktop (`result.json`/zip) |
|---|---|
| `POST /imports/telegram/login/start` → `/code` → `/password` | Вход через Takeout (решение #5, за флагом `telegram_import.login_enabled`) |
| `GET /imports/{id}`, `POST /imports/{id}/cancel` | Прогресс («Принёс 640 заметок, 212 повторов убрал») / отмена |
| `POST /export` → `GET /export/{id}` | Экспорт всего одним касанием: ZIP (JSON + Markdown по вещи + сохранённые оригиналы + КП в PDF), ссылка 24 ч |
| `DELETE /me` | Удаление аккаунта в приложении (App Store 5.1.1(v)); то же — веб-страница для Google Play |
| `POST /feedback` | «Неправильно понял» + разрешение использовать пример (кандидаты в golden set) |
| `GET /healthz`, `/readyz`; внутр. `/metrics` | Служебные |

---

## 5. ИИ-слой

### 5.1 Provider router

**Интерфейс** (Pydantic — источник истины):
```python
class LLMTask(StrEnum): ENRICH, INTENT, REMINDER_PARSE, ANSWER, QUERY_PLAN, KP_EXTRACT, KP_EDIT,
                        DRAFT, STACK_NAME, DUP_JUDGE, VISION_OCR, IMPORT_SUMMARIZE, PROFILE_EXTRACT
async def run(task, schema: type[BaseModel], inputs: TaskInputs, *, user_id, stream=False) -> Result
```
Адаптеры (по одному классу на провайдера, единый `ProviderAdapter` Protocol):
- Anthropic: `messages.parse(output_format=Schema)` (как сейчас в `pipeline/llm.py`), `effort` low/medium; стриминг для ANSWER.
- OpenAI: Responses API, `text.format = json_schema, strict=true`.
- Gemini: `responseSchema` + `responseMimeType=application/json`.
- STT: `WhisperTranscriber` (Groq) → OpenAI transcribe (тот же Protocol `Transcriber`).
Ответ **всегда** заново валидируется нашей Pydantic-схемой; деньги/даты нормализует код (Decimal, dateparser + правила).

**Маршруты по задачам** (`config/ai_routes.yaml`; порядок = приоритет; что включено — флаг):
| Задача | Маршрут (базовая линия #3: три платных провайдера) | Эскалация |
|---|---|---|
| ENRICH, INTENT, QUERY_PLAN, STACK_NAME, DUP_JUDGE | Claude Haiku 5.5 → gpt-6-luna → Gemini 2.5 Flash-Lite | при `confidence < 0.6` → Sonnet 5.5 / gpt-6.1-terra |
| ANSWER (стрим) | Haiku 5.5 → gpt-6-luna → Flash-Lite | сложный вопрос (> N источников, сравнение) → Sonnet 5.5 |
| KP_EXTRACT, KP_EDIT, PROFILE_EXTRACT | Sonnet 5.5 → gpt-6.1-terra | — (числа всё равно считает код) |
| VISION_OCR (фолбэк плохих фото/рукописи) | Flash-Lite → Haiku 5.5 | — |
| DRAFT | Haiku 5.5 → gpt-6-luna | — |
| IMPORT_SUMMARIZE (лениво, пакетно) | Flash-Lite → Haiku 5.5 (Batch API, где есть, −50%) | — |
| STT | Groq whisper-large-v3-turbo → OpenAI transcribe | казахский — по итогам bake-off (неделя 0) |
| Embeddings | локально bge-m3 (не через провайдеров) | — |

Переключатель `ai.providers_enabled: [anthropic, openai, gemini]` — вариант «1 основной + 1 резервный» = `[anthropic, gemini]` без изменения кода (раздел 13, И-3).

**Триггеры перехода к следующему провайдеру**:
1. HTTP 429: `retry-after < 2 с` → подождать и повторить; иначе — следующий.
2. Квота/402/`insufficient_quota` → провайдер `off` до ручного сброса + алерт.
3. Наш месячный бюджет провайдера: 80% → в конец списка, 100% → выключен до 1-го числа.
4. 5xx / таймаут (ENRICH 30 с, ANSWER первый токен 8 с, KP 60 с) → следующий.
5. Невалидный вывод → одна попытка «ремонта» (возврат ошибок валидации тому же провайдеру), затем следующий.
6. Отказ модели (refusal) → следующий, затем «не смог разобрать» пользователю.
7. **Consent filter**: провайдеры, не перечисленные в активном согласии пользователя, исключаются из маршрута ещё до вызова. Нет ни одного разрешённого → задача уходит в `deferred` / режим без ИИ.

**Circuit breaker** на пару (provider, model): 5 ошибок за 60 с → open 2 мин → half-open (1 пробный запрос) → closed. Состояние — в памяти процесса + запись перехода в `provider_usage` (outcome=circuit_open) для дашборда. Переключение при стриминге — **только до первого отданного токена**; после — ошибка + «Попробуйте ещё раз».

**Все провайдеры недоступны**: сохранение, напоминания, поиск (FTS + вектор, эмбеддинги локальные) продолжают работать; ИИ-задачи — в очередь с backoff; пользователю: «Сохранил, разберу через несколько минут».

**Golden set**: старт 150 примеров (RU 90 / KK 40 / смешанные 20): 60 обогащение (заметки, скриншоты, голос-транскрипты, документы), 30 разбор напоминаний, 20 КП (ТЗ → позиции), 25 вопросы с ожидаемыми источниками, 15 инъекций. Метрики: точность полей (даты, суммы, телефоны — exact match), F1 типа, recall источников@5, доля валидных JSON, стоимость, латентность. Прогон на всех включённых провайдерах; провайдер, не прошедший порог (например, ≥ 95% валидных JSON, ≥ 90% точности дат/сумм), автоматически не допускается к маршруту задачи.

### 5.2 Промпты и схемы (структурный вывод)

| ID | Схема | Вход | Выход |
|---|---|---|---|
| P1 enrich | `Envelope` | текст вещи (untrusted), тип, дата, язык UI | конверт обогащения (6.2) |
| P2 intent | `CommandIntent` | фраза пользователя (доверенная, но проверяемая), краткий контекст | `intent` ∈ {save, remind, ask, find, kp_create, kp_edit, draft, task_add, undo, other} + слоты |
| P3 reminder_parse | `ReminderDraft` | фраза, now, tz | текст, `when` как структура (абсолют/относительно/повтор), level; дату вычисляет код |
| P4 answer | `Answer` | вопрос + пронумерованные фрагменты (untrusted) | ответ + `citations[]` (только id из переданных) + `insufficient` |
| P5 query_plan | `QueryPlan` | вопрос | ключевые слова RU/KK, фильтры по датам/типам, перефразы для вектора |
| P6 kp_extract | `KpDraft` | ТЗ клиента (текст/таблицы, untrusted), прайс-кандидаты | позиции: название, ед., кол-во, `price_ref` или `price_missing`, `source_ref` (стр./строка) |
| P7 kp_edit | `KpPatch` | текущие данные КП (без итогов) + просьба | список операций по whitelist путей |
| P8 draft | `MessageDraft` | цель, получатель из данных пользователя, контекст | текст RU/KK, тон; получатель — только из переданных кандидатов |
| P9 stack_name | `StackName` | 10 заголовков группы | короткое имя RU/KK |
| P10 dup_judge | `DupVerdict` | две вещи | same / different / newer_version |
| P11 vision_ocr | `OcrResult` | изображение | текст + блоки + уверенность по блокам |
| P12 import_summarize | `ImportBatch` | 50 сообщений Telegram | обогащение пакетом |
| P13 profile_extract | `CompanyProfileDraft` | фото визитки/старое КП | реквизиты с отметкой «проверьте» |

Промпты хранятся в репозитории как файлы с версией (`prompts/enrich.v3.md`), версия пишется в `items.envelope_version`/`provider_usage`. Изменение промпта = PR с прогоном golden set.

### 5.3 Недоверенные данные и prompt injection

1. Весь контент пользователя из внешних источников (документы, скриншоты, пересланное, письма, Telegram, страницы по ссылкам) — внутри `<untrusted_data>`; теги внутри экранируются (`_neutralize` из текущего `pipeline/llm.py`). Системный промпт явно запрещает следовать инструкциям из данных.
2. Модель **ничего не исполняет**: она возвращает структуру; действия выполняет код по белому списку. Внешние действия (отправить, удалить навсегда, поделиться, изменить существующее напоминание) — только через `pending_actions` и явное «Да» пользователя; подтверждение = токен, выданный сервером, привязанный к `preview`.
3. Критичные детали в подтверждении (получатель, сумма, время) формирует код из структурных данных, а не текст модели.
4. Получатель письма/сообщения — только из данных пользователя (контакты из вещей, явный ввод). Номер/адрес, появившийся только в untrusted-контенте, помечается «из документа — проверьте».
5. Намерение из документа не порождает действие: P2 вызывается только на фразе самого пользователя; P1 может *предложить* напоминание (в «Предложения»), но не создать внешнее действие.
6. Никакого fetch URL по выводу модели (защита от SSRF); загрузка ссылок — только URL, присланные пользователем, через allowlist схем + запрет приватных IP.
7. КП-патчи — только по whitelist путей (`/items/*/qty`, `/items/*/unit_price`, `/terms/*`, `/text_blocks/*`…); попытка менять `company`, `bank`, `totals` отвергается.
8. Вывод модели ограничен по длине; ссылки в ответах только на `citations` из переданных id.
9. Корпус инъекций (раздел 9) — в CI.

### 5.4 Защита от перерасхода

- **На пользователя**: дневной бюджет `ai.user_daily_budget_usd` (старт $0.10) и отдельный разовый на импорт (`ai.user_import_budget_usd`, $1.00). Учёт — по `provider_usage` + `budgets`. При 80% — дешёвые маршруты (без эскалации на Sonnet), при 100% — ИИ-задачи откладываются на завтра (сохранение/напоминания/поиск работают), «вопросы» — ответ из поиска без генерации.
- **Глобально**: месячный бюджет на провайдера и общий; алерт 50/80/100%.
- **Хуки бесплатных лимитов**: `entitlements.check(user, counter)` в API (items/месяц, вопросы/день, КП/месяц, минуты голоса) — значения в конфиге, по умолчанию «без лимита» для семьи-тестеров; продукт задаёт позже (#4). Существующий `bot/limits.py` (`free_tier_allows`, `month_start_utc`) переносится в `assistant/billing/limits.py`.
- **Экономия по конструкции**: обогащение один раз при сохранении (не при каждом вопросе); парсинг PDF/DOCX/XLSX без LLM; OCR Tesseract/Vision до LLM-vision; prompt caching системных промптов (Anthropic/OpenAI); Batch API для импорта; эмбеддинги локально (0 $ за токены); КП — модель выдаёт только JSON.
- **Ориентир**: light $0.15–0.35, typical $0.5–1.3, work до $7.8/мес; дашборд «стоимость на пользователя» (раздел 8).

### 5.5 Эмбеддинги

- **Выбор**: `BAAI/bge-m3` (многоязычная, RU/KK приемлемо, 1024 dim — совпадает с текущей колонкой) на CPU в KZ через TEI (ONNX/int8). Плюсы: данные не уходят за рубеж, $0, нет зависимости от провайдера. Ориентир пропускной способности на 8 vCPU — десятки коротких чанков/с (проверить на неделе 0 замером); импорт 3 000 вещей — минуты, в фоне.
- Текущий код использует Voyage (US) — заменить на `TeiEmbedder` с тем же Protocol `Embedder`; `VoyageEmbedder` оставить как опцию за флагом.
- Запасной вариант при нехватке CPU: `multilingual-e5-small` (384 dim) — отдельный частичный индекс.
- `embedding_model` хранится на каждом чанке; смена модели = фоновый re-embed, поиск переключается после 100% покрытия.
- Опционально (после MVP): реранкер `bge-reranker-v2-m3` на CPU для топ-30.

---

## 6. Конвейеры

### 6.1 Ingest по типам

Общий поток: `POST /items` (или share → офлайн-очередь → sync) → запись `items(status=pending)` + `files(original, active)` → job `ingest:<kind>` (idempotency_key = `item:<id>:ingest:v<n>`) → нормализованный текст → job `ai:enrich` → job `embed` → job `dedup` → `status=ready` → action «Сохранил …» → `seq` → устройство получает при sync/push.
Consent gate: без активного `ai_cross_border` шаги, требующие зарубежных провайдеров (STT, LLM), не выполняются: текст и файлы сохраняются, вещь получает `status=needs_review` с пометкой «разберу после разрешения».

| Тип | Обработка | Без ИИ | Примечания |
|---|---|---|---|
| 6.1.1 Текст (набран/поделились) | нормализация пробелов/эмодзи, язык (fastText lid) | да | ссылки внутри → доп. обработка как link |
| 6.1.2 Голос | ffmpeg → 16 kHz mono → STT (Groq → OpenAI) → текст + таймкоды; при низкой уверенности (avg logprob) → `review_fields` | нет (STT) | офлайн-фолбэк Vosk small-kz/ru на сервере — только как «черновик» при недоступности STT |
| 6.1.3 Фото/скриншот | iOS: OCR на устройстве (Vision) отправляется вместе с фото; Android/нет текста: Tesseract rus+kaz+eng; уверенность < порога или рукопись → VISION_OCR (LLM); описание изображения — только если текста мало | частично | номера/телефоны/суммы из OCR → «проверьте»; EXIF-геолокацию удаляем |
| 6.1.4 PDF | pdfplumber: текст + таблицы (JSON) по страницам; если текста < 50 симв./стр. → растр 200 dpi → OCR | да (текстовый PDF) | шифрованный PDF → просим пароль/оригинал |
| 6.1.5 Excel | calamine: листы → ячейки JSON (значения, не формулы) + заголовки | да | правило размера: XLSX уже сжат — если текстовое представление не меньше, оригинал хранится (решение #8) |
| 6.1.6 Word | python-docx: заголовки, абзацы, таблицы → JSON + plain text; `.doc` → конвертация LibreOffice headless (в ingest-контейнере) | да | |
| 6.1.7 Ссылка | GET с таймаутом 10 с, лимит 5 MB, allowlist схем, запрет приватных IP; trafilatura → заголовок/текст; Instagram/TikTok — только oEmbed (без скачивания видео, как сейчас) | да | переиспользуем `links.py`, `pipeline/oembed.py` |
| 6.1.8 Письмо | MVP: «Поделиться» из Gmail/почты (текст/.eml) → парсинг заголовков, тело (text > html→text), вложения как дочерние items. После MVP: персональный адрес `u-<token>@in.<домен>` (inbound MX в KZ, проверка SPF/DKIM, только от подтверждённых адресов пользователя) | да | Gmail API — нет (решение #6) |
| 6.1.9 Telegram | 3 режима, переключаемые флагами (И-1): **(A, базовая линия #5)** вход по номеру → Telethon Takeout (`initTakeoutSession → invokeWithTakeout → finishTakeoutSession → logOut`), только «Избранное», read-only, свой api_id, честные device/app info, FLOOD_WAIT соблюдаем; сессия AES-GCM, живёт ≤ 60 мин, удаляется после импорта; телефон/код маскируются в логах; изолированный worker-import. **(B)** файл экспорта Telegram Desktop (`result.json`) → `POST /imports/telegram/file`. **(C)** пересылка сообщений в нашего бота (переиспользуем aiogram-бот как канал ввода) | да (текст) | пакетная обработка: точные дубли отсекаются до ИИ; обогащение лениво (IMPORT_SUMMARIZE пакетами по 50, Batch API), под отдельным бюджетом |

Ограничения: файл ≤ 50 MB, голос ≤ 10 мин, PDF ≤ 200 стр. (больше — первые 200 + сообщение).

### 6.2 «Конверт обогащения» (`Envelope`, P1)

```json
{
  "v": 3,
  "type": "note|task|reminder_request|shopping_list|document|receipt|contract|id_document|contact|kp_request|price_list|idea|event|other",
  "title": "…", "summary": "…", "lang": "ru|kk|mixed",
  "entities": {
    "people": [{"name": "Ерлан", "role": "клиент"}],
    "orgs": [{"name": "ТОО Арман", "bin": "…"}],
    "phones": [{"value": "+7…", "from_ocr": true}],
    "amounts": [{"value": "125000.00", "currency": "KZT", "label": "итого"}],
    "dates": [{"text": "до 15 ноября", "iso": "2026-11-15", "kind": "deadline"}],
    "places": [{"text": "аптека на Абая"}]
  },
  "proposed": {
    "reminders": [{"text": "Позвонить Ерлану", "when_text": "завтра в 10"}],
    "tasks": [{"title": "Купить лекарства маме", "list": "shopping"}],
    "kp": {"is_client_spec": true}
  },
  "topics": ["стройка", "клиент: ТОО Арман"],
  "critical_numbers": true,
  "sensitivity": ["id_number", "health"],
  "verify_fields": ["entities.phones[0]", "entities.amounts[0]"],
  "confidence": 0.82
}
```
Правила: даты — `iso` вычисляет код из `text` + now/tz (модельный `iso` только подсказка); суммы — строкой → `Decimal`; `critical_numbers` + `type ∈ {document, receipt, contract, id_document, kp_request, price_list}` → правило авто-закрепления оригинала (если включено, 7.1). Предложения (`proposed`) не исполняются автоматически: внутренние (задача в список) — по режиму автономии, напоминания — в «Предложения» с [Да]/[Не сейчас] (по умолчанию «Спрашивать всегда»).

### 6.3 Дубли

1. **Точные** (без ИИ): `content_hash` нормализованного текста (lowercase, схлопывание пробелов, без пунктуации/эмодзи) и `original_sha256` файла. Совпадение → новая вещь склеивается с каноничной (`canonical_item_id`, `hidden_reason=duplicate_merged`), action «Убрал повтор» с undo. Внутреннее действие → разрешено без «Да» (в режиме «Спрашивать всегда» — показывается в «Я сделал» с [Отменить]).
2. **Почти-дубли**: кандидаты = SimHash (расстояние ≤ 3 на 64 бит) ∪ trgm `similarity > 0.8` по title/начало текста ∪ cosine(bge-m3) ≥ 0.92 в пределах пользователя → порог по score; пограничные (0.85–0.92) → P10 `DUP_JUDGE` (дёшево, только для пар). Результат — запись `duplicates(status=suggested)`; UI «похоже на эту заметку» + стопка «Похожие». **Автослияние near-дублей — выключено** (флаг `dedup.auto_merge_near=false`), т.к. «версии» документа (КП v1/v2) похожи, но не дубли.
3. **Разовая уборка** (`POST /duplicates/cleanup`): после импорта/первой синхронизации; план «Дубли 37 → 1», точные — применяются одним action (undo одним касанием), near — списком на подтверждение.
4. Слияние никогда не удаляет физически: скрывает вещь, переносит связи (collections, reminders) на каноничную; undo восстанавливает.

### 6.4 Стопки / умные группы

- Ключи группировки из конверта: `topics`, `orgs/people` (клиент), `type` (чеки, документы, покупки) + правила (дубли, «КП Арману»).
- Ночной job `stacks:rebuild` (и инкрементально при сохранении): группа появляется при ≥ 5 вещах и если полезна (не дублирует существующую на > 80%); имя — P9 (RU/KK), закэшировано; `before_after` считает код.
- Стопка скрывается, если 30 дней не открывалась (`hidden_at`), данные не трогаются.
- Создание стопки = внутреннее action «Сложил 14 чеков в стопку “Чеки”» с undo.
- Адаптивная главная (предприниматель видит КП, мама — врача/школу) — из распределения `type/topics` пользователя, без анкеты (детали — product/design).

### 6.5 Напоминания

**Разбор фразы**: `reminder_parser` = `llm` (базовая линия, P3: модель выдаёт структуру, дату считает код) | `rules_first` (рекомендация инженерии, И-6: детерминированный парсер RU/KK «завтра в 10», «через 2 часа», «каждый понедельник», «15-го» на устройстве — мгновенно и офлайн; непонятое → P3). Перед созданием показывается «как понял»: «Завтра, 4 ноября, 10:00 — позвонить Ерлану. Будильником?».

**Где живёт расписание**: сервер — источник истины (`reminders`); устройство планирует **локально** ближайшее окно; сервер страхует push-ом.

| Платформа | Уровень «alarm» (не пропустить) | Обычные/важные | Ограничения |
|---|---|---|---|
| iOS 26+ | AlarmKit (полноэкранный будильник, звук сквозь беззвучный режим) | time-sensitive UNNotification | разрешение AlarmKit спрашиваем в контексте первого будильника |
| iOS < 26 | time-sensitive уведомление со звуком + повтор через 2 и 5 мин (доп. уведомления) | time-sensitive | лимит 64 запланированных → скользящее окно: ближайшие 48 + пополнение при открытии/фоне/silent push |
| Android 12+ | `setAlarmClock` + full-screen intent активити (если декларация одобрена), иначе heads-up на канале «Будильники» (IMPORTANCE_HIGH, звук alarm, вибрация) | `setExactAndAllowWhileIdle` (если `SCHEDULE_EXACT_ALARM`), иначе `setWindow` ±10 мин + push-страховка | перепланирование на BOOT_COMPLETED / смену времени / обновление приложения; экраны-подсказки для Xiaomi/HyperOS (автозапуск, «без ограничений»), Samsung (не усыплять) |

**Подтверждения (ack)**: устройство шлёт `scheduled_local` после постановки (с типом планировщика), `fired_local`/`shown` при срабатывании, `acked` («Готово») / `snoozed` / `dismissed`. Офлайн — события копятся в outbox.
**Server push fallback** (scheduler, каждые 30 с): если к `due_at + 3 мин` (alarm) / `+5 мин` (обычные) нет `fired_local|shown|acked` ни с одного устройства пользователя → FCM high-priority / APNs time-sensitive push; если устройство вообще не подтвердило `scheduled_local` к `due_at` → push ровно в `due_at`. Логика лизинга/ретраев — из текущего `scheduler/service.py` (claim → send вне транзакции → mark), Notifier заменяется на `PushNotifier`. Нет ack за 30 мин → `missed`, на главной «Вы пропустили…».
**Повторяющиеся** — RRULE, на устройство отдаются развёрнутые ближайшие вхождения.
**Изменение существующего** напоминания по предложению агента — через pending_action (правило CEO); прямая правка пользователем — сразу.
**Содержимое push**: при согласии `push_content` — текст напоминания; иначе «У вас напоминание» + id (текст подставляет приложение из локальной БД) — пуш идёт через Google/Apple за рубежом.

### 6.6 Движок КП

1. **Вход**: item(ы) ТЗ клиента (PDF/Excel/Word/фото) → текст + таблицы (6.1) → P6 `KP_EXTRACT` → позиции с `source_ref` и `price_ref` (поиск по прайсу: trgm/FTS по `price_list_items`, кандидаты передаются модели; модель выбирает ref, но **цену не пишет** — цену подставляет код из прайса; нет совпадения → `price_missing`, в UI «укажите цену»).
2. **Модель данных КП** (`data` в `document_versions`):
```json
{"number": "КП-2026-014", "date": "2026-11-03", "currency": "KZT",
 "seller_ref": "company_profile:1", "client": {"name": "ТОО Арман", "bin": null, "contact": "Ерлан", "phone": null},
 "vat": {"mode": "included|on_top|none"},
 "items": [{"id": "i1", "name": "Кабель ВВГнг 3х2.5", "unit": "м", "qty": "120", "unit_price": "450.00",
            "discount_pct": "0", "price_source": "price_list:7#123|manual|missing", "source_ref": "ТЗ.pdf стр.2 стр.5"}],
 "discount_total_pct": "0",
 "terms": {"payment": "100% предоплата", "delivery": "5 рабочих дней", "validity_days": 10},
 "text_blocks": {"intro": "…", "outro": "…"}}
```
3. **Расчёт — только код** (`kp/calc.py`, чистые функции): `Decimal`, `ROUND_HALF_UP` до 0.01; строка = qty × price × (1 − discount); НДС по `vat.mode` и ставке из конфига `vat.rates` с датой действия (KZ: 16% с 2026 — **проверить юристом/бухгалтером**, ставку не хардкодим), режим округления `vat.rounding = per_line|on_total` (конфиг); итоги и сумма прописью — код. `totals` пересчитываются при каждой версии; `calc_version` фиксируется.
4. **Рендер**: Jinja2 HTML-шаблон → WeasyPrint PDF (шрифты с казахскими глифами встроены); DOCX — docxtpl по запросу (`kp.formats_enabled: [pdf]` базово, `docx` — флаг); XLSX таблица позиций — openpyxl. Шаблон: системный по умолчанию + логотип/реквизиты пользователя; «шаблон компании» (загруженный старый КП) — как образец оформления/текстов, хранится всегда (опция #8). Рендер детерминирован (версия шаблона + шрифты + данные) → PDF можно не хранить и пересобрать (опция «КП только как данные»).
5. **Правки**:
   - тап по полю (кол-во, цена, срок) → JSON Patch без ИИ → новая версия;
   - фраза («скидка 5% на кабель, срок 7 дней») → P7 → JSON Patch (whitelist путей) → валидация → предпросмотр «было → стало» с пересчитанными итогами → применить (внутреннее действие, undo = revert к версии).
   - Конкурентность: `base_version`; конфликт → 409 с актуальной версией.
6. **Версии**: каждая правка = новая `document_versions` с patch от предыдущей; «Вернуть версию 3».
7. **Отправка**: `POST /documents/{id}/send` → pending_action с preview (клиент, итог с НДС, файл) → «Да» → устройство рендер-файл (скачан) → `expo-sharing` (WhatsApp и др.) или `expo-mail-composer` с вложением; `whatsapp://send?phone=` — только для текста сопроводительного сообщения. Факт отправки мы не видим → после возврата из share sheet спрашиваем «Отправили?» (или помечаем `sent` при `completed` на iOS activity result). Документ → `status=sent`, рендер этой версии сохраняется только если `kp.keep_sent_render=true`.

### 6.7 Черновики и отправка

- P8 формирует текст; получатель — из данных пользователя; канал — WhatsApp (текст через `whatsapp://send`, файл через share), почта (`expo-mail-composer`/`mailto:`), любой мессенджер (share sheet).
- Всё — через pending_actions: «Отправить Арману в WhatsApp: “Добрый день…” + КП-2026-014.pdf?» [Да] [Изменить] [Не сейчас]. Сами мы ничего не отправляем с сервера (нет Gmail send — решение #6).
- Лог: action `send_external` (scope=external, undo невозможен — UI честно не показывает «Отменить»).

### 6.8 Вопросы и ответы с источниками

1. Устройство: мгновенный локальный поиск SQLite FTS5 по кэшу → показ «Нашёл у себя» (офлайн тоже).
2. Сервер `POST /ask`: P5 `QUERY_PLAN` (или детерминированно для простых запросов: даты «на прошлой неделе», типы «чеки», «КП») → фильтры SQL (пользователь, статус, даты, тип, стопка) → арм-ы: FTS `tsv_simple` + `tsv_ru`, trgm по title, вектор по chunks (bge-m3, query-эмбеддинг локально), recent → **RRF** (переиспользуем `qa/retrieval.rrf`, k=60) → топ-15 чанков → дедуп по item → до 8 фрагментов в `<untrusted_data>` с номерами.
3. SSE: сначала `sources` (карточки с «из голосового, 3 ноя, 0:42»), затем `token`-ы ответа (P4), в конце `citations` (валидация: только переданные id; ответ без цитат при `insufficient=true` → «Не нашёл точно, вот похожее»).
4. Агрегаты («сколько я потратил на лекарства в октябре») — суммы считает код по `entities.amounts` найденных вещей; модель только формулирует.
5. Ответ можно «сохранить как заметку» или превратить в дело/напоминание (через P2).

---

## 7. Хранение и приватность

### 7.1 Политика хранения оригиналов (решение #8 + переключаемые опции)

Базовая линия = решение основателя: оригинал не храним, если извлечённый текст меньше; оригинал проходит через корзину; опции основателя (#8) включаются флагами.

| Тип | Что храним всегда | Оригинал по умолчанию (#8) | Примечание |
|---|---|---|---|
| Голос | транскрипт + таймкоды + длительность | в корзину → удаление через `trash_days` | −99% объёма |
| Скриншот/фото | OCR-текст + описание + `original_sha256` | в корзину → удаление | превью — нет (`thumbnails.enabled=false`) |
| PDF | текст по страницам + таблицы JSON | в корзину → удаление | |
| Word | текст + заголовки + таблицы JSON | в корзину → удаление | |
| Excel | ячейки JSON | **по правилу размера**: если JSON ≥ размера XLSX — оригинал остаётся (`keep_reason=size_rule`) | |
| Ссылка/письмо/Telegram | текст | оригинала нет | |
| Логотип, шаблон компании | файл | **всегда хранится** (`company_template`) | опция основателя «КП-шаблон/логотип» |
| Сгенерированное КП | данные + версии | PDF не хранится, пересобирается (`kp.store_generated=data_only`) | опция основателя |

Флаги (`storage.*`):
- `trash_days`: 7 (базовая линия, опция основателя) — рекомендация инженерии 30 (И-2).
- `pin_enabled`: true — кнопка «Сохранить оригинал» (в корзине и в карточке).
- `auto_pin_docs_with_numbers`: false (базово) — вариант Б дизайнера: `envelope.critical_numbers` + документный тип → авто-закрепление (`pinned_by=auto_rule`), рекомендуем true.
- `keep_while_unsure`: true — если извлечение не удалось или уверенность ниже порога (OCR/STT confidence < 0.7, пустой текст), текст *не заменяет* оригинал → оригинал не уходит в корзину, пока пользователь не подтвердил текст. Это следование правилу основателя («храним текст, если он заменяет оригинал»), а не исключение из него.
- `keep_client_specs_while_deal_active`: false (базово), рекомендуем true — ТЗ, на которое ссылается КП с `deal_active`, не удаляется.
- `mode`: `drop_after_trash` (база) | `keep_documents` (Б) | `keep_all` (В).
- `thumbnails.enabled`: false; `thumbnails.max_kb`: 25.

Механика: файл с `state=trash, trash_until` → ежедневный job `storage:purge` удаляет объект S3 (`purged_at`), сохраняя `original_sha256` (для точных дублей) и текст. UI 7 дней показывает «Оригинал ещё доступен — [Сохранить]» (design). Запрет на удаление, если ingest не завершён.
Объём: активный пользователь ~1–2 ГБ/год оригиналов → ~40–80 МБ текстом.

### 7.2 Данные в KZ
- Все персональные данные (БД, S3, логи, бэкапы, мониторинг, трекер ошибок) — в KZ. За рубеж уходит только то, что нужно для конкретного вызова ИИ/STT/push, и **только после согласия** (94-V ст. 16; App Store 5.1.2(i) — провайдеры названы поимённо).
- Провайдеры: платные тарифы без обучения на данных; запросить zero-data-retention у OpenAI/Anthropic; DPA с каждым (задача основателя).
- Минимизация: в LLM уходит только нужный фрагмент (не весь архив); номера документов, ИИН и т.п. в задачах, где они не нужны (stack_name, dup_judge), маскируются кодом.

### 7.3 Шифрование
- В пути: TLS 1.2+ везде, HSTS; certificate pinning — нет (риск поломок), вместо этого App Attest/Play Integrity для чувствительных эндпоинтов.
- В покое: шифрование диска managed-БД и SSE для S3 (ключи KMS облака в KZ). Прикладное шифрование (AES-256-GCM, envelope с ключом из KMS) для: телефонов (`auth_identities.subject_enc`), Telegram-сессий, закреплённых оригиналов с `sensitivity: id_document`.
- На устройстве: SQLCipher, ключ в Keychain/Keystore через secure-store; файлы в sandbox приложения; опция блокировки биометрией.

### 7.4 Consent gate
- Проверка в одном месте — router + ingest (не в UI): нет активного согласия на провайдера → вызов невозможен (`ConsentRequired`), тест на это обязателен.
- Онбординг: согласие запрашивается **до первого голосового/фото**, требующего сервера (см. И-7); текст и список провайдеров берутся с сервера (`/consents/text`), версия фиксируется. Добавление нового провайдера → новая версия → повторный запрос согласия; до него провайдер исключён из маршрутов этого пользователя.
- Отзыв: ИИ-функции выключаются, данные остаются в KZ; удаление — отдельно.

### 7.5 Логи и редакция
- Расширить `assistant/logs.py` (`redact`): + телефоны (+7/8 …), e-mail, ИИН/БИН (12 цифр), номера карт (13–19 цифр с Luhn), IBAN KZ, JWT, OTP-коды в путях auth, Telegram session strings, presigned URL-подписи (`X-Amz-Signature`).
- Правило: содержимое пользователя (тексты, транскрипты, промпты, ответы) **не логируется**; в логах — id, длины, типы, коды исходов. Для отладки — отдельный флаг на конкретного пользователя-тестера с его согласия, TTL 24 ч.
- Трекер ошибок: `before_send` скраббер; хранение 30 дней. Логи — 30 дней, audit_log — 1 год.

### 7.6 Экспорт
`POST /export` → job: ZIP `{items.jsonl, items/*.md (текст + источник + дата), reminders.json, tasks.json, documents/*.json + *.pdf (рендер), originals/* (что ещё хранится), README.txt}` → `prod-exports/`, ссылка 24 ч, объект удаляется через 72 ч. Одно касание в настройках.

### 7.7 Удаление аккаунта
`DELETE /me` (подтверждение повторным кодом/фразой) → `status=deleting`, сессии отозваны, push-токены удалены → job `account:purge` в течение 24 ч: строки в БД (каскад), объекты S3 по префиксу пользователя, chunks/векторы, provider_usage обезличивается (user_id → null) для финучёта; бэкапы истекают по ротации (≤ 30 дней — указать в политике). У провайдеров ИИ при ZDR данных нет; иначе — их срок хранения указывается в политике. Веб-страница удаления для Google Play. Импорт-сессии Telegram уничтожаются немедленно.

---

## 8. Надёжность и наблюдаемость

- **Идемпотентность**: `client_id` для всех создаваемых с устройства сущностей; `Idempotency-Key` на мутациях; `jobs.idempotency_key`; повторный ingest/обогащение того же `item+version` не тратит деньги повторно (проверка `provider_usage` по `request_id`/результату в items). Webhook-и (inbound email, Telegram-бот) — дедуп по id сообщения.
- **Ретраи**: очередь — существующий backoff 15 с → 1 ч, `max_attempts=5`; `PermanentError` (как в `pipeline/errors.py`) — без ретраев; `stale_after` по типу задачи (STT длинного голоса 15 мин, КП 5 мин, импорт 60 мин).
- **Транзакции**: ни одной открытой транзакции во время сетевого вызова; результат → commit → уведомление (правило из текущего кода).
- **Офлайн-режим** (устройство): сохранение (текст, голос, фото, файлы) в SQLite + файловую систему, outbox; локальный поиск FTS5; напоминания из локальной БД (разбор `rules_first` работает офлайн, иначе «Напомню, когда появится связь — или задайте время вручную»); баннер «Сохранение, напоминания и поиск работают без интернета». Sync: при появлении сети, push-«пинок», фоновой задаче. Конфликты: last-writer-wins по полю для заметок с сохранением обеих версий текста при конфликте правок текста; для reminders/documents — оптимистическая версия (`version`/`base_version`).
- **Деградация**: нет ИИ → сохранение/поиск/напоминания; нет эмбеддингов → FTS+trgm; нет STT → голос хранится, транскрипт позже; нет push → локальные напоминания всё равно сработают.
- **Мониторинг** (Prometheus/Grafana в KZ):
  - API: RPS, p50/p95 латентность, 5xx, SSE time-to-first-token.
  - Очередь: глубина по `queue`, возраст старейшей задачи, failed за час.
  - Ingest: время от сохранения до `ready` p95 (цель ≤ 30 с текст/голос до 1 мин, ≤ 2 мин PDF).
  - **Напоминания**: доля `fired_local|shown` в пределах 1 мин от `due_at` (цель ≥ 99%), доля push-фолбэков, `missed`, по платформе/производителю/версии ОС.
  - ИИ: по провайдеру/модели/задаче — ошибки, отказы, невалидный JSON, circuit open, латентность, $/час.
  - Бизнес-технические: стоимость на пользователя/день (p50/p95/max), топ-10 дорогих пользователей, undo-rate действий агента (< 5%).
- **Лог стоимости и ошибок на пользователя**: `provider_usage` + `jobs.last_error` → внутренний админ-экран/CLI `assistant admin user <id>` (без содержимого вещей): что сохранял (типы), ошибки, $ за день/месяц, срабатывания напоминаний.
- **Алерты** (в Telegram-канал основателя/разработчика, без персональных данных): 5xx > 2% 5 мин; очередь старше 10 мин; доставляемость напоминаний < 97% за час или любой `missed` у тестовой семьи; провайдер circuit open > 10 мин; бюджет провайдера 80/100%; пользователь > $0.50/день; ошибки миграций; бэкап не выполнен; диск > 80%; SMS-OTP всплеск (pumping).
- **SLO MVP**: API 99.5%, push-фолбэк отправлен ≤ 5 мин после due в 99.9% случаев.

---

## 9. Тестирование

- **Unit (backend)**: чистые функции — разбор дат/напоминаний RU/KK, `rrf`, нормализация хэшей дублей, политика хранения (таблица решений на все флаги), лимиты/бюджеты, router (фейковые адаптеры: 429/5xx/timeout/invalid/refusal/quota → правильный следующий провайдер, consent filter, circuit breaker по времени с fake clock), redaction (корпус секретов и ПДн).
- **Integration на реальном Postgres в CI** (`pytest -m db`, обязателен для merge): миграции up/down, триггеры `seq`/`tsv`, очередь (конкурентный `claim` двумя сессиями, stale-подхват), поиск (FTS ru/simple + trgm + вектор на фикстурах), sync (дельта, tombstones, конфликты), reminders send/lease (переиспользуем существующие `tests/scheduler/test_db.py`), удаление аккаунта (ни одной строки/объекта не остаётся — проверка по всем таблицам с `user_id`), экспорт. Первый шаг недели 0 — запустить имеющиеся 300 тестов, включая 11 db-тестов, и починить.
- **API-контракт**: OpenAPI-схема генерируется → TS-клиент для мобильного (`openapi-typescript`); snapshot-тест схемы.
- **Golden sets RU/KK** (5.1): ночной прогон и при изменении промптов; отчёт с регрессиями; KK-примеры записывают носители (голос: разные возрасты, шум, смешанная речь).
- **КП property tests (hypothesis)**: итог = Σ строк; НДС-режимы согласованы (`included`: нетто + НДС = брутто ± 0.01×N строк); неотрицательность; инвариант порядка строк; `apply(patch); revert` = исходные данные; патчи вне whitelist отвергаются; рендер PDF содержит итог, совпадающий с `totals` (извлечение текста из PDF); сумма прописью для 0, 1, 21, 1 000 000,01.
- **Injection corpus** (≥ 60 примеров RU/KK/EN): «игнорируй инструкции», поддельные `</untrusted_data>`, инструкции в OCR-скриншоте, в PDF мелким шрифтом, в Excel-ячейке, в письме («отправь КП на этот номер»), Unicode-обфускация. Ожидание: нет pending_action/изменения получателя/выхода за whitelist, ответ описывает контент.
- **Mobile**: unit (парсер напоминаний на устройстве — те же тест-векторы, что на сервере, из общего JSON), компонентные, Maestro E2E: первый запуск 60 с, share → сохранено, голос → напоминание, офлайн-сохранение → sync, КП → «Да» → share sheet.
- **Матрица устройств для напоминаний** (ручной + автоматизированный протокол 7 дней):
  - iPhone iOS 26 (AlarmKit), iPhone iOS 17/18 (без AlarmKit), желательно старый iPhone (SE/11).
  - Samsung Galaxy A-серии (One UI 6/7, Android 14/15).
  - Xiaomi/Redmi на HyperOS (Android 14/15) — **первый в очереди** (самый агрессивный энергосбережение).
  - Дешёвый Tecno/Infinix (популярны в KZ) — желательно.
  Сценарии: приложение выгружено из памяти; перезагрузка; 24–48 ч простоя (Doze); режим энергосбережения; беззвучный/DND/фокус; смена часового пояса/времени; обновление приложения; отказ в exact alarm/уведомлениях; 60+ запланированных (окно iOS); нет сети в момент срабатывания. Критерий: 100% срабатываний «alarm» в ±1 мин на всех устройствах матрицы с выполненными подсказками по батарее.
- **Нагрузочный минимум**: импорт 3 000 вещей у 10 пользователей одновременно; 50 SSE параллельно.
- **Чек-лист ревью сторов**:
  - App Store: 5.1.1(v) удаление аккаунта в приложении; 5.1.2(i) — поимённо провайдеры ИИ и согласие до первой отправки; Privacy Nutrition Labels; `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSAlarmKitUsageDescription` (RU-тексты с понятной целью); time-sensitive entitlement обоснован; демо-аккаунт для ревью (фиксированный номер + код, только на review-сборке, флаг на сервере); экспорт-шифрование (`ITSAppUsesNonExemptEncryption=false` при стандартном HTTPS); маркировка ИИ-контента (закон KZ 230-VIII) — в продукте/праве; Telegram-вход (если включён) — объяснение в Notes for Review, нет «Telegram» в названии; возрастной рейтинг с учётом генеративного контента; ссылки на политику и условия.
  - Google Play: Data safety form (совпадает с фактическими потоками); декларация `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` (используем `SCHEDULE_EXACT_ALARM`; `USE_EXACT_ALARM` — только если категория «будильник/календарь» подтверждена); декларация `USE_FULL_SCREEN_INTENT`; `POST_NOTIFICATIONS`; foreground service type (если используем для импорта/записи); веб-ссылка удаления аккаунта; закрытое тестирование 12+ тестеров 14 дней для нового личного аккаунта разработчика (для организации — не требуется; учесть в плане).

---

## 10. Повторное использование текущего кода

| Модуль | Решение | Что именно |
|---|---|---|
| `config.py` | **Изменить** | Оставить pydantic-settings; убрать Telegram-/places-специфику в отдельные группы; добавить `ai.*`, `storage.*`, `reminders.*`, `kp.*`, `vat.*`, `telegram_import.*`, `limits.*`, `sms.*`, `push.*`; маршруты ИИ — YAML |
| `db/models.py` | **Переписать** | Новая схема (раздел 3); legacy-модели → `db/legacy.py` |
| `db/session.py` | Оставить | |
| `db/queue.py` | **Оставить + доработать** | `enqueue/claim/complete/fail/backoff` — основа; добавить `queue`, `priority`, `idempotency_key` (`ON CONFLICT DO NOTHING`), per-job `stale_after`, `user_id`, `claim(queues=…)` с сортировкой `priority, run_after` |
| `migrations/0001` | Оставить (заморожена) | + 0002…0006 (раздел 3.7) |
| `logs.py` | **Оставить + расширить** | `redact` + ПДн-паттерны (7.5); `configure_logging` — во всех новых entry points |
| `notify.py` | **Изменить** | Protocol `Notifier` оставить; `OutMessage` → нейтральное `PushMessage` (user_id, title, body, data, priority); `TelegramNotifier` → только для бота-канала; новый `PushNotifier` (FCM/APNs) |
| `embeddings.py` | **Изменить** | Protocol `Embedder` и `NullEmbedder` оставить; добавить `TeiEmbedder` (bge-m3) по умолчанию; `VoyageEmbedder` — за флагом |
| `links.py` | Оставить | Нормализация URL/хэш — для точных дублей ссылок; добавить SSRF-защиту, если её нет |
| `timezones.py`, `qa/_tz.py`, `scheduler/tz.py` | **Объединить** | Один модуль `assistant/timeutil.py` |
| `pipeline/llm.py` | **Изменить** | `_neutralize`, `<untrusted_data>`-обёртка, обработка `refusal/max_tokens`, `Extractor` Protocol → основа `ai/adapters/anthropic.py`; SYSTEM_PROMPT травел → новые промпты P1…P13; добавить адаптеры OpenAI/Gemini и router |
| `pipeline/schema.py` | Переписать | `Envelope` и др. схемы |
| `pipeline/stt.py` | **Оставить** | `Transcriber` Protocol, `WhisperTranscriber` (OpenAI-совместимый — подходит и для OpenAI transcribe), `NullTranscriber`; + выбор провайдера router-ом, оценка уверенности |
| `pipeline/media.py` | Оставить частично | ffmpeg-аудио; кадры видео — не в MVP |
| `pipeline/core.py`, `logic.py`, `service.py`, `inputs.py` | **Изменить** | Паттерн «чистое ядро без БД → Outcome → DB-слой применяет» сохранить; логику trip/place/booking удалить; добавить парсеры типов (6.1) |
| `pipeline/errors.py` | Оставить | `PermanentError`, `NeedsInputError` |
| `pipeline/geo.py`, `places.py`, `oembed.py` | geo/places — **в архив**; oembed — оставить для ссылок IG/TikTok |
| `pipeline/telegram_files.py` | Оставить для бота-канала (вариант C импорта) | |
| `worker.py` | **Изменить** | Цикл worker → маршрутизация по `queue`/kind, конкурентность из конфига, graceful shutdown |
| `qa/retrieval.py` | **Оставить ядро** | `rrf`, `websearch_text`, `fts_stmt`, `vector_stmt`, `recent_stmt`, `items_by_ids_stmt`, `_escape_like`, `_day_start_utc` — оставить; `near_stmt/nearby_stmt/geo_point`, `COUNTRY_CODES`, trip/city/category фильтры — удалить; добавить арм `tsv_ru`, trgm, чанки вместо `items.embedding` |
| `qa/compose.py`, `qa/llm.py`, `qa/service.py`, `qa/filters.py` | **Изменить** | Компоновка данных для модели и цитаты — основа P4; тексты «Пересылай мне рилсы…» → новые; Telegram-лимит 4000 → SSE |
| `scheduler/service.py` | **Оставить механику** | claim (SKIP LOCKED) → отправка вне транзакции → mark, лизинг, учёт попыток, `is_stale` — для push-фолбэка; trip/booking-специфику (`schedule_for_trip`, `render_text`, `compose_trip_*`) — удалить; добавить выбор «нет ack → push» |
| `scheduler/rules.py` | **Изменить** | `apply_claim/apply_send_*`, `cancel_scheduled` — оставить; trip/booking specs — удалить; добавить RRULE-развёртку и правила ack |
| `scheduler/texts.py` | Удалить (травел) | |
| `bot/*` | **Сократить** | REST API заменяет бот. Оставить тонкий бот только как канал импорта (вариант C) за флагом: `outbox.py` (паттерн post-commit), `middleware.py`, `limits.py` → перенести в `billing/limits.py`; `handlers/texts/callbacks` про поездки — удалить |
| `tests/*` | **Оставить и запустить на БД** | Тесты очереди, scheduler send/lease, rrf, redaction, транзакций/секретов — сохраняем; травел-тесты удаляем вместе с кодом |
| `docker-compose.yml`, `Dockerfile`, `docker/db.Dockerfile` | Изменить | Образ БД без PostGIS (pgvector), сервисы api/workers/scheduler/tei |

Новые пакеты: `assistant/api/` (FastAPI routers), `assistant/auth/`, `assistant/ai/` (router, adapters, prompts, golden), `assistant/ingest/` (parsers), `assistant/memory/` (items, chunks, dedup, stacks), `assistant/reminders/`, `assistant/kp/` (calc, patch, render), `assistant/actions/` (actions, pending, undo), `assistant/storage/` (S3, policy, purge), `assistant/sync/`, `assistant/imports/`, `assistant/billing/` (limits, budgets), `assistant/push/`.
Правило «никогда не говорить ИИ/AI в текстах» — сохранить (UI-тексты RU/KK, design).

---

## 11. План работ

Исходные: один разработчик с ИИ-агентами для кода; основатель — продуктовые решения, аккаунты, юрист, тестеры. Оценки — недели календарного времени. Порядок пользователей: основатель → жена → отец (следующий — только если предыдущий пользовался неделю).

### 11.0 Неделя 0 (до старта; разработчик + основатель)
Разработчик:
1. CI с реальным Postgres+pgvector: `alembic upgrade head`, все 300 тестов + 11 db-тестов → зелёные (или список падений и починка).
2. Тестовое мини-приложение (Expo dev build): один локальный «будильник» (`setAlarmClock` Android / AlarmKit + уведомление iOS) + отчёт о срабатывании на сервер; поставить на телефоны семьи (Xiaomi, Samsung, iPhone) → журнал 7 дней.
3. Bake-off STT: 30 реальных голосовых (RU, KK, смешанные, 45+/65+) через Groq Whisper, OpenAI transcribe, (опц.) ISSAI/казахстанские модели, Vosk → WER/понятность, $.
4. Bake-off OCR: 30 скриншотов/фото документов RU/KK: Tesseract rus+kaz, Apple Vision, LLM-vision.
5. Замер TEI bge-m3 на целевой VM (чанков/с), проверка pgvector/pg_trgm у кандидатов хостинга.
6. Заморозка ТЗ v1, бэклог, golden set v0 (50 примеров).
Основатель:
- Apple Developer (организация: D-U-N-S для ИП/ТОО — до 2–3 недель, начать **сейчас**), Google Play Console (организация, чтобы не попасть на обязательное 14-дневное закрытое тестирование личного аккаунта).
- Договор хостинга в KZ (по чек-листу 1.3), SMS-шлюз KZ, домен.
- Платные аккаунты Anthropic/OpenAI/Google (Gemini API), Groq; запросы ZDR/DPA.
- Юрист: политика конфиденциальности, тексты согласий (94-V, список провайдеров), маркировка ИИ (230-VIII), условия использования.
- Купить/одолжить тестовые телефоны: Xiaomi/Redmi HyperOS, Samsung A, (Tecno).
- Материалы: 10 реальных ТЗ клиентов отца + прайс + реквизиты/логотип + 2–3 старых КП; снять, как отец делает КП (молча наблюдать); 30 голосовых от родных (с согласием); 20 «хаотичных» заметок с дублями из своего телефона.
- Решения по разделу 13 (минимум И-1, И-2, И-3, И-5, И-7, И-8).

### 11.1 Вариант 1 — Core MVP, 10–12 недель
Состав: захват (share/голос/фото/файлы PDF/Word/Excel/текст/ссылка, письмо через «Поделиться»), память текстом + поиск (локальный + серверный), вопросы с источниками, напоминания-будильники с ack и push-фолбэком, точные дубли + «похоже на» + разовая уборка, стопки v1, простое КП (PDF, правки тапом и фразой, отправка через share/WhatsApp/почту), черновики сообщений с «Да», «Что я сделал» + undo, RU + KK интерфейс, экспорт, удаление аккаунта, 2 провайдера (третий — флагом), бюджеты.
Не входит: вход в Telegram (только импорт из файла экспорта — флаг), адрес пересылки почты, DOCX КП, автослияние near-дублей, семейный доступ, оплаты.

| Нед. | Backend | Mobile | Готово, когда |
|---|---|---|---|
| 1 | Миграции 0002–0003, auth (anon + OTP), devices, consents, uploads, очередь v2 | Expo-каркас, навигация, токены дизайна, SQLite+outbox | Анонимный вход, загрузка файла в S3 KZ |
| 2 | items API, sync, ingest текст/фото(OCR)/голос(STT), router v1 (2 провайдера), provider_usage | Share intent iOS/Android, запись голоса, офлайн-сохранение | Скрин из любой программы → текст в карточке |
| 3 | Конверт обогащения P1, consent gate, бюджеты, PDF/DOCX/XLSX/ссылки | Карточка с источником, «проверьте», согласие в онбординге | 20 типов вещей с golden ≥ порога |
| 4 | chunks + TEI bge-m3, поиск (RRF), политика хранения + корзина + pin | Вкладка «Найти» (локально + сервер) | Поиск по 1 000 вещей < 1 с |
| 5 | `/ask` SSE с цитатами, `/commands` (P2 intent) | Большая кнопка микрофона, экран ответа, «как понял» | Вопрос голосом → ответ с источниками |
| 6 | Напоминания: модель, парсер, ack, push-фолбэк (scheduler) | native-модуль alarms (Android + iOS), подсказки по батарее | Будильник срабатывает на Xiaomi/Samsung/iPhone в приложении |
| 7 | actions + undo, pending_actions, `/home` | Главная: Сегодня / Я сделал / Предложения; «Дела» | Отмена любого внутреннего действия |
| 8 | Точные/near дубли, cleanup, стопки v1 | Стопки на главной, анимация «Дубли 37 → 1» | Уборка заметок основателя |
| 9 | КП: профиль компании, прайс, P6, calc, PDF-рендер | Мастер КП, тап-правки, предпросмотр PDF | Отец делает КП из своего ТЗ |
| 10 | КП правки фразой (P7 + patch + версии), черновики P8, экспорт, удаление аккаунта | Отправка через share/почту с «Да», настройки | Отправлено реальное КП клиенту |
| 11 | Golden RU/KK 150, корпус инъекций, алерты/дашборды, нагрузочный минимум | Онбординг 60 с, KK-локализация, доступность (шрифт 200%) | Матрица устройств 7 дней пройдена |
| 12 | Hardening, баг-фиксы, review-флаг демо-аккаунта | Скриншоты/тексты стора, сабмит Android (+iOS TestFlight) | Сборка в закрытом тестировании сторов |

Ожидаемая уверенность: ~70% уложиться в 12 недель; буфер — за счёт стопок/КП-правок фразой.

### 11.2 Вариант 2 — Full MVP, 16–22 недели
Недели 1–12 как выше, затем:
| Нед. | Что |
|---|---|
| 13–14 | Telegram: импорт из файла (B) + пересылка в бота (C); вход Takeout (A, решение #5) за флагом — изолированный worker, тест на банах тестового аккаунта |
| 15 | Третий провайдер в маршрутах, golden на всех, авто-допуск по порогам; Batch API для импорта |
| 16 | DOCX КП (docxtpl), XLSX таблица позиций, шаблон компании из старого КП |
| 17 | Персональный адрес пересылки почты (inbound MX в KZ, SPF/DKIM) |
| 18 | Казахский голос: улучшение STT по результатам тестов (выбор модели, подсказки словаря), review-UX для голоса |
| 19–20 | Публичный релиз iOS (AlarmKit, второе ревью Apple), доработки по ревью обоих сторов |
| 21–22 | Буфер: бета с 5–10 незнакомыми людьми (ИП + 50+), исправления, метрики удержания |
Уверенность ~65% (оценка прошлого раунда) — основной риск: ревью сторов, напоминания на OEM, качество казахской речи.

### 11.3 Что основатель делает лично (сквозное)
- Еженедельно 30 мин: демо + решения по открытым вопросам (не более 3 за раз).
- Сам пользуется с недели 3 и ведёт список «не понял/ошибся» (кнопка «Неправильно понял»).
- Организует тест у жены (неделя 7+) и отца (неделя 10+), 5 незнакомых (неделя 12+).
- Подписывает договоры, оплачивает аккаунты, общается с юристом, ведёт карточки сторов (тексты RU/KK — с продуктом/дизайном).
- Проверяет ставку НДС и обязательные реквизиты КП с бухгалтером.

---

## 12. Риски и меры

| Риск | Вероятн./влияние | Мера |
|---|---|---|
| Напоминания не срабатывают на Xiaomi/Samsung (убийцы фона) | Высокая / критич. | Неделя 0 — мини-приложение на телефонах семьи; `setAlarmClock`; подсказки по батарее; push-фолбэк без ack; метрика доставляемости по OEM; матрица устройств |
| Отказ в ревью (exact alarm, full-screen intent, 5.1.2(i), Telegram-вход) | Средняя / высокое | Чек-лист 9; Android-first; Telegram-вход за флагом и выключен в первой сборке; ранний TestFlight; Notes for Review |
| Слабое качество казахской/смешанной речи и OCR | Высокая / высокое | Bake-off неделя 0; «как понял» до действия; `keep_while_unsure` для оригиналов; поля «проверьте»; выбор провайдера по golden KK |
| Необратимая потеря оригинала при ошибке OCR/STT (#8) | Средняя / высокое (доверие) | Корзина; pin; авто-pin документов с цифрами (флаг); не удалять при низкой уверенности; экспорт |
| Перерасход на ИИ (тяжёлые пользователи, импорт) | Средняя / среднее | Бюджеты пользователя/провайдера, отдельный бюджет импорта, дешёвые маршруты, кэш промптов, Batch API, лимиты-хуки |
| Prompt injection → неверное внешнее действие | Средняя / высокое | Модель не исполняет; «Да» с превью от кода; whitelist патчей; получатели только из данных пользователя; корпус в CI |
| Нарушение 94-V / 230-VIII (данные за рубежом без согласия, маркировка) | Низкая при мерах / критич. | Consent gate в коде с тестами; всё хранение в KZ, включая логи/мониторинг; локальные эмбеддинги; юрист на неделе 0 |
| Риски хостинга (собственность провайдера, санкции, нет pgvector) | Средняя / высокое | Чек-лист выбора; только стандартный Postgres+S3 (переносимость); бэкапы в другой KZ-хостинг; И-8 |
| Ограничения Expo для share extension / AlarmKit | Средняя / среднее | Dev build + свои Expo-модули; прототип модулей в неделю 0–2 |
| Бан Telegram-аккаунта/«похоже на мошенничество» | Средняя / высокое (для пользователя) | Варианты B/C по умолчанию; A за флагом, read-only, Takeout, честные метаданные |
| Конфликты офлайн-синхронизации | Средняя / среднее | client_id, seq-курсоры, версии, сохранение обеих версий текста |
| CPU-эмбеддинги не успевают на импорте | Низкая / среднее | Очередь с приоритетом (новое > импорт), замер на неделе 0, e5-small запасной |
| SMS-pumping/фрод OTP | Средняя / среднее (деньги) | App Attest/Play Integrity, лимиты на номер/устройство/IP, алерт |
| Один разработчик (bus factor) | Высокая / высокое | ТЗ + ADR в репо, CI обязателен, инфраструктура как код, доступы у основателя |
| 300 тестов не гонялись на БД — скрытые баги в переиспользуемом коде | Высокая / среднее | Неделя 0 п.1, db-тесты обязательны для merge |
| Ошибка в расчёте/НДС КП → репутация отца | Низкая при мерах / высокое | Расчёт только кодом, property-тесты, ставка в конфиге с датой, «проверьте цены» при `price_missing` |

---

## 13. Открытые решения (инженерия)

Формат: суть → варианты → рекомендация. Базовая линия (решение основателя) уже заложена; переключение — флагом.

**И-1. Telegram «Избранное» через вход по номеру (решение #5).**
Проблема: ввод кода из Telegram в стороннее приложение выглядит как мошенничество для 45+; риск вопросов на ревью; риск ограничений аккаунта; код — то, что учат никому не сообщать.
Варианты: A) вход + Takeout (база, `telegram_import.login_enabled=true`); B) файл экспорта Telegram Desktop; C) пересылка в нашего бота; D) вход только для основателя/бета-тестеров, без хранения сессии.
Рекомендация: в MVP включить B + C для всех, A — только D (флаг на конкретных пользователей), полноценный A — после проверки ревью и реакции 5 незнакомых людей.

**И-2. Оригиналы (решение #8).**
Варианты: А) корзина `trash_days` + «Сохранить оригинал» (база, 7 дней); Б) + авто-закрепление документов с цифрами (ТЗ, договоры, чеки, удостоверения); В) хранить всё.
Рекомендация: Б + `trash_days=30` + `keep_while_unsure=true` + `keep_client_specs_while_deal_active=true` + логотип/шаблон всегда. Удалять по умолчанию только голос и скриншоты после корзины. Стоимость хранения для Б мала (~$0.04/ГБ/мес).

**И-3. Количество провайдеров (решение #3).**
Варианты: три (база) | один основной + один резервный, третий выключен.
Рекомендация: старт 1+1 (Claude Haiku/Sonnet основной, Gemini или OpenAI резерв — по golden KK), третий включить флагом после прохождения golden. **В согласии сразу перечислить всех трёх**, чтобы включение не требовало повторного согласия.

**И-4. Сроки.**
Варианты: Full MVP одним релизом 16–22 нед. | Core MVP 10–12 нед. → релиз → добавки по 2 недели.
Рекомендация: Core MVP, затем Full по 11.2 — раньше реальные пользователи и данные о напоминаниях.

**И-5. Порядок платформ (решение #2 — обе).**
Варианты: одновременный релиз | Android публично + iOS в TestFlight, публичный iOS позже (AlarmKit).
Рекомендация: один код Expo, публичный Android первым (семья на Android, ревью Play быстрее), iOS — TestFlight с недели 10, публично на неделях 13–20.

**И-6. «Сначала код, ИИ как подстраховка» (отложено основателем).**
Касается: разбор напоминаний (`reminder_parser`), простые поиски/фильтры, точные дубли, расчёт КП (уже код по #7).
Рекомендация: включить `rules_first` для напоминаний (мгновенно, офлайн, дешевле, надёжнее для времени), остальное уже так спроектировано; пользователь разницы не видит.

**И-7. Согласие до первой фразы в онбординге.**
Проблема: в сценарии «первые 60 с» голос уходит на зарубежный STT — по 94-V/5.1.2(i) согласие нужно до этого.
Варианты: а) короткая карточка согласия на шаге 25 с («Чтобы понимать голос, запись обрабатывают сервисы OpenAI/Groq… [Согласен]»); б) первая фраза распознаётся на устройстве (iOS on-device; Android — нет надёжного KK) без сервера; в) первая фраза — текстом.
Рекомендация: а), текст согласия — с юристом и дизайнером (одна понятная карточка, полный текст по ссылке).

**И-8. Хостинг в KZ.**
Варианты: Yandex Cloud (регион KZ) | PS Cloud | QazCloud/Казахтелеком | VPS + свой Postgres.
Критерии: managed Postgres с pgvector/pg_trgm, S3, KMS, PITR, юрлицо в KZ, цена, риски собственности/санкций.
Рекомендация: решить на неделе 0 по чек-листу; держаться стандартного Postgres+S3, чтобы переезд был днями, а не неделями.

**И-9. Способ входа.**
Варианты: SMS-OTP (база инженерии) | WhatsApp-OTP (дешевле/привычнее, нужен Business API) | Apple/Google вход.
Рекомендация: анонимный старт + SMS-OTP для привязки/восстановления; WhatsApp-OTP — проверить цену; Apple/Google — после MVP.

**И-10. Трекер ошибок и мониторинг.**
Варианты: SaaS Sentry (данные в США) | self-hosted GlitchTip/Sentry в KZ.
Рекомендация: self-hosted в KZ (персональные данные могут попасть в стектрейсы).

**И-11. Эмбеддинги.**
Варианты: локально bge-m3 в KZ | Voyage (как в текущем коде, США) | OpenAI embeddings.
Рекомендация: bge-m3 локально (данные в KZ, $0, нет зависимости).

**И-12. Превью изображений.**
База: без превью (#8). Альтернатива: превью ~20–25 KB (`thumbnails.enabled`) — дизайн просит узнаваемость карточек.
Рекомендация: включить превью только для закреплённых/документных вещей.

**И-13. НДС и реквизиты КП.**
Ставка KZ 16% с 2026 (по материалам; в одном примере 12% — неверно) — подтвердить у бухгалтера; режим округления (по строкам / на итог); обязательные поля КП для ИП/ТОО. Всё в конфиге, решение — до недели 9.

**И-14. Автономия по умолчанию.**
База (дизайн/CEO): «Спрашивать всегда» для новых 45+. Инженерно: точные дубли и создание стопок — внутренние действия с undo; предлагаем выполнять их сразу и показывать в «Я сделал» даже в режиме «Спрашивать». Решение — за продуктом.

**И-15. Хранение отправленного PDF КП.**
База: только данные (пересборка детерминирована). Альтернатива: хранить PDF именно отправленной версии (`kp.keep_sent_render`), ~100–300 KB на КП — на случай спора с клиентом.
Рекомендация: хранить отправленные версии.
