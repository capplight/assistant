# UI kit «Мята / Глубина»

Source of truth: `docs/design/system/design-system.md` (+ `tokens.ts`, `screens.html`), Ф-33…Ф-46.
Import everything from `@/components/ui`. Tokens: `@/theme` (`useTheme()`, `useLayout()`).

## Tokens (`src/theme`)

- **Colours by role** (`theme.colors`): `bg`, `surface`, `surfaceRaised`, `surfaceSunken`, `ink` / `ink2` / `ink3`
  (ink3 only on `surface`), `separator`, `iconSecondary`, `brand` (+`brandPressed`, `brandTint`, `onBrand`),
  `highlight` (+`highlightTint`, `onHighlight`, `onHighlight2`), `success` / `warning` / `danger` (+tints, `onDanger`),
  `focus`, `scrim`, `fade`. Also `theme.notes` (sticker fills, keys unchanged), `categoryColors`, `pageColors`, `withAlpha`.
- Renamed (old names are gone): `accent→brand`, `onAccent→onBrand`, `marker(Soft)→highlight(Tint)`, `alarm→danger`,
  `done→success`, `warnText→warning`, `line→separator`, `lineStrong→iconSecondary` (mechanical stand-in: borders and
  outlines that used it should be **removed** or become tonal fills when you restyle a screen).
- **Type** (`variant`): `largeTitle 30` · `title1 24` · `title2 20` · `headline 17/600` · `body 17` (Android 16) ·
  `bodyStrong` · `callout 15` · `sectionLabel 15/600, no caps` · `footnote 13` · `caption 12` · `tabLabel 11` ·
  `button 17` (= body) · `number` · `amount 40` · `time 36`. `callout` / `footnote` default to `ink2`.
  Mechanical renames done: `title1(28)/display → largeTitle`, `section → sectionLabel`, `meta → callout`.
  Use `footnote` for dates when you restyle.
- **Sizes** (`theme.size`): `buttonHeight 50`, `buttonHeightSmall 36`, `rowHeight 52/64`, `minTouch 48`,
  `icon 24 / iconSm 20 / iconLg 28`, `assistantCapsule 52`, `tabBar 60`, `headerButton 36`, `chipHeight 32` …
  `primaryTouch → buttonHeight`, `cardIcon → icon`. Radii: `xs 6 · sm 10 · md 14 · lg 16 · xl 20 · sheet 24 · round`
  (old `card→lg`, `button→md`, `input→sm`, `chip→round`, `note→md`).
- **Elevation**: `theme.elevation.card` (null in dark) and `theme.elevation.floating`. Never borders on cards.
- **Motion**: `theme.motion.press/fast/base/exit/sheet/check/toast/…`, `pressScale 0.97`, `springSheet`, `toastMs 5000`;
  `useReducedMotion()` → fade only.
- Scheme follows the phone; `useSchemePreference.getState().set('dark' | 'light' | 'system')` overrides (for S23 later).

## Components

