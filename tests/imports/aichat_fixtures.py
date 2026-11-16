# ruff: noqa: E501  (verbatim Takeout HTML)
"""Synthetic AI-chat exports (ChatGPT, Claude, Gemini JSON and HTML). Invented content only."""

import io
import json
import zipfile
from typing import Any

T0 = 1_760_000_000.0  # 2025-10-09


def _node(nid: str, parent: str | None, children: list[str], role: str | None, text: Any,
          t: float, **extra: Any) -> dict:  # fmt: skip
    msg = None
    if role is not None:
        content = text if isinstance(text, dict) else {"content_type": "text", "parts": [text]}
        msg = {"id": nid, "author": {"role": role, "name": None, "metadata": {}},
               "create_time": t, "update_time": None, "content": content, "status":
               "finished_successfully", "end_turn": True, "weight": 1.0, "metadata": {},
               "recipient": "all", **extra}  # fmt: skip
    return {"id": nid, "message": msg, "parent": parent, "children": children}


def chatgpt_conversation(cid: str = "c-1", title: str = "Кафе в Стамбуле", t: float = T0) -> dict:
    """A tree with a regenerated answer (branch), a hidden system message, a tool call, a
    multimodal question with an image, reasoning and a citation marker."""
    m = {
        "root": _node("root", None, ["sys"], None, None, t),
        "sys": _node("sys", "root", ["u1"], "system", "", t,
                     metadata={"is_visually_hidden_from_conversation": True}),
        "u1": _node("u1", "sys", ["a1-old", "a1"], "user",
                    "Посоветуй кафе в Стамбуле с видом на Босфор", t + 1),
        "a1-old": _node("a1-old", "u1", [], "assistant", "Старый вариант ответа", t + 2),
        "a1": _node("a1", "u1", ["think"], "assistant",
                    "Попробуйте кафе «Чайка» citeturn0 у набережной.", t + 3),
        "think": _node("think", "a1", ["tool"], "assistant",
                       {"content_type": "thoughts", "thoughts": [{"summary": "думаю"}]}, t + 4),
        "tool": _node("tool", "think", ["u2"], "assistant",
                      {"content_type": "code", "text": "search('кафе')"}, t + 5,
                      recipient="browser"),
        "u2": _node("u2", "tool", ["a2"], "user", {"content_type": "multimodal_text", "parts": [
            {"content_type": "image_asset_pointer", "asset_pointer": "file-service://x"},
            "А это место на фото подходит?"]}, t + 6),
        "a2": _node("a2", "u2", [], "assistant", "Да, это тоже хороший вариант.", t + 7),
    }
    return {"title": title, "create_time": t, "update_time": t + 7, "mapping": m,
            "moderation_results": [], "current_node": "a2", "plugin_ids": None,
            "conversation_id": cid, "id": cid, "is_archived": False}  # fmt: skip


def chatgpt_simple(cid: str, title: str, q: str, a: str, t: float) -> dict:
    m = {"r": _node("r", None, ["u"], None, None, t),
         "u": _node("u", "r", ["a"], "user", q, t + 1),
         "a": _node("a", "u", [], "assistant", a, t + 2)}  # fmt: skip
    return {"title": title, "create_time": t, "update_time": t + 2, "mapping": m,
            "current_node": "a", "id": cid, "some_new_field": {"x": 1}}  # fmt: skip


def chatgpt_export() -> list[dict]:
    return [
        chatgpt_conversation(),
        chatgpt_simple("c-2", "Рецепт плова", "Как варить плов?", "Рис, морковь, зира.", T0 + 100),
        {"title": "Пустой", "create_time": T0, "mapping": {"r": _node("r", None, [], None, None,
                                                                      T0)}, "id": "c-3"},
        {"title": "Сломанный", "mapping": "не словарь", "id": "c-4"},
    ]


