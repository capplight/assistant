# Mobile app — week 2 (API client, sync, share, voice)

Expo SDK 58 (React Native 0.88, New Architecture), TypeScript strict, expo-router.
Spec: `../docs/spec/SPEC.md`, `../docs/spec/final/2-design.md`, `../docs/spec/final/3-engineering.md` §2.1, §11.2 (week 1, Mobile).

## Run

```bash
cd mobile
npm install
npx expo start          # scan the QR code with Expo Go (Android / iOS)
```

Expo Go still runs the app (onboarding, typed records, sync, voice via `expo-audio`), but **«Поделиться»
needs a development build** — `expo-share-intent` adds an iOS Share Extension and Android `SEND` filters
(the module is disabled automatically in Expo Go). Build: `npx expo run:android` / `npx expo run:ios`
locally, or `npx eas-cli@latest build --profile development`. `ios.bundleIdentifier` / `android.package`
are placeholders (`kz.assistant.mobile`) — replace before the first store build.

## Point the app at the local API

1. Start the backend reachable from the phone (same Wi-Fi), in `app/`:

   ```bash
   # .env (or shell): listen on all interfaces, dev secrets, presigned URLs must use the LAN IP too
   API_HOST=0.0.0.0
   API_PORT=8000
   API_DEV_MODE=true
   API_PUBLIC_BASE_URL=http://192.168.1.20:8000   # your computer's LAN IP — the phone PUTs files here
   python -m assistant.api
   ```

2. The app finds the API in this order (`src/api/config.ts`):
   - `EXPO_PUBLIC_API_URL` — e.g. `EXPO_PUBLIC_API_URL=http://192.168.1.20:8000 npx expo start`
     (or put it in `mobile/.env`); no `/v1`, no trailing slash;
   - `expo.extra.apiUrl` in app config;
   - **dev default:** `http://<IP of the Metro host>:8000` — taken from Expo's `hostUri`, so with Expo Go /
     a dev client on the same Wi-Fi it usually just works;
   - `http://127.0.0.1:8000` (simulators, tests). Android emulator: use `EXPO_PUBLIC_API_URL=http://10.0.2.2:8000`.
3. Plain `http://` to a LAN IP works in debug builds (Android allows cleartext in debug; iOS ATS doesn't
   apply to IP addresses). Production uses `https://api.<домен>`.

Windows: allow inbound TCP 8000 in the firewall for the private network.

Checks:

```bash
npm test                # Jest + React Native Testing Library (jest-expo preset)
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint (eslint-config-expo, flat config)
```

To restart the first-launch flow on a device: clear the app's data (or reinstall Expo Go's project cache).

## Structure

```
src/
  app/                       expo-router routes
    _layout.tsx              root Stack, fonts (Onest), theme
    (onboarding)/            first launch: welcome (S01–S02) → consent (S05) → start (S41)
                             → phrase (S03, path 3) / gallery (S35, paths 1 and 3)
    (main)/_layout.tsx       Tabs navigator with custom footer: answer banner + assistant line + tabs
    (main)/index.tsx         «Сегодня» (S06, empty state)
    (main)/page/[id].tsx     universal page (S37 placeholder)
    (main)/more.tsx          «Ещё» (S42)
    chat.tsx                 «Переписка» (S36, full screen placeholder)
  components/                AssistantLine, AnswerBanner, BottomTabs, AddSheet, TemplateCard, …
  theme/                     tokens from 2-design §2: colors (light/dark), typography, spacing, radii, motion
  i18n/                      i18next; locales/ru.json (default), locales/kk.json (DRAFT)
  store/                     zustand stores: onboarding, pages, assistant (persisted via expo-sqlite kv-store)
  api/                       /v1 client: config, tokens (secure-store), errors, endpoints, types
  consent/                   S05 texts (server + bundled snapshot), consent request builder
  sync/                      outbox sender + /sync puller, app-level triggers
  records/                   Capture service (text / file / voice → record + outbox), file ops
  share/                     expo-share-intent bridge + handler
  voice/                     fragment session logic + expo-audio hook
  db/                        expo-sqlite: outbox, records, sync cursor (SQLite and in-memory impls)
  pages/                     template catalog v1, premarks, page labels
  __tests__/                 onboarding, main, api (auth/refresh/errors), consent, sync, capture (share/voice), unit, fonts
  testing/                   helpers + FakeServer (fetch mock)
```

## Week 2: what works

- **API client** (`src/api/`): base URL from config, JSON, `X-App-Version`, 15 s timeout. Anonymous account
  on first launch (`POST /v1/auth/anonymous` with a 32-byte device key generated once and kept in
  `expo-secure-store`); access/refresh tokens in secure store; `401` → `POST /v1/auth/refresh` (rotation,
  single-flight) → retry; rejected refresh → sign in again with the same device key. Errors
  `{code, message_ru, message_kk, retry_after?}` → `ApiError`, no answer → `NetworkError`;
  `errorMessage()` picks the server text by language or a local fallback.
  All paths/bodies are in `src/api/endpoints.ts` + `src/api/types.ts` — **items/sync shapes follow spec §4
  and were cross-checked with the in-progress server code (`routes/items.py`, `routes/sync.py`) on
  2026-11-07**; they are the only place to change if the server moves. Open point: the server's
  `ItemCreateIn` has no `source_meta` yet, so voice fragments' `recording_id` is currently dropped.
