"""W-01: the web page to delete an account (Google Play «Account deletion» requirement; spec 4.9,
2-design W-01; contract docs/api/account.md). Plain server-rendered HTML, no scripts, RU / KK.

Phone → SMS code → «Удалить аккаунт и все данные» → the same request as from the app
(`via: web`). The page never tells whether a number has an account: with or without one it shows
the code form (an SMS goes only when there is an account). A hidden field catches simple bots;
code requests are limited per IP (`web_delete_ip_per_hour`) besides the usual per-number limit.
The KK text is ours and waits for the native review (R-39), like the rest of the app's KK.
"""

import html
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select

from assistant.api import auth_service as svc
from assistant.api.deps import Ctx, Db, client_ip_hash
from assistant.api.errors import ApiError
from assistant.api.routes.account import (
    confirm_code,
    deletion_points,
    pending_message,
    send_code,
    start_deletion,
)
from assistant.db.models import User
from assistant.db.models_account import DeletionVia
from assistant.db.models_v2 import AuthProvider, OtpChallenge, OtpPurpose, UserStatus

router = APIRouter(prefix="/account/delete", include_in_schema=False)
MAX_FORM = 4096

T: dict[str, dict[str, str]] = {
    "ru": {
        "title": "Удалить аккаунт и все данные",
        "intro": "Здесь можно удалить аккаунт приложения-помощника и все ваши данные: записи, "
                 "страницы, траты, КП, Переписку, напоминания и файлы.",
        "what": "Что будет:",
        "anon": "Если вы не указывали номер, удалить можно только в приложении: Настройки → "
                "Удалить аккаунт.",
        "phone": "Номер телефона, который вы указали в приложении",
        "get_code": "Получить SMS-код",
        "sent": "Если этот номер есть в приложении, мы прислали SMS с кодом.",
        "code": "Код из SMS",
        "delete": "Удалить аккаунт и все данные",
        "again": "Указать другой номер",
        "done": "Запрос принят. Вход закрыт.",
        "already": "Этот аккаунт уже удаляется.",
        "bad_phone": "Нужен номер Казахстана (+7) или Кыргызстана (+996).",
        "bad_code": "Код не подошёл. Проверьте и попробуйте ещё раз.",
        "old_code": "Код устарел. Запросите новый.",
        "limited": "Слишком много попыток. Попробуйте через час.",
        "sms_failed": "Не получилось отправить SMS. Попробуйте ещё раз.",
        "lang": "Қазақша", "lang_code": "kk",
    },
    "kk": {
        "title": "Аккаунтты және барлық деректерді жою",
        "intro": "Мұнда көмекші қолданбасының аккаунтын және барлық деректеріңізді жоюға болады: "
                 "жазбалар, беттер, шығындар, КҰ, Хат алмасу, еске салғыштар және файлдар.",
        "what": "Не болады:",
        "anon": "Егер нөмір көрсетпеген болсаңыз, тек қолданбада жоюға болады: Баптаулар → "
                "Аккаунтты жою.",
        "phone": "Қолданбада көрсеткен телефон нөміріңіз",
        "get_code": "SMS-код алу",
        "sent": "Бұл нөмір қолданбада болса, біз SMS-код жібердік.",
        "code": "SMS-тегі код",
        "delete": "Аккаунтты және барлық деректерді жою",
        "again": "Басқа нөмір көрсету",
        "done": "Сұраныс қабылданды. Кіру жабық.",
        "already": "Бұл аккаунт жойылуда.",
        "bad_phone": "Қазақстан (+7) немесе Қырғызстан (+996) нөмірі керек.",
        "bad_code": "Код сәйкес келмеді. Тексеріп, қайталаңыз.",
        "old_code": "Кодтың мерзімі өтті. Жаңасын сұраңыз.",
        "limited": "Әрекет тым көп. Бір сағаттан кейін көріңіз.",
        "sms_failed": "SMS жіберілмеді. Қайталаңыз.",
        "lang": "Русский", "lang_code": "ru",
    },
}
POINTS_KK = {
    True: ["Кіру бірден жабылады.", "{days} күн ішінде ойыңызды өзгертуге болады — SMS арқылы "
           "кіріңіз.", "Содан кейін бәрін бір тәулікте жоямын.",
           "Резервтік серверлердегі көшірмелер 30 күннен кешіктірмей жойылады.",
           "Қолдау қызметі арқылы қайтару мүмкін емес."],
    False: ["Кіру бірден жабылады.", "Бәрін бір тәулікте жоямын. Болдырмау мүмкін емес.",
            "Резервтік серверлердегі көшірмелер 30 күннен кешіктірмей жойылады.",
            "Қолдау қызметі арқылы қайтару мүмкін емес."],
}  # fmt: skip
STYLE = """
:root{color-scheme:light dark;--bg:#faf8f4;--ink:#1d1b18;--ink2:#5b564e;--line:#d9d3c7;
--alarm:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--ink:#f1ede6;--ink2:#b5aea3;
--line:#3a3732;--alarm:#f2b8b5;--card:#211f1c}}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:26px;line-height:1.25;margin:0 0 12px}
p,li{color:var(--ink)}.meta{color:var(--ink2);font-size:16px}
ul{padding-left:20px}label{display:block;margin:16px 0 6px;font-weight:600}
input[type=tel],input[type=text]{width:100%;box-sizing:border-box;font-size:20px;padding:12px;
border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}
button{margin-top:16px;width:100%;min-height:56px;font-size:18px;font-weight:600;border:0;
border-radius:14px;background:var(--alarm);color:#fff;cursor:pointer}
.err{color:var(--alarm);font-weight:600}.hp{position:absolute;left:-10000px}
a{color:inherit}.top{display:flex;justify-content:flex-end}
"""


