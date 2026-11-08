"""API error shape (spec 4): {code, message_ru, message_kk, retry_after?, details?}.

User-facing messages: short, friendly, never mention "AI/ИИ" (CLAUDE.md).
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

_MESSAGES: dict[str, tuple[str, str]] = {
    "unauthorized": ("Войдите снова.", "Қайта кіріңіз."),
    "invalid_refresh": ("Войдите снова.", "Қайта кіріңіз."),
    "account_blocked": ("Аккаунт удаляется. Вход закрыт.", "Аккаунт жойылуда. Кіру жабық."),
    "consent_required": (
        "Чтобы продолжить, примите условия на экране согласия.",
        "Жалғастыру үшін келісім экранында шарттарды қабылдаңыз.",
    ),
    "consent_unknown_version": (
        "Обновите приложение и примите условия снова.",
        "Қолданбаны жаңартып, шарттарды қайта қабылдаңыз.",
    ),
    "age_confirmation_required": (
        "Подтвердите, что вам есть 18 лет.",
        "18 жасқа толғаныңызды растаңыз.",
    ),
    "phone_unsupported": (
        "Нужен номер Казахстана (+7) или Кыргызстана (+996).",
        "Қазақстан (+7) немесе Қырғызстан (+996) нөмірі керек.",
    ),
    "otp_rate_limited": ("Слишком много кодов. Попробуйте позже.",
                         "Код тым көп. Кейінірек көріңіз."),
    "otp_invalid": ("Код не подошёл.", "Код сәйкес келмеді."),
    "otp_expired": ("Код устарел. Запросите новый.", "Кодтың мерзімі өтті. Жаңасын сұраңыз."),
    "sms_failed": ("Не получилось отправить SMS. Попробуйте ещё раз.",
                   "SMS жіберілмеді. Қайталаңыз."),
    "upload_too_large": ("Файл больше 50 МБ.", "Файл 50 МБ-тан үлкен."),
    "upload_not_found": ("Файл не найден.", "Файл табылмады."),
    "upload_mismatch": ("Файл загрузился не полностью. Попробуйте ещё раз.",
                        "Файл толық жүктелмеді. Қайталаңыз."),
    "upload_expired": ("Ссылка для загрузки устарела.", "Жүктеу сілтемесінің мерзімі өтті."),
    "upload_not_ready": ("Файл ещё загружается. Попробуйте чуть позже.",
                         "Файл әлі жүктелуде. Сәлден соң көріңіз."),
    "upload_in_use": ("Этот файл уже сохранён в другой записи.",
                      "Бұл файл басқа жазбада сақталған."),
    "item_kind_mismatch": ("Не получилось сохранить: тип записи не подходит.",
                           "Сақталмады: жазба түрі сәйкес емес."),
    "item_deleted": ("Запись в удалённых. Сначала восстановите её.",
                     "Жазба жойылғандарда. Алдымен оны қалпына келтіріңіз."),
    "pin_disabled": ("Сохранять оригиналы пока нельзя.",
                     "Түпнұсқаларды сақтау әзірге мүмкін емес."),
    "original_purged": ("Оригинал уже удалён, текст остался.",
                        "Түпнұсқа жойылған, мәтін сақталды."),
    "original_system": ("Этот файл хранится всегда.", "Бұл файл әрқашан сақталады."),
    "singleton_exists": ("Такая страница уже есть.", "Мұндай бет бар."),
    "pages_limit": ("Можно до 20 страниц. Уберите ненужную в «Мои страницы».",
                    "20 бетке дейін болады. Керек еместі «Менің беттерім» ішінен алып тастаңыз."),
    "template_unknown": ("Такой страницы пока нет. Обновите приложение.",
                         "Мұндай бет әзірге жоқ. Қолданбаны жаңартыңыз."),
    "layout_not_allowed": ("Этой странице такой вид не подходит.",
                           "Бұл бетке мұндай көрініс келмейді."),
    "page_system": ("Страницу «Сегодня» нельзя менять или убирать.",
                    "«Бүгін» бетін өзгертуге немесе алып тастауға болмайды."),
    "conflict": ("Запись уже изменилась. Обновите и попробуйте снова.",
                 "Жазба өзгеріп кеткен. Жаңартып, қайталаңыз."),
    "review_field_unknown": ("Запись уже изменилась. Обновите и попробуйте снова.",
                             "Жазба өзгеріп кеткен. Жаңартып, қайталаңыз."),
    "review_field_not_editable": ("Это место правится в тексте записи.",
                                  "Бұл орын жазба мәтінінде түзетіледі."),
    "not_found": ("Не найдено.", "Табылмады."),
    "reminder_in_past": ("Это время уже прошло. Выберите другое.",
                         "Бұл уақыт өтіп кетті. Басқасын таңдаңыз."),
    "device_unknown": ("Не узнали этот телефон. Откройте приложение заново.",
                       "Бұл телефон танылмады. Қолданбаны қайта ашыңыз."),
    "undo_expired": ("Это уже не отменить.", "Это уже не отменить."),
    "validation_error": ("Проверьте данные.", "Деректерді тексеріңіз."),
    "internal": ("Что-то пошло не так. Попробуйте ещё раз.", "Бірдеңе дұрыс болмады. Қайталаңыз."),
}  # fmt: skip


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        *,
        retry_after: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.retry_after = retry_after
        self.details = details


def error_body(code: str, *, retry_after: int | None = None,
               details: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    ru, kk = _MESSAGES.get(code, _MESSAGES["internal"])
    body: dict[str, Any] = {"code": code, "message_ru": ru, "message_kk": kk}
    if retry_after is not None:
        body["retry_after"] = retry_after
    if details:
        body["details"] = details
    return body


def _response(status: int, body: dict[str, Any], retry_after: int | None = None) -> JSONResponse:
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    return JSONResponse(body, status_code=status, headers=headers)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        body = error_body(exc.code, retry_after=exc.retry_after, details=exc.details)
        return _response(exc.status, body, exc.retry_after)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Only locations and types, never the submitted values (may contain personal data).
        errors = [{"loc": list(e.get("loc", ())), "type": e.get("type")} for e in exc.errors()]
        return _response(422, error_body("validation_error", details={"errors": errors}))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "unauthorized", 404: "not_found"}.get(exc.status_code, "internal")
        return _response(exc.status_code, error_body(code))
