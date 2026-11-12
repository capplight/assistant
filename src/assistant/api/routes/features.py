"""/v1/features: what the app shows for the beta (founder 2026-11-13, Ф-33...Ф-44). Contract:
docs/api/features.md.

Hidden, not deleted (Ф-33): every switch is a setting (`feature_*`, `today_*`, `pages_*` in
config), so a feature comes back without a new app build. No sign-in needed: the welcome screen
reads it before the account exists, and nothing here is personal.
"""

from fastapi import APIRouter, Response
from pydantic import BaseModel

from assistant.api.deps import Ctx
from assistant.onboarding import DEFAULT_TEMPLATES

router = APIRouter(prefix="/features", tags=["features"])


class TodayFeaturesOut(BaseModel):
    tips_days: int  # tips only while the account is younger (0 = always)
    tips_per_day: int
    proposals: bool
    tiles: bool


class PagesFeaturesOut(BaseModel):
    default: list[str]  # made on first launch, after «Сегодня» (POST /pages/batch path=skipped)
    first_use: list[str]  # made by the server on their first record (empty = off)


class FeaturesOut(BaseModel):
    statements_pdf: bool  # Ф-37
    receipt_qr: bool  # Ф-37
    board: bool  # Ф-38: «Доска» on «Заметки»
    assistant_views: bool  # Ф-39: the assistant changes page views
    page_settings_full: bool  # Ф-40: off = «Настроить» shows only name, icon, view
    telegram_login: bool  # Ф-43
    personal_mail: bool  # Ф-43
    setup_for_other: bool  # Ф-44
    consent_screen: str  # Ф-34: the `screen` the app sends with the consents
    today: TodayFeaturesOut  # Ф-42
    pages: PagesFeaturesOut  # Ф-35, Ф-36


@router.get("", response_model=FeaturesOut)
async def features(ctx: Ctx, response: Response) -> FeaturesOut:
    s = ctx.settings
    response.headers["Cache-Control"] = "private, max-age=300"
    return FeaturesOut(
        statements_pdf=s.feature_statements_pdf, receipt_qr=s.feature_receipt_qr,
        board=s.feature_board, assistant_views=s.feature_assistant_views,
        page_settings_full=s.feature_page_settings_full,
        telegram_login=s.feature_telegram_login, personal_mail=s.feature_personal_mail,
        setup_for_other=s.feature_setup_for_other, consent_screen="welcome",
        today=TodayFeaturesOut(tips_days=s.today_tips_days, tips_per_day=s.today_tips_per_day,
                               proposals=s.feature_today_proposals,
                               tiles=s.feature_today_tiles),
        pages=PagesFeaturesOut(default=["today", *DEFAULT_TEMPLATES],
                               first_use=list(s.pages_first_use_keys)
                               if s.pages_on_first_use else []),
    )  # fmt: skip
