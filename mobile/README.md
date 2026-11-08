# Mobile app — week 9 («Сегодня», «Дела» and «Покупки» as checklists, S20, S30)

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
    (main)/page/[id].tsx     universal page (S37)
    (main)/record/[id].tsx   record card (S09), `from` = the page it was opened from
    (main)/records.tsx       «Все записи»
    (main)/more.tsx          «Ещё» (S42)
    (main)/search.tsx        search from the assistant line and «Искать по всем страницам»
    (main)/trash.tsx         «Удалённые записи» (S31)
    phone.tsx                number, SMS code, name (S04b); `reason=expired`: sign in again
    account-consent.tsx      S05 again, for an account with no consent of its own
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
  account/                   phone link / sign-in
  db/                        expo-sqlite: outbox, records, pages + links, sync cursor (SQLite and in-memory impls)
  pages/                     template catalog v1, premarks, labels, LexoRank, page contents and order, page service
  __tests__/                 onboarding, main, api (auth/refresh/errors), consent, sync, capture (share/voice), unit, fonts
  testing/                   helpers + FakeServer (fetch mock, SSE streams)
  chat/                      the one conversation: ask, stream, resume, queue, history, feedback,
                             actions (page_patch, undo), questions back, pending answer, push tap
  push/                      expo-notifications behind a port (FakePush in tests)
  alarms/                    week 8: port (FakeAlarms), native + notification adapters, planner, S15 steps, service
