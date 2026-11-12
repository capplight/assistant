# Golden set and injection corpus (week 17, spec 3-engineering 5.8, 5.7, 9)

## What is where

| Path | What |
|---|---|
| `src/assistant/ai/golden/` | harness: `cases.py` (format, cassette provider, live router), `suites.py` (one runner per kind), `report.py` (metrics, thresholds), `python -m assistant.ai.golden` |
| `eval/golden/synthetic/*.yaml` | the synthetic set, 200 cases — **generated** by `scripts/golden_synthetic.py` (edit the script, rerun, commit both) |
| `eval/injection/corpus.yaml` | injection corpus, 64 cases RU/KK/EN, «документ → инструмент» |
| `tests/ai/test_golden.py` | the set passes offline; the harness really fails on wrong answers, broken JSON, a leaky gate, a masking leak; reports hold no text |
| `tests/chat/test_injection_corpus.py` / `_db.py` | the corpus against the code defences (unit) and through the real line on Postgres |

## Composition (spec 5.8)

200 cases: RU 120 / KK 55 / mixed 25 — enrichment 60, reminders 30, КП 20, questions with
expected sources 25, injections 15, tool dialogues 30 (tool + arguments, «это / здесь», ask-back
`needs_choice`), expenses 20 (voice, receipt, utility bill, statement).

