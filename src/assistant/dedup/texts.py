"""Russian words for repeats, stacks and the import summary. Short, friendly, no jargon (CLAUDE.md:
«Повторы», never «дубли»)."""

RECORDS = ("запись", "записи", "записей")
REPEATS = ("повтор", "повтора", "повторов")
MESSAGES = ("сообщение", "сообщения", "сообщений")
GROUPS = ("группа", "группы", "групп")


def plural(n: int, forms: tuple[str, str, str]) -> str:
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        word = forms[0]
    elif 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        word = forms[1]
    else:
        word = forms[2]
    return f"{n} {word}"


def quote(title: str | None, limit: int = 40) -> str:
    t = " ".join((title or "").split()) or "Без названия"
    return f"«{t if len(t) <= limit else t[:limit - 1] + '…'}»"


def merged_sentence(n_records: int) -> str:
    return f"Объединил {plural(n_records, RECORDS)} в одну"


def merged_groups_sentence(groups: int, hidden: int) -> str:
    return f"Объединил повторы: {plural(groups, GROUPS)}, убрал {plural(hidden, REPEATS)}"


def dismissed_sentence(n_records: int) -> str:
    return f"Оставил {plural(n_records, RECORDS)} отдельно — это разные"


def cleanup_sentence(copies: int) -> str:
    return f"Убрал {plural(copies, REPEATS)}"


def cleanup_preview(copies: int, before: int, after: int, groups: int) -> dict:
    return {
        "title_ru": f"Убрать {plural(copies, REPEATS)}?",
        "text_ru": (f"Одинаковых записей: {before}. Оставлю по одной — станет {after}. "
                    "Отменить можно в «Что я сделал»."),
        "copies": copies, "records_before": before, "records_after": after, "groups": groups,
    }  # fmt: skip


MEDIA_RU = {
    "video": "видео", "photo": "фото", "voice": "голосовые", "audio": "аудио",
    "sticker": "стикеры", "animation": "гифки", "video_message": "кружки", "file": "файлы",
    "poll": "опросы", "location": "места на карте", "contact": "контакты", "other": "другое",
}


def import_summary(created: int, dups: int, media: dict[str, int], failed: int = 0) -> str:
    """«Принёс 640, 212 повторов убрал, видео (34) не перенёс — только подписи» (spec 4.9)."""
    parts = [f"Принёс {plural(created, RECORDS)}"]
    if dups:
        parts.append(f"{plural(dups, REPEATS)} убрал")
    lost = [f"{MEDIA_RU.get(k, k)} ({v})" for k, v in sorted(media.items(), key=lambda kv: -kv[1])
            if v]  # fmt: skip
    if lost:
        parts.append(", ".join(lost) + " не перенёс — только подписи")
    if failed:
        parts.append(f"{plural(failed, MESSAGES)} не прочитал")
    return ", ".join(parts) + "."