modules/alarms/              native Expo module: Android (Kotlin) AlarmManager + S14 + battery-guide, iOS (Swift) AlarmKit
```

## Week 9: what works

Contract: `../docs/api/today.md`, `actions.md` (week 9 kinds), `reminders.md` «From the assistant line», `chat.md`
(`reminder_draft`, `action.tasks`), `pages.md` (`DELETE /pages` action, habits). Shapes only in `src/api/types.ts` +
`src/api/endpoints.ts`, reconciled with `schemas.py`, `routes/tasks.py`, `routes/today.py`, `chat/service.py` on
2026-11-08. **Checked by Jest with a fake server only: not against the real server, not on a device.**

- **«Покупки» / «Дела и напоминания»** (`page/[id].tsx`, `tasks/`): a record that is a task shows with a 32 pt box
  (the whole row is the ≥56 pt `checkbox`); done rows go to the bottom, grey, «Куплено» / «Выполненное», «Вернуть» on
  «Покупки». Page order (and «⋯» Выше / Ниже / Переместить) stays the person's. «Дела»: Сегодня · Скоро · Пропущено,
  reminders from the phone's own copy (each with «Удалить» → `DELETE /reminders/{id}`, 200 + action, «Отменить»), red missed rows. A shopping task shows on «Дела» when there is no «Покупки».
- **Ticks offline, at once**: `tasks` store (kv) + outbox `task.update` → `POST /tasks/{id}/done` (one tap = one call,
  `client_id`). A tick the server has not seen wins over `/sync`. Strip «Купил: хлеб [Отменить]»: still in the outbox → dropped;
  sent → the undo of the tick's action (tapping the box again is a separate change).
- **From the line**: online every phrase goes to chat on any page (reminder phrases too, no more `/reminders/parse`
  there); `action.tasks` show at once, strip «Добавил в Покупки: … [Открыть] [Отменить]»; `reminder_draft` → S13,
  [Сохранить] sends `message_id`. Offline or «Без ИИ» on «Покупки» / «Дела»: the phrase is one row, as typed
  (`task.create` → `POST /tasks`); «Отменить» drops it from the outbox, or undoes its action once sent. Offline
  reminder phrase: as week 8 («Поставлю, когда появится интернет»).
- **S06 «Сегодня»**: built from local data (offline, «Без ИИ»), `GET /today` when the tab is shown adds the section order,
  ≤2 proposals and ≤1 tip ([Да] / [Не сейчас] → `accept` / `dismiss`; `open_mic`, `put_phrase`, `link_phone`,
  `task_from_item`, `reminder_from_item`; other keys get [Не сейчас] only). Missed: red row [Сделано] (late `acked`
  event, offline too; «Отменить» drops it from the outbox, or undoes the action the events answer returned) [Перенести] (S13 → `PATCH /reminders/{id}` via outbox `reminder.update`; a repeating reminder gets a
  new one-off instead). «Покупки: хлеб, молоко (3)», today's to-dos, «Я сделал за вас» (≤3, «Отменить»), «Что я сделал ›».
- **S20 `/did`**: actions from `/sync` + `GET /actions`, «Отменить» (`POST /actions/{id}/undo`, offline through the outbox),
  undone ones crossed out with «Вернуть» (undo of the undo), reminders' `create_reminder` / `edit_reminder` included.
- **S30 `/habits`**: `GET /habits` (learned rules also from `/sync` `habits`, so they show offline). Learned rule:
  [Изменить] (another page, `PATCH /habits/{id}` `{page_id}`) and [Убрать]; exclusion: [Убрать] only. Both with «Отменить».
- **`/sync` week 9 arrays**: `tasks`, `actions`, `suggestions` (answered / expired ones leave «Сегодня»), `habits`;
  `pending_actions` is read but empty (no producer and no endpoints yet).
- **«Убрать страницу»**: «Отменить» after it was sent = `POST /actions/{id}/undo` of the removal's action; `/restore` only
  when the server gave no action.

Not yet: «Только важное» in S20, S25 for `pending_actions`, editing a task (title, qty, day: `PATCH /tasks`), «Вручную» form for
a task, `open_camera` / `show_share_help` tips. KK strings of this week are drafts for native review.

## Week 8: what works

Contract: `../docs/api/reminders.md`; shapes only in `src/api/types.ts` + `src/api/endpoints.ts` (reconciled with
`schemas.py` and `routes/reminders.py` on 2026-11-08). **Checked by Jest with the native module replaced by
`FakeAlarms` and a fake server. Nothing ran on a phone. The finish criterion («the alarm fires on Xiaomi / Samsung /
iPhone») is NOT met until the checklist below passes on real phones.** No JVM, Gradle, Xcode or Swift compiler on the
dev machine: the Kotlin and Swift files were only parsed (tree-sitter, no syntax errors) — not compiled or type-checked.

- **Native module `modules/alarms`** (Expo module, autolinked from `./modules`; needs a development build).
  Android: `setAlarmClock` for «Будильник», `setExactAndAllowWhileIdle` for «Уведомление», `setWindow` ±10 min without
  SCHEDULE_EXACT_ALARM; full-screen S14 over the lock screen (`AlarmActivity`, #B4361E, «Сделано» 72 dp, «Отложить на
  10 минут» 64 dp, «Позвонить» when the text has a number, «Другое время» 5/30/60 min/tomorrow, back button ignored);
  heads-up with the same buttons when full-screen is not allowed; ring service on the alarm stream, 40→100% over 20 s,
  60 s per ring, vibration 800/400 ms, own 3-tone sound (`res/raw/alarm_tones.wav`); if Android refuses the
  foreground service, the notification channel rings instead (no ramp). Re-plan on `BOOT_COMPLETED`, `TIME_SET`,
  `TIMEZONE_CHANGED`, app update, exact-alarm permission change; a ring missed while the phone was off rings once after
  boot if ≤30 min late. `battery-guide`: maker, «Без ограничений» state, Xiaomi/HyperOS, Tecno/Infinix, Huawei, Oppo, Vivo
  screens with fallbacks to the app's settings page.
  iOS 26+: AlarmKit (`AlarmKitScheduler.swift`), title = the text, «Сделано» / «Отложить» (+10 min via an App Intent);
  repeats are separate AlarmKit alarms. iOS < 26 and **Expo Go**: `expo-notifications` fallback (time-sensitive on iOS,
  `delivery: 'alarmClock'` on Android) — a notification, not an alarm screen; S15 says so.
- **Planning** (`src/alarms/plan.ts`, pure): the server's fires (`/sync` `reminders` + `reminder_fires`,
  `GET /reminders/fires`) → local rings keyed by the fire `key`; repeats +5/+10/+15 made by the phone; «Будильник» only on
  the target phone (R-13), else a notification; iOS ≤48, Android ≤200. `POST /reminders/active` on start/foreground
  (≤1/min). Re-planned on start, foreground, every sync, every change, after a reboot.
- **Events** → outbox `reminder.events` → `POST /reminders/events`: `scheduled_local` / `schedule_failed` (once per fire
  and scheduler), `fired_local` (meta `surface`, `fsi`, `repeat_n`, `scheduler`, `delay_ms`), `shown`, `acked`,
  `snoozed` (meta `until`: ISO with offset, within `at` + 1 min … `snooze_max_hours` from /reminders/settings, default
  48 h; «Другое время» is capped there too), `dismissed`. A refused (`invalid`) snooze keeps the local alarm and goes once
  more without `until` under a new `client_id` (the server then uses +10 min); a second refusal is dropped. Fires saved offline go by `fire_key` once their reminder exists.
- **S13** (`app/reminder-new.tsx`): from the line (`POST /reminders/parse` → «как понял»; the server's setting decides
  code vs model) or by hand («+ → Напоминание», «Сегодня» → «Новое напоминание», «Поставить вручную»). Day of week always,
  big steppers, «Будильник» / «Уведомление», «Напомнить ещё» (15 min / 1 h / накануне), «Может опоздать до 10 минут»
  without exact alarms. [Сохранить] rings from the phone at once (offline too), `reminder.create` via the outbox.
- **S14 in the app** (`app/alarm.tsx`): after AlarmKit / a notification tap; same buttons, no alarm background.
- **S15** (`app/alarm-setup.tsx`): steps per phone, ✓ «Готово» on return from the system screen, «Я включил» for
  autostart (no API can check it), «Проверить будильник» (`POST /reminders/test`; offline a local-only test), result
  «Будильник работает ✓» / «Тестовый будильник не сработал…». Shown right after S04b on Android 14+, from «Ещё →
  Будильники», and from the «Сегодня» banner «Будильники могут не сработать на этом телефоне [Исправить]».
- **S04** (`app/notify.tsx`): the notification window after the first phrase (path 3) and after the first reminder.

**Offline and «Без ИИ» (Ф-1 is not decided; the server's `REMINDERS_RULES_FIRST` is off):**

| | Online | Offline |
|---|---|---|
| «Согласен» | phrase → server parses (model) → S13 → [Сохранить] | «Поставлю, когда появится интернет» [Поставить вручную]; the phrase is parsed when online → «Проверьте напоминание» → S13 |
| «Без ИИ» | phrase → server answers «Укажите время вручную» → S13 by hand (if Ф-1 is taken on the server, code reads it and S13 is prefilled) | same as above |
| S13 by hand | rings at once, sent now | rings at once, sent later |
| Ringing | always local, needs no internet | always local |

Not yet: repeats by days (RRULE) on S13, editing/deleting a reminder (S25, week 9), «Пропущено» red row and the
«Дела» page (week 9), the phone's own parser (only if Ф-1 is taken), voice reminders, «Вибрация» switch (S23),
WhatsApp support button (shown only if `EXPO_PUBLIC_SUPPORT_WHATSAPP` is set; Ф-13). KK strings are drafts.

### Manual test on the founder's phones (development build: `npx expo run:android` / `run:ios`, or EAS `development`)

Do each on **Xiaomi/Redmi (HyperOS)**, **Samsung Galaxy A (One UI 6/7)**, **iPhone iOS 26+** (and an iPhone < 26 if
there is one). Write down phone, OS, time set, time it rang. Expo Go is not enough (no alarm module).

1. Fresh install → path 3 → S04 «Разрешить уведомления» → allow. Android 14+: S04b «Позже» → S15 opens.
2. S15: open each step, allow, come back → ✓. Xiaomi: «Автозапуск» on → «Я включил»; «Контроль активности» → «Нет
   ограничений» → «Я включил». Samsung: Батарея → «Без ограничений» → ✓ by itself. iPhone 26: «Разрешить будильники».
3. «Проверить будильник», lock the screen, wait 1 min → full-screen S14 (Android) / system alarm (iPhone 26) → back in
   the app: «Будильник работает ✓».
4. Line: «Напомни через 5 минут позвонить +7 701 000 00 00» → S13 → «Будильник» → Сохранить. **Swipe the app away**,
   lock the screen. Rings on time; volume grows; stops after 60 s; rings again at +5, +10, +15 min. «Позвонить» opens the
   dialer.
5. Same, press «Сделано» at the first ring → no repeats. Another one → «Отложить на 10 минут» → rings 10 min later.
   «Другое время → Через 30 минут» → rings 30 min later; no backup push before +33 min.
6. Set one for +10 min, **restart the phone**, do not open the app → rings on time.
7. Set one for +10 min, change the time zone in system settings → rings at the same moment.
8. Silent mode / Do Not Disturb: Android alarm and iPhone 26 should still ring; iPhone < 26 only vibrates.
9. Without exact alarms (Android: revoke «Будильники и напоминания») → S13 shows «Может опоздать до 10 минут»; note the
   delay.
10. Without full-screen permission (Android 14+) → heads-up with «Сделано» / «Отложить» instead of S14.
11. Airplane mode: S13 by hand → rings; turn the network on → the server has the reminder and the events.
12. Two phones on one account: the one used last rings as an alarm, the other shows a notification.
13. Leave 24–48 h with a reminder set (Doze) → rings on time.

## Week 7: what works

Contract: `../docs/api/pages.md` «Manual order», `../docs/api/actions.md`; shapes only in `src/api/types.ts` +
`src/api/endpoints.ts` (reconciled with `schemas.py`, `routes/pages.py`, `actions/manual.py` on 2026-11-08).
**Checked by tests with a fake server only: not against the real server, not on a device. Dragging has only its
maths tested: the gesture must be checked on a real phone.**

- **On a page** (`pages/manual.ts`): «⋯» on every card (Выше / Ниже, the sheet stays open; Переместить… S39; Показать ещё
  на…; Убрать с этой страницы; Удалить), «Порядок» in the header (↑ ↓ on every card), long press 400 ms → drag
  (`components/useDrag.ts`, RN `PanResponder`, no native dependency). Screen readers: actions on the card.
- **S39** (`components/MovePageSheet.tsx`), **S34** (`(main)/my-pages.tsx`, from «Ещё»: ↑ ↓, drag, «⋯»; tabs follow).
- **Offline and «Без ИИ»**: shown at once, one outbox row per change (`client_id`, `client_ts`), sent in tap order. While a
  change waits, /sync and `page_patch` only update the server's copy of the row (`writeLocal` / `settleLink`, SQLite v6).
- **«Отменить»**: still in the outbox → dropped, nothing is sent. Sent → `POST /actions/{id}/undo`; the old rows are a
  display guess until it answers, and the phone never writes moves of its own for it. Removing a page has no action yet:
  its undo is `POST /pages/{id}/restore`.
- **Two phones**: `moved: false` (`newer_move`) → the row shows where it is, no dialog. The phone's key + `base_seq` go with
  a move, except when a neighbour has no key yet or the two keys are equal.
- `learned_ru` is added to the strip only when the server says it learned.

Not yet: scrolling at the screen edges while dragging, a haptic tick, «Положить в стопку…» and «Изменить» in «⋯»,
the S35 gallery from S34 («+ Добавить страницу» makes a «Своя страница»), «Настроить» (week 11), S30 / `GET /habits`
(week 9), `still_on` in the strip text. KK strings of this week are drafts for native review.

## Week 6: what works

Contract: `../docs/api/chat.md`, `../docs/api/actions.md`; shapes only in `src/api/types.ts` + `src/api/endpoints.ts`
(reconciled with `schemas.py`, `chat/mutate.py`, `chat/service.py`, `actions/patch.py` on 2026-11-07).
**Checked by tests with a fake server only: not against the real server, not on a device.**

- **Every phrase goes to the server** when it can be asked (3-engineering 5.10 п. 2: the server tells a question, a change
  and a note apart). The phone's guess (`guessLine`: question / change / note) is used only without the server: offline
  or before consent a note is saved here, a question waits, a change says «Сделать это смогу, когда появится интернет»
  [Хорошо]; «Без ИИ» never calls `/chat`. `lineRouting.serverDecides=false` brings week 5 routing back.
- **Page context**: `visible_item_ids` (rows on screen, top first, ≤40), the page's `view_version` (SQLite v5),
  `selected_item_id` = the open record card («это»).
- **US-24**: `action` → no banner, «Переписка» stays closed; the strip over the line «Разложил … [Что изменилось]
  [Отменить]» (10/15/30 s), [Открыть] when the change was on another page. `page_patch` → rows upserted, removed rows
  dropped, group headings from `view_state.groups` (`group_key` = title), changed rows `markerSoft` 600 ms. Nothing moves
  while a finger is on the list (the patch waits). Then `/sync` for the records.
- **«Отменить» / «Вернуть»** (one row of «Что изменилось»): `POST /actions/{id}/undo` with `client_id`, `page_patches`
  applied, `partial` → «Часть уже изменена вами…». Offline: the rows the phone kept go back at once and the undo waits in
  the outbox (`action.undo`, same `client_id`). In «Переписка» actions show with [Отменить].
- **US-28 / US-30**: `needs_choice`, `confirm`, `confirm_manual` → the question in the banner, the `default` option first
  and focused («Оставить мои»). A tap → `choice: {reply_id, option}` + label as text; «Выбрать» → tap a record on the page
  → the original phrase again with `selected_item_id`.
- **«Ответ готов» on «Сегодня»**: `GET /chat/pending-banner` when «Сегодня» opens and on return to the foreground; the
  card sends `banner_shown` / `opened` / `dismissed`. An answer finished after the person went to another page waits on
  «Сегодня» instead of following them.
- **Push** (`src/push/`): native token (`getDevicePushTokenAsync`) sent with `POST /devices` once notifications are
  allowed; tap `{type: "chat_reply", reply_id}` → «Переписка» on the answer; quiet in the foreground. **Not verified**: needs
  a development build and FCM/APNs credentials (none in the repo; the server has none either). The permission is not
  asked yet (S04, week 8 — now done, see above).

Not yet: «Отменено · Вернуть» 5 s (undo of the undo), «Пока вас не было, я разложил…», stacks animation
(`motion.stack`), `actions` / `conversation_messages` arrays of `/sync`, progress «Раскладываю… 12 из 40» [Остановить].

## Week 5: what works

Contract: `../docs/api/chat.md`; shapes only in `src/api/types.ts` + `src/api/endpoints.ts`. **Checked by tests with a
fake server only: not against the real server, not on a device.** CI: `.github/workflows/mobile.yml` (tsc, expo lint, jest).

- **Question in the line, on any page** (`components/AssistantLine.tsx` → `chat/service.ts`): `POST /chat/messages` (SSE)
  with the page's server id. The phone still tells a question from a note (`looksLikeQuestion`): notes are saved
  locally as before; actions on the server come in week 6. «Без ИИ»: a question is the word search, `/chat` is never called.
- **Streaming**: `expo/fetch` (its `response.body` is a ReadableStream on iOS/Android; RN's own fetch buffers the whole
  body). Parser `api/sse.ts`; 40 s without a byte (keep-alives come every ~15 s) counts as a drop.
  **Unverified on a device:** that `expo/fetch` delivers chunks as they arrive over a phone network and through a proxy.
  Fallback in the spec: `react-native-sse` (not installed).
- **S08 banner** shows the message as it streams: «Смотрю записи…», «Нашёл у себя» (local words) first, then the text
  (2 lines), ≤2 chips + «ещё N», the AI label. Stays until «Закрыть» or the next question. Delivery marks:
  `banner_shown`, `opened`, `dismissed` (also when a new question replaces it).
- **Source chip** → the record card on its page (`from`), «‹ Назад к ответу» (`ret`) back to the page or «Переписка».
  A record not on the phone is fetched first.
- **Dropped stream**: resume `GET /chat/messages/{reply_id}/events` with `Last-Event-ID` at 1, 2, 4, 10 s; a finished
  reply comes as `snapshot`. Dropped before `accepted`: the same POST again (same `client_id`). Still nothing:
  «Связь прервалась — ответ не дошёл» + «Спросить ещё раз». `error` with `retry`: a new `client_id`.
- **Offline**: «Спрошу, когда появится интернет» + records found on the phone; asked again on foreground, the 30 s timer,
  or the first request that gets through.
- **S36 «Переписка»**: kept on the phone (last 300 messages, kv-store), merged with `GET /chat/messages` on open; opens on
  the answer from the banner (scroll + screen reader focus); «Свернуть» closes that banner.
- **«Сообщить о проблеме»**: «Ещё» under an answer → reason (`wrong` / `offensive` / `other`), comment, the example box
  (off by default) → outbox `feedback.send` → `POST /feedback`.
- **Copy**: S41/S03 examples no longer promise reminders; «Без ИИ» card «Напишите одну фразу». `start.phrase`
  («— я сразу сделаю») is string 61 of 2-design §7, so it stays. Line hints show a question where questions work.

Not yet: «Ответ готов» card on «Сегодня» (`GET /chat/pending-banner`) and push (week 6), «Не то», «Озвучить», voice
questions (`upload_id`, week 6), «Ответить из общих знаний?», «Очистить переписку».

## Week 4: what works

Contracts: `../docs/api/auth.md`, `search.md`, `pages.md`. **Checked by tests with a fake server and on a real
SQLite engine, not against the real server and not on a device.**

- **Phone on another account** (`account/phone.ts`, `account/switch.ts`). The account's own `app_enabled` decides.
  Nothing is resent. While S05 is open or postponed nothing is sent or fetched (`syncBlocked()`), and that holds over a
  restart. «Позже» is on the screen: consent must be free; the app then works on this phone alone and asks at next launch.
  **What happens to the old anonymous account's local records:** until consent, all stay on the phone and go nowhere.
  After consent: live ones are queued for the new account under the same `client_id` from local text and files
  («Ждёт связи» until sent); consent and device go first; never-sent ones stay queued (half-done uploads restart).
  Deleted records and hidden repeats are not sent and stay local. A record with no local content stays on this phone
  only. «Верно», «Исправить», «Удалить» on the way are dropped: they name old ids (a deletion stays local). Review marks
  are re-created by the server. Pages are re-created; a topic the account has adopts its page. The copy on the old
  anonymous account stays there untouched (no merge on the server).
  If the account already has consent, the same move happens at once, and its «Без ИИ» choice stands.
- **Rejected refresh**: `details.account_linked` (else the remembered `is_anonymous`). Linked: S04b with no
  `Authorization`, tokens cleared, no `/auth/anonymous`; local data and the outbox stay. Anonymous: device key, as before.
- **«Заметки»** shows every visible record, also offline and saved elsewhere, except those removed from the page (R-54,
  no such action until week 7) and beyond the newest 2000 on the phone (`LIST_LIMIT`).
- **Re-adding a removed topic page**: the tab goes to the old place at once; `POST /pages` (`revived`) replaces the
  removed row, links are back because they are keyed by the server id.
- **«Исправить»** on S09: overlay + `item.correct` → `PATCH /items/{id}` with `corrections`, `base_seq`. On conflict: the field unchanged, it goes
  again on the newer version; the field changed, the card shows the current value and asks again. No «Исправить» for a whole transcript or an empty value (server: 422).
- **Name**: `profile.update` → `PATCH /me`, only when typed. After a sign-in the server's name wins.
- **«Найти на странице»** (S10): on the phone at once (`records/search.ts`: case, ё, Kazakh letters as Russian ones, digits
  without spaces); online the server adds word forms, typos, meaning. No FTS5: a filter over the newest 2000 records.
- **Search in the line**: v0 tells a question by its first word or «?» (`looksLikeQuestion`), and opens the results screen
  with «Сохранить как запись» in case it was a note. Instead of S08: answers and chips come with chat in week 5.
- **«Удалённые записи»** (S31) from «Ещё»: local, offline, «Вернуть»; `item.delete` / `item.restore`. «Удалить запись» on S09
  with the undo strip. A tombstone deletes the local row.
- **`/sync`**: `screen_summaries` are ignored (the phone counts its own lists); the cursor is always `next_since`.
  «Сохранить оригинал» (`/items/{id}/original/pin`) is not on the card yet: not in the week 4 list.
- **Undo strip**: 10 s, 15 s at font ≥150%, 30 s with a screen reader (the numbers of 2-design 4.3).
  Not done: staying while it has screen reader focus.
- **Copy**: «Сделаю, когда появится связь» only when the last request got no answer; otherwise «Сохранил.»
  Hints in the line say what v0 does (`tpl.line_hint_now`); the spec's `tpl.line_hint` wait for their features.

## Week 3: what works

Contract: `../docs/api/pages.md`; shapes only in `src/api/types.ts` + `src/api/endpoints.ts`. Reconciled with
`../src/assistant/api/schemas.py` and routes on 2026-11-07. **Checked by tests with a fake server and on a real
SQLite engine, not yet against the real server or on a device.**

- **S37** (`page/[id].tsx`): the same frame for every template; records from local SQLite, online or not. A page is
  a view: linked rows from `/sync`, plus records saved on this page, plus for «Заметки» (rule «always») everything.
  Order as the server's (`src/pages/contents.ts`); a record without a key yet goes by its date, so nothing jumps
  after sync. «Все записи» in «Ещё» shows the whole memory, also what no page shows.
  «Своя страница»: «Ещё» → name → page; rename with the pencil. Other templates show the plain list until their weeks.
- **Pages offline** (`db/pages.ts`, `sync/engine.ts`): SQLite is the source of truth, the zustand store feeds tabs
  (`store/pagesSync.ts`). `pages.create` rows (also old week 1-2 ones) → one `POST /pages` each, idempotent by
  `client_id`. `409 singleton_exists` → the local page adopts the existing one, keeping its local id.
  Saved from a page → `POST /items`, then `POST /pages/{id}/items` (waits for the page). Pull: `screens`,
  `screen_items`, tombstones `item | screen | screen_item`. «Сегодня» from the server is skipped: built in here.
- **Card S09**: title, source line, status, the label (`ai_generated` or `ai_fields`), «Проверьте N мест»,
  «Что я понял», text. Opening it calls `GET /items/{id}` (the server stops the record waiting for the overnight run).
- **«Верно»** works offline: overlay `records.pending` + outbox `item.verify` → `PATCH /items/{id}` with `verify`,
  `base_seq`. On `409 conflict` the phone compares values: same → repeat with the new seq; changed → not confirmed,
  the card asks about the new value. A permanent refusal clears the overlay.
- **«Отменить» for automatic merges**: strip above the assistant line for 10 s. Comes from `POST /items`
  (`duplicate`) and from `/sync` (files and voice are compared later). Outbox `item.unmerge` → `POST /items/{id}/unmerge`.
- **S04b**: after the first result, once (path 3: after S35; paths 1, 2: after the first record in the line). Number
  (+7 / +996 by the phone's region, tap to change), SMS code, name. «Позже» with the honest line. Later: «Ещё».
  Another account: see week 4.
- **LexoRank** (`pages/lexorank.ts`) passes `../docs/spec/vectors/lexorank.json`, the file the server's tests use.
- **SQLite** migrations run in a transaction. `sqlite.test.ts` runs them and all repository SQL on Node's SQLite.

Not yet: «Как показывать?» for «Своя страница» (always a list), offline placement by rules other than «always»,
`GET /page-templates` (the catalog is still local), voice for the name, the «укажите номер» card on «Сегодня» (R-08).

## Week 2: what works

- **API client** (`src/api/`): base URL from config, JSON, `X-App-Version`, 15 s timeout. Anonymous account
  on first launch (`POST /v1/auth/anonymous` with a 32-byte device key generated once and kept in
  `expo-secure-store`); access/refresh tokens in secure store; `401` → `POST /v1/auth/refresh` (rotation,
  single-flight) → retry; rejected refresh → see week 4. Errors
  `{code, message_ru, message_kk, retry_after?}` → `ApiError`, no answer → `NetworkError`;
  `errorMessage()` picks the server text by language or a local fallback.
  All paths/bodies are in `src/api/endpoints.ts` + `src/api/types.ts` — they are the only place to change if the server moves.
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
`{N}` days in the consent text, voice on S03, offline banner.

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

- `chat.message` outbox rows stay queued (chat week 5).
- S03 is typed only.
- «+» sheet options, «Как выглядит», Terms/Policy links, «Настраиваю для другого человека», most «Ещё»
  entries (Мои страницы, Что я сделал, Настройки, …) are placeholders.
- Answer banner shows a local confirmation, not a real answer; no source chips or AI label yet (week 5).
- «Настроить» week 11.
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