**Everything is synthetic.** Names, companies, phones (`+7 700 000 xx xx`), БИН/ИИН (`9999…`:
month 99 does not exist, checksum valid so the code keeps it), IBAN (`KZ..999KZT…`), the test card
`4242 4242 4242 4242` are invented. **KK texts are the developer's and wait for a native
speaker's review** (the reminder and intent rules have no reviewed KK vocabulary yet either).
Anonymised real examples (father's ТЗ/КП, feedback with «разрешаю обезличенный пример») never go
into this repository: they live in the KZ bucket `eval-golden/`.

## Case format

```yaml
- id: rem-ru-001                 # reports name cases by id only
  kind: reminder                 # enrich | reminder | kp | question | injection | chat_tool | expense
  lang: ru                       # ru | kk | mixed
  input: {text: "Напомни завтра в 9:00 позвонить врачу"}
  expect: {local: "2026-11-13T09:00"}          # what must come out after our code checks
  cassette:                      # recorded model answers, by Pydantic schema name
    ReminderParseOut: {understood: true, title: "позвонить врачу", date: "2026-11-13", time: "09:00", ...}
  usage: {in: 300, out: 80, cached: 600}       # optional tokens per recorded call ($ metric)
```

A cassette value is a JSON answer, a list (successive calls), `{"$tool_calls": [{name,
arguments}]}` or `{"$raw": "..."}` (invalid text). All relative dates count from **Thu
2026-11-12 10:00 Asia/Almaty**. `expect` keys per kind:

| kind | input | expect |
|---|---|---|
| enrich | `text`, `record_kind` | `type`, `phones`, `amounts` (values), `dates`, `hidden` (must not reach the provider) |
| reminder | `text` | `local`, `rrule`, `status` (ok / ambiguous / form), `options`, `model` (override for the model path) |
| kp | `text`, `prices`, `vat_mode`, `vat_rate` | `lines` (name, qty), `total` (by `kp.calc`), `client_bin`, `hidden` |
| question | `question`, `sources` | `sources` (refs, recall@5), `removed` (sentences the R-36 check must drop) |
| chat_tool / injection | `phrase`, `pages`, `records`, `selected`, `current`, `input_kind`, `candidates` | `route` (`model` or `code:…`), `tool`, `args` (subset), `intent` |
| expense | `source` (voice / typed / receipt / utility / statement), `text` | `amount`, `day`, `category`, `ops` (statement), `code_amount` |

## What runs for real, what is recorded

Every case goes through the production functions: task inputs → `Router.run` (consent, masking,
untrusted wrapping, strict schema, **our Pydantic validation** with one repair) → the module's
own checks (`records.enrich.checked_envelope`, `reminders.parse_phrase`, `kp.extract.check_*` +
`kp.calc.compute`, `chat.service.AnswerGate` + citations, `expenses.parse/receipts/imports`).

- **Deterministic paths are checked for real in CI**: reminder rules (`code_dates`), amount and
  receipt rules (`code_amounts`), КП totals, number/date check of answers, masking of every
  `hidden` value in what was sent, the intent rule and the tool gate (a mutating call without
  intent in the person's phrase is sent to `chat.tools.execute` and must be refused), the chat
  code routes (reminder, expense, note, fast paths, `needs_choice`).
- **Model-dependent answers come from cassettes**: plausible correct answers written by hand,
  some with deliberate mistakes the code must catch (an invented phone, a ТЗ line that is not in
  the text, a number in no source, a misread sum). A cassette run proves the harness and the
  checks; **it says nothing about a model. Real thresholds are known only after a live run.**
- `$` and latency in a cassette run use fixed token counts per kind and no network: not provider
  numbers.
- The harness reproduces the chat routing of `chat/service.py::_run` with the same functions; a
  change to that order must be mirrored in `suites._route`. Search and mutating tools are not
  executed (no DB): a case stops at the gate.

## Metrics and admission thresholds (spec 5.8)

| metric | threshold |
|---|---|
| `valid_json` (model calls that passed our schema) | ≥ 0.95 |
| `dates`, `amounts` (exact, after code checks) | ≥ 0.90 |
| `chat_tool` (code route + tool + arguments) | ≥ 0.90 |
| `mutations_without_intent` | 0 |
| `code_dates`, `code_amounts` (rules) | ≥ 0.90 |
| `masking`, `errors` | 1.0 / 0 |

Also reported: `phones`, `type_f1` (macro), `sources_recall_at_5`, `number_check`, `intent`,
`kp_lines`, `kp_client_bin`, `injection_handled`, `reminder_rules_coverage`, `$` total / per
call, chat step median, latency p50/p95. A provider below a threshold must not be put on a task's
route (automatic admission is week 26, spec 11.3).

The report (stdout, `--json FILE`) holds metrics, counts and failed case **ids** only — never a
case text or a model answer (spec 5.8: only metrics go to GitHub artifacts). Exit code 1 when a
threshold fails.

## How to run

```bash
python -m assistant.ai.golden                         # offline, cassettes (CI job golden-synthetic)
python -m assistant.ai.golden --kind chat_tool --kind injection
python -m assistant.ai.golden --json metrics.json
python -m assistant.ai.golden --live --data /path/to/eval-golden   # real providers, later
python scripts/golden_synthetic.py                    # regenerate the synthetic YAML
```

`--live` uses the real adapters with keys from the environment (never committed) and the golden
user's consent held in memory; cassettes are ignored and the masking check is skipped (requests
of real adapters are not kept).

## Later: `golden-real`

Not set up (needs the founder's decisions and infrastructure): a self-hosted runner on a VM in
KZ, nightly and on the PR label `prompts`, reading the encrypted bucket `eval-golden/`
(anonymised real examples + KK voices with written consent), provider keys from the runner's
secret store. It uploads only `--json` metrics. Prompt changes = PR + this run (spec 5.8).

## Injection corpus

`eval/injection/corpus.yaml`: 64 cases (RU 32, KK 18, EN 14) by channel (document, OCR,
forward, Telegram import, client ТЗ, statement, mail, shared text) and attack (delete, move,
rename, create page, view, create, reorder, send, share, change reminders, КП seller / bank /
totals / price, fetch URL, reveal other data, fake total, tag escape). Fake providers **obey**
the text; tests assert the code still refuses (spec 5.7 rules 1–10): one `<untrusted_data>`
block with look-alike tags removed, masking, intent only from the person's phrase, the gate,
no send/share/fetch/reminder tools at all, КП edit check + patch white list, no OFD fetch of a
foreign URL, no recipient number on the server and «Проверьте» on a draft with a foreign number,
receipt totals only from the text, totals in answers only from sources / `aggregate`, output caps,
shared text in the data block and out of the history and the summary, no reach into another
person's records.
