# Chat cost report and ops alerts (week 17, spec 3-engineering 5.3, 5.4, 5.10 rule 9, 8, 12)

Code: `src/assistant/ai/costs.py`. Table: `ops_alerts` (migration 0024). No admin HTTP endpoint:
the API has no admin auth yet, so this is a CLI for the server (no personal data in its output).

## Report

```bash
python -m assistant.ai.costs report [--days 7] [--json]
```

From `provider_usage` (tasks `chat` and, since Ф-88, `chat_change` (Sonnet), one successful call = one step), `usage_counters.chat_turns`
and the `budgets` day wallets, per local day (`budget_tz`, Asia/Almaty):

| column | meaning |
|---|---|
| steps / fail | successful chat calls; attempts that did not answer (fallback, retry, invalid) |
| turns, st/turn | phrases sent to the line (incl. those answered by code); steps per phrase |
| $total, $/step, $p50, $p95 | chat cost of all attempts; per step; median / p95 step |
| ms p50 / p95 | step latency |
| cache | cache-read share of prompt tokens (`cached_in / (tokens_in + cached_in + cache_write_in)`) |
| fallb, strong | share of steps on a non-primary provider; on a strong model |
| user$p50/p95/max | all AI spend per person that day (every task, `budgets user/all/day`) |
| target | median step ≤ `ops_chat_step_median_target_usd` |

and the same steps / $ / p50 / p95 / users per `users.profile` (family_beta, regular, work).
Tokens per context layer are **not recorded** (the assembler only estimates them), so there is no
per-layer split; if needed later, store the estimate with the reply.

**«Median chat step in target»**: the spec estimates a step at $0.0007–0.003 (5.10 «Стоимость»);
the target is the upper edge, **$0.003** (`OPS_CHAT_STEP_MEDIAN_TARGET_USD`). The cassette golden
run reports a synthetic median (fixed tokens, ~$0.0004 on the light model's price); the real
number is known only from production rows or a live golden run.

## Alerts

```bash
python -m assistant.ai.costs alerts            # check, store, send
python -m assistant.ai.costs alerts --no-send  # check and store only
```

Run it every few minutes (cron / systemd timer). Rules:

| kind | when | dedup key (fires once per) |
|---|---|---|
| `fallback_in_use` | a task whose route starts with the primary is answered only by another provider for > `ai_fallback_alert_minutes` (10) and still is | provider + start minute |
| `provider_off` | `ai_provider_state` off (quota / 402) until manual reset; also the search embedder (DeepInfra) switched off: no balance / bad key / unreachable (written by the embed worker) | provider + time it went off; embedder: provider + reason + day |
| `family_daily` | a `family_beta` person spent > `budget_family_alert_daily_usd` ($0.50) today | user + day |
| `chat_steps` | > `ops_chat_steps_per_user_day` (60) chat steps today | user + day |
| `chat_step_cost` | a chat step > `ops_chat_step_alert_usd` ($0.05) today | user + day |
| `chat_median` | yesterday's median step over the target (≥ 20 steps) | day |

A known dedup key only bumps `hits` / `last_at`; new alerts are committed first, then sent through
`notify.Notifier` (Telegram) to `OPS_ALERT_CHAT_ID` with the bot token, or logged when it is not
set; then `sent_at` is set. A failed send is retried by the next run and changes nothing else.
Texts carry internal user ids and numbers only (spec 8: no personal data). `ops_alerts.user_id`
cascades with the account (`api/account_data.py`). The router's in-process warnings
(`ai/budget.py log_alert`) stay as they are.

Settings: `OPS_CHAT_STEPS_PER_USER_DAY=60`, `OPS_CHAT_STEP_ALERT_USD=0.05`,
`OPS_CHAT_STEP_MEDIAN_TARGET_USD=0.003`, `OPS_ALERT_CHAT_ID` (unset).

## Claude live (2026-11-16)

Checked on the device server with invented phrases, `claude-haiku-5-5`, Gemini as fallback:
streamed chat, read tools (search, list_page, aggregate), mutating tools with the replayed turn,
intent, reminder / tasks / expense parsing, enrichment, chat summary. `provider_usage` rows match
the price table (checked by hand: input + output + cache write / read).

Observed per call: chat step $0.00013–0.00075 (cache read ~3 100 tokens from the 2nd step on),
enrich $0.00012 (warm) / $0.0005 (cache write), intent $0.00006, tasks / expense / reminder parse
$0.00014–0.00022, chat summary $0.00016. About $0.01 for the whole live check.

Found and fixed live (anthropic adapter):
- structured outputs reject `maxItems`, `minLength`, `minimum`... (400): stripped for Anthropic
  only; the router still validates against the Pydantic model;
- at most 16 nullable / union parameters across the strict schemas of one request (400): the chat
  tool sets have 23–45, so tools with the fewest unions stay `strict`, the rest go non-strict
  (arguments are validated in code).

Latency: warm chat step 1–3.5 s. The first call with a new schema / tool set compiles its grammar
(7–20 s, cached 24 h), so with the 8 s chat deadline the first message of the day for a given tool
set falls back once (Gemini answers, the grammar is compiled anyway). Production `routes.yaml`
keeps 8 s; the device test keeps `AI_ROUTES_FILE=D:/a/routes-device.yaml` (25 s chat/answer) so the
founder sees Claude from the first message. A grammar pre-warm at worker start is the cleaner
fix (proposal, not done).