| Component | Props (main) | Replaces |
|---|---|---|
| `Icon` | `icon` (Lucide), `size 'sm'|'md'|'lg'` (20/24/28), `color` role | ad-hoc `<X size={26} strokeWidth={2}>`; `PageIcon` / `pageIcon(key)` for page icons |
| `Button` | `label`, `variant 'primary'|'secondary'|'text'`, `size 'regular'|'small'`, `tone 'highlight'` (on «Дальше»), `labelColor 'danger'`, `icon` | old `components/Button` (`outline` → `secondary`, done everywhere) |
| `Card` | `tone surface|raised|sunken|brandTint|highlight`, `padded`, `onPress` | bordered `View`s with `radius.card` |
| `ListGroup` + `ListRow` | row: `title`, `meta`, `left` / `icon` (30 tinted square), `value`, `right`, `chevron`, `danger`, `onPress` | menu rows in «Ещё», sheets, settings |
| `CheckCircle` / `CheckMark` / `CheckRow` | `checked`, `onChange`, `label` (CheckCircle: light haptic on check, none with reduced motion) | the 32/40/44 squares (`TaskRow`, `PlannerView`, `ShoppingView`, `MiniSchema`); `components/Checkbox` (→ `CheckRow`, done) |
| `StickyNote` + `ResponsiveGrid` | note: `text`, `title`, `date`, `color` (NoteColorKey), `pinned`, `onLongPress` (menu — no «⋯»); grid: `columns?` (default from `useLayout`) | `page/StickersView` cards |
| `Chip` | `label`, `variant tonal|neutral|selected`, `icon`, `onPress` | filter / suggestion chips (Documents, Expenses, SourceChips) |
| `Sheet` + `ActionList` | `visible`, `onClose`, `title`, `footer`, `closeButton`, `scroll`; actions: `{key,label,icon,onPress,danger,hint}` | the ~15 `Modal` sheets |
| `Header` / `BackButton` / `HeaderButton` | `title`, `meta`, `back={{onPress}}`, `actions` (≤2: search, ⋯), `children` (segments) | 4 kinds of «‹ Назад», `PageFrame` header |
| `SegmentedControl` | `segments [{key,label,count}]`, `value`, `onChange` | `ReminderLists` tabs, Stickers «Ряды | Доска», Documents filter, Expenses period |
| `EmptyState` | `icon`, `text`, `example {label,onPress}` | `page/PageEmpty`, dashed «empty» boxes |
| `ToastBar` | `text`, `success`, `actions`, `onClose` | `UndoStrip` (done); confirmation toasts (done: `ToastLine` right above the capsule in the main bottom and «Переписка», `ToastHost` at the bottom edge elsewhere) |
| `TabBar` | `tabs [{key,label,icon,active,onPress}]` | `BottomTabs` (done: 4 tabs max — Сегодня + 2 pages + Ещё; 1 page at ≥150 %) |
| `BottomFade` | `height` | — (content dissolves above the floating bottom) |

Already migrated: `BottomTabs`, `AssistantLine` (one capsule; no «Про: …» label — Ф-47;
voice / send / «Написать» / keyboard / undo unchanged), `MainFooter`, `UndoStrip`, `ToastHost`, `AnswerBanner` (look only),
`AddSheet` and `PageNameSheet` (on `Sheet`), all `Checkbox` uses. Week 19 (screens): «Сегодня» (`Header`, sun `NextCard`,
one flat `DayCard` of `TodayRow`s with `CheckCircle`, tiles on `Sheet`), `AnswerBanner` (header «Помощник» + ✕, tonal chip),
`PendingAnswerCard` and the reminder draft on `Card`, «Переписка» (`Header` «‹ Свернуть», bubble, menu on `Sheet`),
`FeedbackSheet` on `Sheet`, welcome (Ф-34), «Ещё» (`ListGroup`, Ф-41), «Настройки» and «Политика / Условия / Согласия».

Pages (week 19): `PageFrame` header is one `Header` line — title, 🔍 (`page-search`, opens the field), ⋯ (`page-menu` →
`Sheet` with «Порядок», «Переименовать», «Настроить»); «Заметки» = `StickyNote` cells in `layout.noteColumns` (no ⋯, long
press = menu, `Ряды | Доска` only with `board` on); `TaskRow` / `PlannerView` / `ShoppingView` / `NotebookView` / `duplicates`
on `CheckMark`; `ReminderLists` `Segments` on `SegmentedControl`; «Покупки»: row tap = bought, amount as text → `qty-sheet`;
`StackCards`, `PlannerView` slot menu, `StickersView` colours, `my-pages`, `record/[id]`, `page-settings/[id]` on `Sheet`;
`Header` / `BackButton` in `records`, `trash`, `stack/[id]`, `duplicates`, `my-pages`, `record/[id]`, `page-settings/[id]`;
S38 shows name / icon / view only unless `page_settings_full` (Ф-40). Kit additions: `Header.titleTestID`; `StickyNote`
`highlighted`, `accessibilityActions`, `children` (status / AI label lines).

