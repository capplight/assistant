# Исследование компонентов · ноябрь 2026

16.11.2026. Только текст и ссылки: скриншоты чужих продуктов в публичный репозиторий не кладём. Полная версия с 223 скриншотами и 141 разобранным компонентом лежит у основателя локально: `D:\My Project\Assistant\design-research-app\` (9 разделов, в каждом `README.md`, `sources.md`, `shots/`).

**Зачем.** Основатель сказал, что макеты v4 аккуратные, но «очевидно сделаны ИИ». Цель — свой язык, который остаётся простым и понятным, как iOS.

**Как собирали.** Playwright (Chromium, один браузер, паузы между страницами), десктоп 1440 и телефон 390×844. Посетили 83 адреса, шоты дали 68. Источники: сайты продуктов с интерфейсом, страницы App Store, Apple HIG, Material 3, Apple Design Awards 2026, Dribbble и Mobbin (публичные страницы). Ничего не отправляли, аккаунтов не создавали.

## 1. Почему v4 выглядит как «ИИ 101»

Совпадения с типичной выдачей «AI assistant app»:
1. Всё — белые карточки с мягкой тенью на мятном градиенте, одного веса.
2. Повторяется строка «иконка в тонированном квадрате + две строки + шеврон».
3. Изумрудное свечение у вкладки, микрофона, строки и точки статуса.
4. Приподнятый круг в центре панели вкладок, а над ней ещё строка помощника и ряд чипов.
5. Пустой чат: значок со свечением, приветствие и 4 карточки-примера.
6. Один шрифт; цифры не отличаются от текста; цветные числа на плитках 2×2.
7. Статусы — цветные пилюли.

## 2. Топ-20 к внедрению

1. **Голос помощника набран антиквой**, интерфейс — Onest. Примеры: Tiimo, Granola, mymind.
2. **«Корешок»** — результат действия как отрывная квитанция: место · время · «Переложить · Вернуть». Одна форма для чата, верхнего уведомления и «Истории».
3. **«Нить»** — тонкая линия от фразы человека к корешкам результатов. Пример: Mem; та же линия в «Истории», как в журнале Daylio.
4. **Убрать свечения и мятный градиент.** Фон — нейтральная «бумага». Изумруд — только у действий (Apple HIG Color, Halide, Nothing).
5. **Строка помощника — «аксессуар» над панелью вкладок**: при прокрутке сворачивается в саму панель (Apple HIG, Tab bars). Ряд чипов над строкой убрать.
6. **Убрать приподнятый круг.** Особое действие — отдельная кнопка того же уровня (iOS 26–27) или знак внутри ряда вкладок. Выбор остаётся за основателем (сейчас действует Ф-58).
7. **Знак «7 точек»** в цветах стикеров (как у Tot): значок приложения, аватар помощника, загрузка, фильтр заметок.
8. **Табличные цифры** для времени, сумм и кодов; на экране одна главная цифра (Flighty, Things).
9. **Списки без карточек**: цветной заголовок раздела и волосяные линии (Things).
10. **Состояния показывать формой значка**, а не цветными пилюлями: пустой круг, галочка, полукруг, пунктир, перечёркнутый (Linear).
11. **Брифинг как выписка**: у каждого пункта значок источника (Granola).
12. **Вывод одной фразой над графиком** (Apple, экран «Аккумулятор»).
13. **Лента дня**: высота капсулы равна длительности, есть линия «сейчас» и строка «свободно N мин» (Structured, Notion Calendar).
14. **«Изменил помощник»** — штамп «изменено · время» и правка прямо в тексте: старое зачёркнуто, новое выделено маркером (Mem, Superhuman).
15. **Голос**: поле становится тёмным, 5 полосок громкости, расшифровка идёт по мере речи. Без шара и ореола (Raycast, Granola).
16. **Карточка «на проверку»** со счётчиком «1 из 3» и двумя кнопками (Copilot).
17. **Бюджет как темп**: «осталось», линия трат против пунктира плана и флажок «сверх» (Copilot).
18. **Документ начинается с «паспорта»**: сумма, срок и статус сверху, лист A4 — вторым слоем (Stripe Invoicing).
19. **Быстрый выбор даты**: тёмная всплывашка «Когда?»; в «Отложить» слева слова, справа точное время (Things, Linear).
20. **Дело раскрывается прямо в списке**, действия — на тёмной плавающей панели (Things).

## 3. Чего избегать

Свечение как знак ИИ, неоновые шары и сферы. Градиентные фоны. Карточки для всего подряд. Иконка в тонированном квадрате на каждой строке. Приподнятый FAB в панели вкладок. Ряд подсказок над полем на всех экранах. Пустой чат из 4 карточек-примеров. Бенто из равных плиток с цветными цифрами. Цветные бейджи статусов. Голосовой шар в центре. Стекло на каждой карточке. 3D-эмодзи-иконки. Капс. Конфетти на каждой галочке. Слово «ИИ» и «искорки» как украшение.

## 4. Направление: «Бумага и квитанции»

Одна физическая метафора: сохранённое — бумажный предмет (стикер, чек, лист A4), сделанное помощником — квитанция, связь между ними — нить. Простоту дают системные панели и шторки iOS и Android.

- **Шрифт.** Onest для интерфейса. Антиква ★`voice` для голоса помощника и заголовков дня. Кандидаты — PT Serif, Literata, Source Serif 4; казахские буквы проверить по таблице символов. ★`figure` — табличные цифры.
- **Цвет.** Фон ★`paper` без градиента. `brand` — только действие, `highlight` — только «сейчас», красный — только «просрочено» и «удалить». ★`placeColors` — 7 цветов мест, они же цвета стикеров и точек знака. Используются только в значках, кромках и точках.
- **Форма.** У предметов малый радиус (8–12), кромка, перфорация или загнутый угол. Списки — на линиях. Панели — системные капсулы.
- **Движение.** Нить прорисовывается за 250 мс, корешок выезжает из неё, «Вернуть» сворачивает его обратно. Тактильный отклик через `expo-haptics`: сохранение — успех, удаление — предупреждение, выбор — тик. При «Уменьшить движение» анимаций нет.
- **Сигнатуры.** (1) «Нить и корешок», (2) «7 точек».

**Предложение (решает основатель):** перерисовать «Сегодня», «Помощник» (результат из 3 действий), «Заметки» и «Историю» в двух темах и при шрифте 200 %, затем сравнить с v4.

## 5. Ключевые источники

- Apple HIG: [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) · [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) · [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields) · [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) · [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) · [Color](https://developer.apple.com/design/human-interface-guidelines/color) · [Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) · [Charts](https://developer.apple.com/design/human-interface-guidelines/charts) · [Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- Material 3: [Navigation bar](https://m3.material.io/components/navigation-bar/overview) · [Snackbar](https://m3.material.io/components/snackbar/overview) · [M3 Expressive](https://m3.material.io/blog/building-with-m3-expressive)
- Списки и день: [Things](https://culturedcode.com/things/features/) · [Structured](https://structured.app/) · [Tiimo](https://www.tiimoapp.com/) · [Notion Calendar](https://www.notion.com/product/calendar) · [Fantastical](https://flexibits.com/fantastical) · [Linear Mobile](https://linear.app/mobile) · [Daylio](https://daylio.net/)
- Помощник и память: [Granola](https://www.granola.ai/) · [Mem](https://get.mem.ai/) · [mymind](https://mymind.com/) · [Superhuman](https://superhuman.com/) · [Raycast iOS](https://www.raycast.com/ios) · [ChatGPT](https://openai.com/chatgpt/overview/) · App Store: [Claude](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684), [Perplexity](https://apps.apple.com/us/app/perplexity-ask-anything/id1668000334)
- Деньги и документы: [Copilot Money](https://copilot.money/) · [Monzo](https://monzo.com/) · [Wise](https://wise.com/gb/) · [Apple Card](https://www.apple.com/apple-card/) · [Splitwise](https://www.splitwise.com/) · [Venmo](https://venmo.com/) · [Stripe Invoicing](https://stripe.com/invoicing)
- Характер и ремесло: [Flighty](https://flighty.com/) · [Halide](https://halide.cam/) · [Tot](https://tot.rocks/) · [Bear](https://bear.app/) · [Craft](https://www.craft.do/) · [Gentler Streak](https://gentler.app/) · [Nothing](https://nothing.tech/) · [Teenage Engineering OP-1](https://teenage.engineering/products/op-1) · [Apple Design Awards](https://developer.apple.com/design/awards/)
- Чего избегать: [Reflect](https://reflect.app/) · [Dribbble, выдача «AI assistant app»](https://dribbble.com/search/ai-assistant-app) · [Apple Intelligence](https://www.apple.com/apple-intelligence/)

**Не открылись:** Revolut и Cash App (соединение закрыто), Day One и Behance (403), Arc Search (продукт закрыт), страница Granola в App Store (404), (Not Boring) Apps (404). У Material 3 отрисовался только верх страниц.