def claude_export() -> list[dict]:
    return [
        {"uuid": "11111111-aaaa", "name": "План поездки в Алматы",
         "created_at": "2025-10-01T08:00:00.000000Z", "updated_at": "2025-10-01T08:05:00Z",
         "account": {"uuid": "acc"}, "chat_messages": [
             {"uuid": "m1", "sender": "human", "text": "Что посмотреть в Алматы за два дня?",
              "content": [{"type": "text", "text": "Что посмотреть в Алматы за два дня?"}],
              "created_at": "2025-10-01T08:00:00Z", "attachments": [], "files": []},
             {"uuid": "m2", "sender": "assistant", "text": "",
              "content": [{"type": "thinking", "thinking": "скрытое"},
                          {"type": "text", "text": "Медеу, Кок-Тобе и Большое Алматинское озеро."},
                          {"type": "tool_use", "name": "x", "input": {}}],
              "created_at": "2025-10-01T08:01:00Z"},
             {"uuid": "m3", "sender": "human", "text": "А где поесть?",
              "attachments": [{"file_name": "menu.pdf", "extracted_content": "меню"}],
              "created_at": "2025-10-01T08:02:00Z"},
             {"uuid": "m4", "sender": "assistant", "text": "В кафе у Зелёного базара.",
              "created_at": "2025-10-01T08:03:00Z"},
         ]},
        {"uuid": "22222222-bbbb", "name": "", "created_at": "2025-09-01T10:00:00Z",
         "messages": [{"role": "user", "text": "Как будет «спасибо» по-казахски?"},
                      {"role": "assistant", "text": "Рахмет."}]},
        {"uuid": "33333333-cccc", "name": "Пусто", "created_at": "2025-09-02T10:00:00Z",
         "chat_messages": []},
    ]


def gemini_entry(prompt: str, answer_html: str, time: str, **extra: Any) -> dict:
    e = {"header": "Gemini Apps", "title": f"Prompted {prompt}", "time": time,
         "products": ["Gemini Apps"], "activityControls": ["Gemini Apps Activity"],
         "safeHtmlItem": [{"html": answer_html}]}  # fmt: skip
    e.update(extra)
    return e


def gemini_export() -> list[dict]:
    # newest first, as in Takeout; two sessions (10:00-10:05 and the next day)
    return [
        gemini_entry("А зимой там холодно?", "<p>Да, до &minus;10.</p>",
                     "2025-10-03T09:00:00.000Z"),
        gemini_entry("Сколько стоит билет на Медеу?", "<p>Около <b>2 000</b> тенге &amp; меньше "
                     "для детей.</p><ul><li>взрослый</li><li>детский</li></ul>",
                     "2025-10-02T10:05:00.000Z", attachedFiles=["photo.jpg"]),
        gemini_entry("Что такое Медеу?", "<p>Высокогорный каток.</p>", "2025-10-02T10:00:00.000Z"),
        {"header": "Gemini Apps", "title": "Used Gemini Apps", "time": "2025-10-02T09:00:00Z",
         "products": ["Gemini Apps"]},
        {"header": "Search", "title": "Searched for котики", "time": "2025-10-02T09:00:00Z",
         "products": ["Search"]},
    ]


GEMINI_HTML = """<html><head><style>.x{}</style></head><body><div class="mdl-grid">
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Как сварить бешбармак?<br>Oct 2, 2025, 3:00:00 PM GMT+05:00<br><p>Варить мясо три часа.</p><p>Тесто раскатать тонко.</p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Запрос: Сколько соли?<br>2 окт. 2025 г., 15:10:00 GMT+05:00<br><p>Две ложки.</p></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Search<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Searched for котики<br>Oct 2, 2025, 3:00:00 PM UTC<br></div>
</div></div>
</div></body></html>"""


def as_zip(files: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def chatgpt_zip() -> bytes:
    return as_zip({"conversations.json": json.dumps(chatgpt_export(), ensure_ascii=False),
                   "chat.html": "<html>var jsonData = []</html>", "user.json": "{}",
                   "file-abc.png": b"\x89PNG"})  # fmt: skip


def claude_zip() -> bytes:
    return as_zip({"conversations.json": json.dumps(claude_export()), "users.json": "[]",
                   "projects.json": "[]"})  # fmt: skip


def gemini_zip(html_too: bool = True) -> bytes:
    files: dict[str, bytes | str] = {
        "Takeout/My Activity/Gemini Apps/MyActivity.json": json.dumps(gemini_export()),
        "Takeout/My Activity/Search/MyActivity.json": json.dumps([{"title": "Searched"}]),
        "Takeout/archive_browser.html": "<html></html>",
    }
    if html_too:
        files["Takeout/My Activity/Gemini Apps/MyActivity.html"] = GEMINI_HTML
    return as_zip(files)
