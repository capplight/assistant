# Current state of the product (as of 2026-11-03) — shared brief for all reviewers

## How to work (read first)
- Evaluate the product exactly as the founder defined it below. Do NOT replace it with a different product and do NOT change his decisions.
- DO give your own honest opinion. If you disagree with any of his decisions, say so clearly, with reasons and evidence, and offer an alternative for him to choose. Don't just agree to please him. He explicitly asked for real opinions.
- Write IN RUSSIAN, plain language (the founder is not technical).

## The product (founder's words)
"A universal assistant — a reliable partner for anyone who uses a phone, at home or at work. It works like ChatGPT and Claude, but the older generation doesn't use them; our job is a simpler, clearer version with new features that make life easier." "It's like Notion AI, which can organize everything for you" — but on the phone, over all of the person's notes, files and sources. "It's a universal agent that sets everything up for you" — no sections the user has to choose.

## Founder's decisions so far
1. Universal product; NO national identity in brand/design (no Kazakh ornaments, yurt motifs, dombra etc.). Kazakhstan = launch market only: Russian + Kazakh languages in the app; data of users from Kazakhstan stored in Kazakhstan per law 94-V (with explicit consent before sending to foreign AI providers; App Store 5.1.2(i) requires naming them). Users from neighboring countries are welcome.
2. Mobile app iOS + Android.
3. Several AI providers that switch automatically when one runs out of its limit (agents recommended paid tiers of Claude / OpenAI / Gemini with fallback, because free tiers forbid personal data and multi-account rotation).
4. MVP first; pricing/tariffs later.
5. Telegram "Saved Messages" import via user login: yes.
6. Gmail: no paid Google security verification — free and safe option (agents proposed: Share from Gmail, personal forwarding address, drafts opened in the phone's mail app).
7. Commercial proposal (КП) default format: whatever is cheapest for AI (agents: AI outputs only data, code renders; default PDF, Word on request).
8. Don't keep originals (voice, Word, PDF, screenshots): transcribe/extract text and keep the text if it takes less space. Open options from the engineer for the founder: keep company КП template/logo; keep generated КП as data only; "pin original" button; 7-day trash for originals; no thumbnails.
9. UI must be interesting and the user must immediately understand the advantages.
10. No sections like Home/Work/Memory — one agent that organizes everything itself.

## Core features (MVP)
Capture via Share button, voice, photos/screenshots, files; memory of everything (as text) with search; ask/act over everything (answers with sources, summaries, lists); duplicate detection (founder has hundreds of duplicate notes); alarm-like reminders that can't be missed (founder's wife uses alarms as reminders); КП: upload client spec PDF/Excel → generate КП → edit by plain request → send via WhatsApp/mail (founder's father makes КП on his phone); drafts of emails/messages sent only after user confirmation; Telegram import; Russian + Kazakh.
After MVP: Gmail direct sending, more document templates, family sharing, WhatsApp import, Kaspi/1C, pricing.

## Real users so far
Founder (notes chaos, duplicates), his wife (losing things, alarms as reminders), his father (small business, КП on phone).

## What earlier reviews found (for context, you may disagree)
- CEO: full scope 6/10; MVP 7.5/10; "one agent, no sections" 8/10. Risk: users won't discover abilities without contextual suggestions; trust when agent acts on its own → internal actions free, external/irreversible only after "Да", everything undoable.
- Market: no big player targets "ChatGPT for people who don't use ChatGPT" in KZ/CIS; ChatGPT ~94% of KZ chatbot usage, ChatGPT Go ~2,000 KZT; Gemini makes documents free; Kaspi (assistant Kasper) and Yandex Alice move toward personal assistants; window ~1-2 years; older users stick to one service (only ~9% try new ones) → growth via families; ~1.4-1.6M individual entrepreneurs in KZ.
- Cost: cheapest paid models ≈ $0.15-0.35/month for a light user, $0.5-1.3 typical, up to ~$1.6-7.8 for heavy document users; biggest risk is a too generous free tier.
- Engineering: React Native + Expo; existing Python backend (FastAPI, Postgres+pgvector, job queue, reminders, Q&A, consent gate) partly reusable but its 300 tests never ran on a real database; MVP ~10-12 weeks solo with AI coding agents; impossible directly: Apple Notes (no API), Gmail reading without paid verification, Google Photos library; reminders reliability on Xiaomi/Samsung is a top risk; Telegram code entry may look like a scam to older users and raise store review questions; deleting originals is irreversible if OCR/STT makes mistakes.
- Hybrid "code first, AI fallback" for reminders, КП math, search, duplicates judged useful (8/10 for users) — the founder postponed this topic.
- Design: home = Today / What I did / Suggestions + big mic button; 3 tabs (Home · Find · Tasks); agent shows its work with sources and Undo; smart groups appear automatically. The earlier "Shanyrak" national visual style is REJECTED by the founder.