- **S05** shows the legal texts from `GET /v1/consents/text` (checkbox labels, 18+ line, push line,
  recipients); offline — a bundled byte-identical snapshot of the server texts (`src/consent/texts.ts`).
  The button records exactly what was on screen: `POST /v1/consents` with `version` + `text_hash` per kind
  and `age_confirmed_18: true`. «Согласен» = `pd_processing, ai_cross_border, terms, push_content`;
  «Без ИИ» = `pd_processing, terms`. Then `POST /v1/devices` (upsert by install id). Both go through the
  outbox — S41 opens immediately, online or not.
- **Outbox sync** (`src/sync/engine.ts`): consent/device first (strict order), then items. Items:
  `POST /v1/uploads` → presigned `PUT` → `/complete` (upload id saved, never re-uploaded) →
  `POST /v1/items` with `client_id` (= idempotency key; a retry after a lost response can't duplicate).
  Network/5xx/429/`consent_required` → retry with exponential backoff (2 s … 10 min, `Retry-After`
  honoured); other 4xx → `failed`, kept. Rows are never deleted. Then `GET /v1/sync?since=` pages into
  the local `records` table (items + tombstones) and moves the cursor. Triggers: launch, after every save,
  return to foreground, every 30 s in foreground. Nothing is synced before S05.
- **Local records** (SQLite `records`, migration v2): everything saved is visible immediately with status
  `queued` («Ждёт связи»), later the server status.
- **Share** (`src/share/`): text, links, images, PDF, Word, Excel, audio (single and multiple) → one record
  per file (copied into the app's document dir, sha256 computed) + outbox → toast «Сохранено».
  Shared text with files is kept as their note. Config plugin set in `app.json`.
- **Voice** (`src/voice/`): `expo-audio`, AAC mono 16 kHz 24 kbps, metering on. Mic permission on first
  press. «Слушаю…» + timer + level ring, «Отмена» / «Готово»; no live transcription. A new fragment every
  3 min («Продолжайте — я слушаю дальше»), stop at 10 min. One recording = one local record; each fragment
  = one upload + one `POST /items` linked by `source_meta.recording_id`. Offline → queued.
- **«Без ИИ»**: no mic (→ «Написать»), voice can't start; typed text/share are saved as records (no AI
  calls are made by the app; the server decides `needs_consent`).
- Assistant line v0 «только записать»: typed text → record + `item.create` (no `/chat/messages` yet).

Not yet: autostop after 2.5 s of silence, S22 preview sheet with a text note before saving (share saves
directly), background sync while the app is closed (`expo-background-task`), push token in `/devices`,
`{N}` days in the consent text, voice on S03, offline banner, records list UI.

## Week 1 (still valid unless replaced above)

- First launch: 3 welcome frames (button-only, «Пропустить» on each, RU/KK switch, soft picks on frame 2)
  → consent S05 (two items with checkboxes, all recipients named, 18+ line, «Согласен» / «Без ИИ» equally
  prominent) → S41 «С чего начнём?» with three paths: one phrase (default, accent, first in focus order),
  template gallery (6 templates as cards), blank page. Choosing creates local pages. Onboarding state
  (language, welcome seen, picks, consent record, path, done) is persisted; an interrupted launch resumes.
- Tabs: «Сегодня» + up to 3 user pages (2 at font ≥150%) + «Ещё»; overflow pages are listed in «Ещё».
  Active tab = colour + 3 pt bar + bold label. No swipe between pages.
- Assistant line above the tabs on every main page and in «Переписка»: «+» sheet, text field, mic,
  context chip «Про: <страница>» (tap toggles «Про: все страницы»). Two-row layout at font ≥150%.
  In «Без ИИ» the mic is replaced by «Написать».
- Sending text writes an `outbox` row (`chat.message`, or `capture.text` in «Без ИИ»), adds to the local
  conversation and shows the answer banner with «Открыть ответ» → «Переписка» and «Закрыть».
- Consent and created pages are also written to the outbox (`consent.accept`, `pages.create`).
- Accessibility basics: labels/roles/states on all controls, touch targets ≥48 (primary ≥56), all text
  scales with the system up to 200% (`maxFontSizeMultiplier=2`), wraps instead of truncating.

## Stubbed / not yet

- `pages.create` and `chat.message` outbox rows stay queued (pages API week 3, chat week 5).
- S03 is typed only.
- «+» sheet options, «Как выглядит», Terms/Policy links, «Настраиваю для другого человека», most «Ещё»
  entries (Мои страницы, Все записи, Что я сделал, Настройки, …) are placeholders.
- Answer banner shows a local confirmation, not a real answer; no source chips or AI label yet (week 5).
- Pages have no records; «Найти на странице» is a dead field. Page order is an integer, not LexoRank.
- Seed pages (Заметки / Дела и напоминания / Расходы) exist before onboarding; onboarding replaces them.
- SQLite is plain (no SQLCipher / drizzle / FTS5 yet). Ids are pseudo-random UUID-shaped (TODO expo-crypto).
- Theme follows the phone only (switch comes with S23). Reduce Motion is not wired (no animations yet).
- KK strings are a **draft** (see `kk.json` → `_meta`); only §7.3 strings come from the spec, the rest are
  developer drafts. Native-speaker and legal review required.

## Kazakh glyph check (release blocker, 2-design §2.2)

- Automated (`src/__tests__/fonts.test.ts`): parses the cmap of Onest Regular/Medium/SemiBold/Bold and
  checks ә ғ қ ң ө ұ ү һ і (both cases), ₸ № « » are in the font itself.
- **TODO (manual, on devices):** height/weight match, tails of қ ң ғ ұ not clipped at line-height 1.3,
  iOS + Android (Xiaomi, Samsung) at 100% and 200%, with `KAZAKH_GLYPH_TEST_LINE` (`src/theme/typography.ts`).
  Note: the spec's test line has no «ө/Ө» — the automated test covers it separately.
