# Mobile app — week 1 skeleton

Expo SDK 58 (React Native 0.88, New Architecture), TypeScript strict, expo-router.
Spec: `../docs/spec/SPEC.md`, `../docs/spec/final/2-design.md`, `../docs/spec/final/3-engineering.md` §2.1, §11.2 (week 1, Mobile).

## Run

```bash
cd mobile
npm install
npx expo start          # scan the QR code with Expo Go (Android / iOS)
```

Everything used so far ships in Expo Go (expo-router, expo-sqlite, expo-font, expo-localization,
react-native-svg). A **development build** (`npx eas-cli@latest build --profile development`) becomes
necessary from week 2+ (share extension, own `alarms` module, SQLCipher).

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
  db/                        expo-sqlite outbox table + OutboxRepository (SQLite and in-memory impls)
  pages/                     template catalog v1, premarks, page labels
  __tests__/                 onboarding flow, tabs + assistant line, unit (i18n, outbox, tokens), fonts
```

## What works (locally, no backend)

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

- **No backend calls at all.** Outbox has no sender (week 2). Consent text, `{N}` days (placeholder 30),
  version/hash should come from `GET /consents/text`; anonymous account `POST /auth/anonymous` not called.
- Voice: mic only shows the «Слушаю…» state, nothing is recorded (week 2, expo-audio). S03 is typed only.
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