def _lang(value: str | None) -> str:
    return "kk" if value == "kk" else "ru"


def _points(lang: str, grace: int) -> list[str]:
    if lang == "kk":
        lines = POINTS_KK[grace > 0]
        return [line.format(days=grace) for line in lines]
    return deletion_points(grace, phone=True)


def _page(lang: str, body: str, status: int = 200) -> HTMLResponse:
    t = T[lang]
    doc = (f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
           '<meta name="viewport" content="width=device-width,initial-scale=1">'
           '<meta name="robots" content="noindex">'
           f"<title>{html.escape(t['title'])}</title><style>{STYLE}</style></head><body><main>"
           f'<div class="top"><a href="/account/delete?lang={t["lang_code"]}">'
           f"{html.escape(t['lang'])}</a></div><h1>{html.escape(t['title'])}</h1>{body}"
           "</main></body></html>")  # fmt: skip
    return HTMLResponse(doc, status_code=status, headers={
        "Cache-Control": "no-store", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; "
                                   "form-action 'self'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer"})  # fmt: skip


def _phone_form(lang: str, grace: int, error: str | None = None, phone: str = "") -> str:
    t = T[lang]
    points = "".join(f"<li>{html.escape(p)}</li>" for p in _points(lang, grace))
    err = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return (f"<p>{html.escape(t['intro'])}</p><p><b>{html.escape(t['what'])}</b></p>"
            f"<ul>{points}</ul><p class=\"meta\">{html.escape(t['anon'])}</p>{err}"
            '<form method="post" action="/account/delete/otp">'
            f'<input type="hidden" name="lang" value="{lang}">'
            f'<label for="phone">{html.escape(t["phone"])}</label>'
            f'<input id="phone" name="phone" type="tel" autocomplete="tel" required '
            f'placeholder="+7 701 123 45 67" value="{html.escape(phone)}">'
            '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">'
            f'<button type="submit">{html.escape(t["get_code"])}</button></form>')  # fmt: skip


def _code_form(lang: str, grace: int, phone: str, challenge: uuid.UUID,
               error: str | None = None) -> str:  # fmt: skip
    t = T[lang]
    points = "".join(f"<li>{html.escape(p)}</li>" for p in _points(lang, grace))
    err = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return (f"<p>{html.escape(t['sent'])}</p><p><b>{html.escape(t['what'])}</b></p>"
            f"<ul>{points}</ul>{err}"
            '<form method="post" action="/account/delete/confirm">'
            f'<input type="hidden" name="lang" value="{lang}">'
            f'<input type="hidden" name="phone" value="{html.escape(phone)}">'
            f'<input type="hidden" name="challenge_id" value="{challenge}">'
            f'<label for="code">{html.escape(t["code"])}</label>'
            '<input id="code" name="code" type="text" inputmode="numeric" '
            'autocomplete="one-time-code" maxlength="8" required>'
            f'<button type="submit">{html.escape(t["delete"])}</button></form>'
            f'<p><a href="/account/delete?lang={lang}">'
            f'{html.escape(t["again"])}</a></p>')  # fmt: skip


async def _form(request: Request) -> dict[str, str]:
    raw = await request.body()
    if len(raw) > MAX_FORM:
        return {}
    data = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
    return {k: v[0].strip() for k, v in data.items() if v}


@router.get("", response_class=HTMLResponse)
async def page(ctx: Ctx, lang: str | None = None) -> HTMLResponse:
    lg = _lang(lang)
    return _page(lg, _phone_form(lg, ctx.settings.account_delete_grace_days))


