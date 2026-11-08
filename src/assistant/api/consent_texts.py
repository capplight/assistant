"""Registry of consent texts the app shows (GET /v1/consents/text) and accepts (POST /v1/consents).

The server records a consent only for a (kind, version, locale) it knows, and only when the
client's text_hash equals sha256 of exactly this text: proof of what the person saw.
Placeholder wording: the final texts come from the lawyer (spec 3.2). A wording change is a
new version; old versions stay here so history keeps resolving.
"""

from dataclasses import dataclass

from assistant.api.security import sha256_hex
from assistant.db.models_v2 import ConsentKind

AI_PROVIDERS = ["Anthropic", "OpenAI", "Google", "Groq"]


@dataclass(frozen=True)
class ConsentText:
    kind: ConsentKind
    version: str
    locale: str
    text: str
    providers: tuple[str, ...] = ()

    @property
    def text_hash(self) -> str:
        return sha256_hex(self.text)


_V = "2026-11-v1"
_TEXTS: list[ConsentText] = [
    ConsentText(ConsentKind.PD_PROCESSING, f"pd-{_V}", "ru",
                "Я соглашаюсь на обработку моих записей и данных на серверах в Казахстане."),
    ConsentText(ConsentKind.PD_PROCESSING, f"pd-{_V}", "kk",
                "Жазбаларым мен деректерімнің Қазақстандағы серверлерде өңделуіне келісемін."),
    ConsentText(ConsentKind.AI_CROSS_BORDER, f"ai-{_V}", "ru",
                "Я соглашаюсь, что текст, записи голоса и фото передаются для распознавания и "
                "ответов сервисам: Anthropic, OpenAI, Google, Groq. Они не обучаются на ваших "
                "данных.", tuple(AI_PROVIDERS)),
    ConsentText(ConsentKind.AI_CROSS_BORDER, f"ai-{_V}", "kk",
                "Мәтін, дауыс жазбалары мен фотолар тану және жауап беру үшін мына сервистерге "
                "жіберілетініне келісемін: Anthropic, OpenAI, Google, Groq. Олар сіздің "
                "деректеріңізден үйренбейді.", tuple(AI_PROVIDERS)),
    ConsentText(ConsentKind.TERMS, f"terms-{_V}", "ru",
                "Я принимаю условия использования. Мне есть 18 лет."),
    ConsentText(ConsentKind.TERMS, f"terms-{_V}", "kk",
                "Пайдалану шарттарын қабылдаймын. Маған 18 жас толды."),
    ConsentText(ConsentKind.PUSH_CONTENT, f"push-{_V}", "ru",
                "Текст напоминаний можно показывать в уведомлениях через Apple и Google."),
    ConsentText(ConsentKind.PUSH_CONTENT, f"push-{_V}", "kk",
                "Еске салғыштардың мәтінін Apple және Google арқылы хабарландыруда көрсетуге "
                "болады."),
    ConsentText(ConsentKind.ANALYTICS, f"analytics-{_V}", "ru",
                "Можно записывать, какие кнопки я нажимаю, без содержания записей."),
    ConsentText(ConsentKind.ANALYTICS, f"analytics-{_V}", "kk",
                "Жазбалардың мазмұнынсыз, қай батырмаларды басатынымды жазуға болады."),
    # Week 10 (spec 3.2 `telegram_import`, screen `import`). Placeholder wording, like the others;
    # the KK line awaits a native speaker's review (R-39).
    ConsentText(ConsentKind.TELEGRAM_IMPORT, f"tg-import-{_V}", "ru",
                "Я переношу в приложение текст из моего «Избранного» в Telegram (файл экспорта). "
                "Файл не хранится: остаётся только текст записей."),
    ConsentText(ConsentKind.TELEGRAM_IMPORT, f"tg-import-{_V}", "kk",
                "Telegram-дағы «Таңдаулыларымнан» мәтінді қолданбаға көшіремін (экспорт файлы). "
                "Файл сақталмайды: тек жазбалар мәтіні қалады."),
]  # fmt: skip

_BY_KEY = {(t.kind, t.version, t.locale): t for t in _TEXTS}


def find(kind: ConsentKind, version: str, locale: str) -> ConsentText | None:
    return _BY_KEY.get((kind, version, locale))


def current(kind: ConsentKind, locale: str) -> ConsentText | None:
    """Latest version of a kind in a locale (the last one registered)."""
    found = [t for t in _TEXTS if t.kind == kind and t.locale == locale]
    return found[-1] if found else None