**Still to move onto the kit (screen agents):** sheets `ChangesSheet`, `MovePageSheet`, `RecordMenuSheet`, `page/FieldSheets`,
`page/ExpenseParts`, `page/ExpensesView`, `page/BoardView` (hidden by `board`), the `Modal`s in `(main)/import`, `habits`;
«Назад» in `import`, `did`, `habits`, `kp/[id]`, `my-data`, `Gallery` → `Header`/`BackButton`; `Screen` keeps working
(bg + gutters + 600 column); `SearchResults` `FindField` still has its outline.

## Feature switches

`useFeatures()` / `useFeatures((f) => f.board)` / `getFeatures()` from `@/store/features` (`GET /v1/features`,
`docs/api/features.md`): fetched at start and on foreground, last answer cached, offline defaults = Ф-33…Ф-44
(`FEATURE_DEFAULTS`). Hide what is off (`board`, `statements_pdf`, `receipt_qr`, `assistant_views`, `page_settings_full`,
`telegram_login`, `personal_mail`, `setup_for_other`, `today.*`, `pages.first_use`). Tests: `happyServer()` answers
`FEATURES_BODY`; override with `.on('GET /features', …)`. Read by: «Сегодня» (`today.*`), welcome (`setup_for_other`,
`consent_screen`), «Настройки» (`telegram_login`, `personal_mail`).

## Adaptive rules (every screen)

1. Read the window through `useLayout()` — never `Dimensions` directly. Classes: `compact <360`, `regular 360–599`,
   `expanded ≥600`; `twoPane ≥840`; `landscape`, `tablet`, `insets`.
2. Side padding = `layout.gutter` (12 / 16 / 20; also `theme.screenPadding`). Text and lists never wider than
   `layout.contentMaxWidth` (600), centred (`readableColumn()` or `Screen`). The bottom (capsule + tabs) is ≤600 too.
3. Grids: `ResponsiveGrid` (stickers: `layout.noteColumns` = 2 · 3 from 600 · 1 at ≥150 % · 1 under 360 from 130 %);
   tiles: `layout.tileColumns` / `tileColumnsFor()`; cell width `gridItemWidth()`. No fixed pixel widths for content.
4. Two panes only at `twoPane` and only where the design asks (list + record); otherwise one centred column.
5. Font scale 1.0–2.0: text through `AppText`, no fixed `height` around text (use `minHeight`), no `numberOfLines`
   on sums / times / the «ИИ» label, rows of ≥3 labelled buttons wrap or stack at `largeFont`, targets ≥48
   (a 36/40 visible circle sits inside a 48 `Pressable`, or use `hitSlopFor`).
6. Safe areas: the root stack pads landscape side insets; screens use `Screen` / `SafeAreaView` for top / bottom.
7. Tests: a new screen gets a case in `__tests__/font200.test.tsx`; kit components are audited at
   `AUDIT_MATRIX` (320 / 360 / 412 / 600 / 840 × 1.0 / 1.3 / 2.0) in `__tests__/ui.test.tsx` — reuse it for your screen.
8. One `primary` button per screen; one sun (`highlight`) fill per screen; red only for overdue / delete;
   «ИИ» only on the disclosure / consent places and the AI label. No national motifs.

## Open questions (for the designer / founder)

- `brandTint` tuned from `tokens.ts` (#CDEBDB → #D2EEDF light, #1E5248 → #1C4D44 dark) so brand text on it is ≥4.5:1; update `docs/design/system/tokens.ts` when the designer agrees.
- The floating bottom is drawn in flow (content ends above it) with a 24 dp fade, not over the content as in the mocks:
  screens do not reserve bottom space yet. Making it overlay needs every scroll view to pad by the bar height.