async def _ip_limited(db: Db, ip_hash: str | None, per_hour: int) -> bool:
    if ip_hash is None:
        return False
    n = await db.scalar(select(func.count()).select_from(OtpChallenge).where(
        OtpChallenge.ip_hash == ip_hash, OtpChallenge.purpose == OtpPurpose.WEB_DELETE,
        OtpChallenge.created_at > datetime.now(UTC) - timedelta(hours=1)))  # fmt: skip
    return (n or 0) >= per_hour


@router.post("/otp", response_class=HTMLResponse)
async def otp(request: Request, db: Db, ctx: Ctx) -> HTMLResponse:
    form = await _form(request)
    lg, grace = _lang(form.get("lang")), ctx.settings.account_delete_grace_days
    t, phone = T[lg], form.get("phone", "")[:20]
    if form.get("website"):  # the hidden field: a bot filled it
        return _page(lg, _phone_form(lg, grace), 400)
    ip = client_ip_hash(request, ctx)
    if await _ip_limited(db, ip, ctx.settings.web_delete_ip_per_hour):
        return _page(lg, _phone_form(lg, grace, t["limited"], phone), 429)
    try:
        from assistant.api.phone import normalize_phone

        e164 = normalize_phone(phone).e164
    except Exception:
        return _page(lg, _phone_form(lg, grace, t["bad_phone"], phone), 422)
    owner = await svc.find_identity_user(db, AuthProvider.PHONE,
                                         ctx.hash(e164, purpose="phone"))  # fmt: skip
    try:
        out = await send_code(db, ctx, phone, purpose=OtpPurpose.WEB_DELETE,
                              user_id=owner.id if owner is not None else None,
                              device_id=None, ip_hash=ip)  # fmt: skip
    except ApiError as exc:
        msg = {"otp_rate_limited": t["limited"], "sms_failed": t["sms_failed"]}.get(
            exc.code, t["bad_phone"])  # fmt: skip
        return _page(lg, _phone_form(lg, grace, msg, phone), exc.status)
    return _page(lg, _code_form(lg, grace, phone, out.challenge_id))


@router.post("/confirm", response_class=HTMLResponse)
async def confirm(request: Request, db: Db, ctx: Ctx) -> HTMLResponse:
    form = await _form(request)
    lg, grace = _lang(form.get("lang")), ctx.settings.account_delete_grace_days
    t, phone = T[lg], form.get("phone", "")[:20]
    try:
        challenge_id = uuid.UUID(form.get("challenge_id", ""))
    except ValueError:
        return _page(lg, _phone_form(lg, grace, t["old_code"], phone), 400)
    code = form.get("code", "")[:8]
    try:
        challenge = await confirm_code(db, ctx, challenge_id, code, purpose=OtpPurpose.WEB_DELETE)
    except ApiError as exc:
        if exc.code == "otp_invalid":
            return _page(lg, _code_form(lg, grace, phone, challenge_id, t["bad_code"]), 400)
        return _page(lg, _phone_form(lg, grace, t["old_code"], phone), 400)
    owner = await svc.find_identity_user(db, AuthProvider.PHONE, challenge.phone_hash)
    if owner is None or challenge.user_id != owner.id:
        # no account behind this number: the code could not have come (no SMS was sent)
        return _page(lg, _code_form(lg, grace, phone, challenge_id, t["bad_code"]), 400)
    row = await db.get(User, owner.id, with_for_update=True)
    assert row is not None
    if row.status != UserStatus.ACTIVE:
        msg = t["already"]
        if row.status == UserStatus.DELETION_PENDING and row.delete_after is not None:
            msg += " " + _until(lg, row, grace)
        return _page(lg, f"<p>{html.escape(msg)}</p>")
    out = await start_deletion(db, ctx, row, via=DeletionVia.WEB, phone=True)
    return _page(lg, f"<p><b>{html.escape(t['done'])}</b></p>"
                     f"<p>{html.escape(_until(lg, row, grace, out.delete_after))}</p>")  # fmt: skip


def _until(lang: str, row: User, grace: int, when: datetime | None = None) -> str:
    when = when or row.delete_after
    assert when is not None
    if lang == "kk":
        if grace <= 0:
            return "Бәрін бір тәулікте жоямын."
        day = when.astimezone(ZoneInfo(row.tz or "Asia/Almaty")).strftime("%d.%m.%Y")
        return f"{day} дейін ойыңызды өзгертуге болады: қолданбаға нөмір арқылы кіріңіз."

    msg = pending_message(when, row.tz, phone=True, grace_days=grace)
    return msg.replace("Аккаунт удаляется. ", "").replace("войдите по SMS",
                                                         "войдите в приложение по номеру")
