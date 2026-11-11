"""/v1/onboarding, /v1/pages/batch, /v1/pages/{id}/today-tile: first launch (spec 3.11, 4.10,
6.14; F-19, US-14, US-23, US-33; Ф-24) and «Сегодня» tiles (Ф-32). Contract:
docs/api/onboarding.md.

The person picks the pages (founder): the server only ticks suggestions by code
(`assistant.onboarding.suggested_pages`), and `POST /pages/batch` makes exactly the pages sent,
as one action with «Отменить». No model is called anywhere here.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from assistant.actions import actions_dicts, engine, record
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.pages import (
    _bring_back,
    _get,
    _live_singleton,
    _removed_singleton,
    page_out,
)
from assistant.api.schemas import ActionOut, PageOut, PageWithActionOut
from assistant.db.models import User
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_pages import MAX_PAGES, Screen, ScreenCreatedBy, ScreenKind
from assistant.onboarding import DEFAULT_TEMPLATES, MAX_MARKED, suggested_pages
from assistant.pages import create_page, fill_page, latest_template, lock_user

router = APIRouter(prefix="/onboarding", tags=["onboarding"])
pages_router = APIRouter(prefix="/pages", tags=["pages"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
CATALOG_KEYS = ("custom", "notes", "tasks", "shopping", "documents", "expenses")
CREATED_BY = {"gallery": ScreenCreatedBy.ONBOARDING_GALLERY,
              "blank": ScreenCreatedBy.ONBOARDING_BLANK,
              "phrase_first": ScreenCreatedBy.ONBOARDING_PHRASE,
              "skipped": ScreenCreatedBy.ONBOARDING_SKIPPED,
              "catalog": ScreenCreatedBy.USER}  # fmt: skip
TILE_MODES = ("auto", "pinned", "hidden")


def _now() -> datetime:
    return datetime.now(UTC)


class OnboardingOut(BaseModel):
    default_path: str
    paths_enabled: list[str]
    path: str | None
    done_at: datetime | None
    welcome_seen_at: datetime | None
    default_templates: list[str]
    max_marked: int


class OnboardingPatchIn(BaseModel):
    welcome_seen: bool | None = None


class SuggestedIn(BaseModel):
    phrase: str | None = Field(default=None, max_length=2000)
    intro_marks: list[str] = Field(default_factory=list, max_length=10)


class SuggestedOut(BaseModel):
    template_keys: list[str]
    reasons: dict[str, str]


class BatchIn(BaseModel):
    client_id: uuid.UUID
    path: Literal["gallery", "blank", "phrase_first", "skipped", "catalog"]
    template_keys: list[str] = Field(default_factory=list, max_length=6)
    title: str | None = Field(default=None, min_length=1, max_length=60)


class ExistingOut(BaseModel):
    template_key: str
    page_id: uuid.UUID


class BatchOut(BaseModel):
    pages: list[PageOut]
    existing: list[ExistingOut]
    action: ActionOut | None
    repeated: bool
    onboarding: OnboardingOut


class TileIn(BaseModel):
    mode: Literal["auto", "pinned", "hidden"]
    client_id: uuid.UUID | None = None


def onboarding_out(ctx: Ctx, u: User) -> OnboardingOut:
    s = ctx.settings
    enabled = [p for p in s.onboarding_paths_enabled if p in ("gallery", "blank", "phrase_first")]
    default = s.onboarding_default_path if s.onboarding_default_path in enabled else (
        enabled[0] if enabled else "phrase_first")  # fmt: skip
    return OnboardingOut(default_path=default, paths_enabled=enabled, path=u.onboarding_path,
                         done_at=u.onboarding_done_at, welcome_seen_at=u.welcome_seen_at,
                         default_templates=list(DEFAULT_TEMPLATES),
                         max_marked=MAX_MARKED)  # fmt: skip


async def _user(db: Db, user_id: int) -> User:
    u = await db.get(User, user_id)
    if u is None:
        raise ApiError(401, "unauthorized")
    return u


@router.get("", response_model=OnboardingOut)
async def get_onboarding(user: GatedUser, db: Db, ctx: Ctx) -> OnboardingOut:
    return onboarding_out(ctx, await _user(db, user.id))


@router.patch("", response_model=OnboardingOut)
async def patch_onboarding(body: OnboardingPatchIn, user: GatedUser, db: Db,
                           ctx: Ctx) -> OnboardingOut:  # fmt: skip
    u = await _user(db, user.id)
    if body.welcome_seen and u.welcome_seen_at is None:
        u.welcome_seen_at = _now()
    return onboarding_out(ctx, u)


@router.post("/suggested-pages", response_model=SuggestedOut)
async def suggested(body: SuggestedIn, user: GatedUser) -> SuggestedOut:
    """Code only; the phrase is read here and dropped (never stored, never logged)."""
    keys, reasons = suggested_pages(body.phrase, body.intro_marks)
    return SuggestedOut(template_keys=keys, reasons=reasons)


def _keys(body: BatchIn, ctx: Ctx) -> list[str]:
    if body.path not in ("skipped", "catalog") and \
            body.path not in ctx.settings.onboarding_paths_enabled:  # fmt: skip
        raise ApiError(422, "validation_error", details={"reason": "path_disabled"})
    if body.path == "blank":
        return ["custom"]
    if body.path == "skipped":
        return list(DEFAULT_TEMPLATES)
    keys = [k.strip() for k in body.template_keys]
    if not keys or len(set(keys)) != len(keys):
        raise ApiError(422, "validation_error", details={"reason": "template_keys"})
    for k in keys:
        if k not in CATALOG_KEYS:
            raise ApiError(422, "template_unknown")
    return keys


def _page_client_id(batch: uuid.UUID, n: int, key: str) -> uuid.UUID:
    return uuid.uuid5(batch, f"{n}:{key}")


def _sentence(pages: list[Screen]) -> str:
    if len(pages) == 1:
        return f"Добавил страницу «{pages[0].title}»"
    n = len(pages)
    word = "страницы" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "страниц"
    return f"Добавил {n} {word}"


@pages_router.post("/batch", response_model=BatchOut, status_code=201)
async def batch(body: BatchIn, user: GatedUser, db: Db, ctx: Ctx,
                response: Response) -> BatchOut:  # fmt: skip
    keys = _keys(body, ctx)
    now = _now()
    await lock_user(db, user.id)
    u = await _user(db, user.id)
    first = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                 Action.client_id == body.client_id))
    if first is not None:  # a repeat: the first call's pages, no new action
        ids = [uuid.UUID(p) for p in (first.payload or {}).get("created_page_ids") or []]
        rows = {p.public_id: p for p in await db.scalars(select(Screen).where(
            Screen.user_id == user.id, Screen.public_id.in_(ids)))} if ids else {}
        response.status_code = 200
        return BatchOut(pages=[page_out(rows[i]) for i in ids if i in rows], existing=[],
                        action=ActionOut.model_validate(
                            (await actions_dicts(db, [first], now))[0]),
                        repeated=True, onboarding=onboarding_out(ctx, u))  # fmt: skip
    templates = {}
    for k in keys:
        t = await latest_template(db, k)
        if t is None:
            raise ApiError(422, "template_unknown")
        templates[k] = t
    existing: list[ExistingOut] = []
    plan: list[tuple[int, str, Screen | None]] = []  # (n, key, removed page to bring back)
    for n, k in enumerate(keys):
        t = templates[k]
        if t.singleton:
            live = await _live_singleton(db, user.id, k)
            if live is not None:
                existing.append(ExistingOut(template_key=k, page_id=live.public_id))
                continue
            plan.append((n, k, await _removed_singleton(db, user.id, k)))
        else:
            mine = await db.scalar(select(Screen).where(
                Screen.user_id == user.id,
                Screen.client_id == _page_client_id(body.client_id, n, k)))  # fmt: skip
            if mine is not None:  # the same call, retried after a lost answer
                existing.append(ExistingOut(template_key=k, page_id=mine.public_id))
                continue
            plan.append((n, k, None))
    live_count = await db.scalar(select(func.count()).select_from(Screen).where(
        Screen.user_id == user.id, Screen.deleted_at.is_(None))) or 0  # fmt: skip
    if live_count + len(plan) > MAX_PAGES:
        raise ApiError(422, "pages_limit")
    made: list[Screen] = []
    for n, k, removed in plan:
        cid = _page_client_id(body.client_id, n, k)
        if removed is not None:
            removed.client_id = cid
            await _bring_back(db, removed)
            made.append(removed)
            continue
        title = (body.title or "").strip() or None if k == "custom" else None
        page = await create_page(db, user.id, templates[k], client_id=cid, title=title,
                                 created_by=CREATED_BY[body.path])  # fmt: skip
        await fill_page(db, page)
        made.append(page)
    if body.path != "catalog" and u.onboarding_path is None:
        u.onboarding_path = "skipped" if body.path == "skipped" else body.path
        u.onboarding_done_at = now
    action_out = None
    if made:
        sentence = _sentence(made)
        action = await record(
            db, user_id=user.id, kind=ActionKind.CREATE_SCREEN, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[{"item_id": None, "title": p.title, "kind": "create_page",
                      "page_id": str(p.public_id), "text": f"Новая страница «{p.title}»"}
                     for p in made],
            inverse=[{"op": "delete_entity_soft", "entity": "screens", "id": str(p.public_id)}
                     for p in made],
            now=now, screen_id=made[0].id, client_id=body.client_id,
            extra={"created_page_ids": [str(p.public_id) for p in made], "path": body.path},
        )  # fmt: skip
        await db.flush()
        action_out = ActionOut.model_validate((await actions_dicts(db, [action], now))[0])
    else:
        response.status_code = 200
    for p in made:
        await db.refresh(p)
    return BatchOut(pages=[page_out(p) for p in made], existing=existing, action=action_out,
                    repeated=False, onboarding=onboarding_out(ctx, u))  # fmt: skip


_TILE_SENTENCE = {"pinned": "Показываю «{t}» на Сегодня", "hidden": "Не показываю «{t}» на Сегодня",
                  "auto": "Плитка «{t}» — как обычно"}  # fmt: skip


@pages_router.put("/{page_id}/today-tile", response_model=PageWithActionOut)
async def today_tile(page_id: uuid.UUID, body: TileIn, user: GatedUser,
                     db: Db) -> PageWithActionOut:  # fmt: skip
    """«Показывать на Сегодня / Не показывать» (Ф-32): `view_state.today_tile`, with «Отменить»."""
    now = _now()
    await lock_user(db, user.id)
    page = await _get(db, user, page_id)
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise ApiError(403, "page_system")
    if body.client_id is not None:
        first = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                     Action.client_id == body.client_id))
        if first is not None:
            return PageWithActionOut(**page_out(page).model_dump(), action=ActionOut.model_validate(
                (await actions_dicts(db, [first], now))[0]))  # fmt: skip
    view: dict[str, Any] = dict(page.view_state or {})
    if (view.get("today_tile") or "auto") == body.mode:
        return PageWithActionOut(**page_out(page).model_dump(), action=None)
    if body.mode == "auto":
        view.pop("today_tile", None)
    else:
        view["today_tile"] = body.mode
    out = await engine.apply(db, user.id, [{"op": "restore_view_state",
                                            "page": str(page.public_id), "view_state": view}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    sentence = _TILE_SENTENCE[body.mode].format(t=page.title)
    action = await record(db, user_id=user.id, kind=ActionKind.SCREEN_CUSTOMIZE,
                          initiated_by=Initiator.USER, summary={"ru": sentence, "kk": None},
                          changes=[{"item_id": None, "title": page.title, "kind": "view",
                                    "page_id": str(page.public_id), "text": sentence}],
                          inverse=out.inverse, now=now, screen_id=page.id,
                          client_id=body.client_id)  # fmt: skip
    await db.flush()
    await db.refresh(page)
    return PageWithActionOut(**page_out(page).model_dump(), action=ActionOut.model_validate(
        (await actions_dicts(db, [action], now))[0]))  # fmt: skip
