"""Pages: template catalogue, screens, screen_items (spec 3-engineering 3.9 `0008_pages`, 3.10).

A page is a view on the shared memory, not a folder (R-46): `screen_items` links items to pages,
many to many. Enums are text + CHECK. Changes:

- `screen_templates`: catalogue as data, one immutable row per (key, version), seeded with v1
  (6 gallery templates + system `today`). Holds `auto_rule` (which items land on the page).
- `screens`: the user's pages. At most one `system_today` per user (partial unique), it can't be
  deleted or hidden (CHECK); a trigger on `users` creates it, so every account always has one.
- `screen_items`: position is a LexoRank key, `text COLLATE "C"`. `manual_order` is what the
  "human over AI" rule reads (R-54). `removed_by_user_at` keeps the row as a marker that the agent
  must not put the item back. Additive to the spec: `public_id` (tombstones need a UUID) and
  `user_id` (the sync trigger and lock need it).
- Both tables use `sync_seq_bump()`; a hard delete writes a tombstone (`screen`, `screen_item`).
- Backfill per spec 3.9: every existing user gets «Сегодня», «Заметки» (all their records) and
  «Дела и напоминания» (records whose envelope is a task or a reminder request; legacy `reminders`
  have no link to items). Positions by `occurred_at`, newest first, `manual_order=false`.

Not here, because their tables or features come later: `item_facets`, `screen_summaries`
(week 4+), `collections.screen_id`, new `actions.kind` / `user_habits.kind`.

Frozen SQL, no create_all. Key generation is copied here on purpose: this file must not change
when the app's code does.

Revision ID: 0007
Revises: 0006
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_LAYOUTS = ("'list', 'checklist', 'table', 'stacks', 'builtin:today', 'builtin:tasks', "
            "'builtin:kp', 'builtin:expenses'")  # fmt: skip
_ICONS = ("'people', 'documents', 'shopping', 'money', 'health', 'home', 'work', 'other', "
          "'today', 'tasks'")  # fmt: skip
_KEY = r"'^[0-9A-Za-z]*[1-9A-Za-z]$'"

TABLES = f"""
CREATE TABLE screen_templates (
	key TEXT NOT NULL,
	version INTEGER NOT NULL,
	owner TEXT DEFAULT 'system' NOT NULL,
	status TEXT DEFAULT 'published' NOT NULL,
	catalog_visible BOOLEAN DEFAULT true NOT NULL,
	catalog_order INTEGER DEFAULT 0 NOT NULL,
	title JSONB NOT NULL,
	description JSONB DEFAULT '{{}}' NOT NULL,
	default_title JSONB NOT NULL,
	icon TEXT NOT NULL,
	preview_ref TEXT,
	singleton BOOLEAN NOT NULL,
	facet TEXT NOT NULL,
	fields JSONB NOT NULL,
	layouts JSONB NOT NULL,
	default_layout TEXT NOT NULL,
	default_view JSONB DEFAULT '{{}}' NOT NULL,
	aggregates JSONB DEFAULT '[]' NOT NULL,
	auto_rule JSONB NOT NULL,
	ai_hints_ref TEXT,
	min_app_version TEXT,
	migrate_from INTEGER,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (key, version),
	CONSTRAINT ck_screen_templates_key CHECK (key ~ '^[a-z_]+$'),
	CONSTRAINT ck_screen_templates_version CHECK (version >= 1),
	CONSTRAINT ck_screen_templates_owner CHECK (owner IN ('system', 'user', 'agent')),
	CONSTRAINT ck_screen_templates_status CHECK (status IN ('draft', 'published', 'deprecated')),
	CONSTRAINT ck_screen_templates_facet CHECK (
		facet IN ('none', 'note', 'task', 'shopping', 'document', 'expense', 'custom')),
	CONSTRAINT ck_screen_templates_icon CHECK (icon IN ({_ICONS})),
	CONSTRAINT ck_screen_templates_default_layout CHECK (default_layout IN ({_LAYOUTS})),
	CONSTRAINT ck_screen_templates_fields CHECK (jsonb_typeof(fields) = 'array'),
	CONSTRAINT ck_screen_templates_layouts CHECK (jsonb_typeof(layouts) = 'array'),
	CONSTRAINT ck_screen_templates_auto_rule CHECK (jsonb_typeof(auto_rule) = 'object')
);

CREATE TABLE screens (
	id BIGSERIAL NOT NULL,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	kind TEXT DEFAULT 'page' NOT NULL,
	template_key TEXT NOT NULL,
	template_version INTEGER NOT NULL,
	singleton BOOLEAN NOT NULL,
	title TEXT NOT NULL,
	title_kk TEXT,
	icon TEXT NOT NULL,
	position TEXT COLLATE "C" NOT NULL,
	layout TEXT NOT NULL,
	view_state JSONB DEFAULT '{{}}' NOT NULL,
	field_prefs JSONB DEFAULT '[]' NOT NULL,
	custom_fields JSONB DEFAULT '[]' NOT NULL,
	customized BOOLEAN DEFAULT false NOT NULL,
	view_version INTEGER DEFAULT 1 NOT NULL,
	rule JSONB,
	created_by TEXT DEFAULT 'user' NOT NULL,
	action_id BIGINT,
	hidden_at TIMESTAMP WITH TIME ZONE,
	last_opened_at TIMESTAMP WITH TIME ZONE,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	PRIMARY KEY (id),
	CONSTRAINT uq_screens_public_id UNIQUE (public_id),
	CONSTRAINT uq_screens_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_screens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_screens_template FOREIGN KEY (template_key, template_version)
		REFERENCES screen_templates (key, version),
	CONSTRAINT ck_screens_kind CHECK (kind IN ('system_today', 'page')),
	CONSTRAINT ck_screens_kind_template CHECK ((kind = 'system_today') = (template_key = 'today')),
	CONSTRAINT ck_screens_today_permanent CHECK (
		kind <> 'system_today' OR (deleted_at IS NULL AND hidden_at IS NULL)),
	CONSTRAINT ck_screens_title CHECK (char_length(title) BETWEEN 1 AND 60),
	CONSTRAINT ck_screens_icon CHECK (icon IN ({_ICONS})),
	CONSTRAINT ck_screens_layout CHECK (layout IN ({_LAYOUTS})),
	CONSTRAINT ck_screens_position CHECK (position ~ {_KEY} AND char_length(position) <= 128),
	CONSTRAINT ck_screens_view_state CHECK (jsonb_typeof(view_state) = 'object'),
	CONSTRAINT ck_screens_field_prefs CHECK (jsonb_typeof(field_prefs) = 'array'),
	CONSTRAINT ck_screens_custom_fields CHECK (
		jsonb_typeof(custom_fields) = 'array' AND jsonb_array_length(custom_fields) <= 5),
	CONSTRAINT ck_screens_created_by CHECK (created_by IN (
		'system', 'onboarding_gallery', 'onboarding_blank', 'onboarding_phrase', 'user', 'agent'))
);

CREATE UNIQUE INDEX uq_screens_one_today ON screens (user_id) WHERE kind = 'system_today';

CREATE UNIQUE INDEX uq_screens_singleton ON screens (user_id, template_key)
	WHERE singleton AND deleted_at IS NULL;

CREATE INDEX ix_screens_user_seq ON screens (user_id, seq);

CREATE INDEX ix_screens_user_position ON screens (user_id, position);

CREATE TABLE screen_items (
	screen_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	position TEXT COLLATE "C",
	group_key TEXT,
	manual_order BOOLEAN DEFAULT false NOT NULL,
	manual_at TIMESTAMP WITH TIME ZONE,
	pinned BOOLEAN DEFAULT false NOT NULL,
	added_by TEXT DEFAULT 'rule' NOT NULL,
	removed_by_user_at TIMESTAMP WITH TIME ZONE,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_by TEXT DEFAULT 'agent' NOT NULL,
	PRIMARY KEY (screen_id, item_id),
	CONSTRAINT uq_screen_items_public_id UNIQUE (public_id),
	CONSTRAINT fk_screen_items_screen FOREIGN KEY (screen_id)
		REFERENCES screens (id) ON DELETE CASCADE,
	CONSTRAINT fk_screen_items_item FOREIGN KEY (item_id)
		REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_screen_items_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_screen_items_position CHECK (
		position ~ {_KEY} AND char_length(position) <= 128),
	CONSTRAINT ck_screen_items_added_by CHECK (added_by IN ('rule', 'agent', 'user')),
	CONSTRAINT ck_screen_items_updated_by CHECK (updated_by IN ('user', 'agent')),
	CONSTRAINT ck_screen_items_manual CHECK (NOT manual_order OR manual_at IS NOT NULL)
);

CREATE INDEX ix_screen_items_order ON screen_items (screen_id, group_key, position);

CREATE INDEX ix_screen_items_screen_position ON screen_items (screen_id, position);

CREATE INDEX ix_screen_items_item ON screen_items (item_id);

CREATE INDEX ix_screen_items_user_seq ON screen_items (user_id, seq);

ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity;

ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ('item', 'screen', 'screen_item'))
"""

# One statement per execute(): asyncpg prepares each one and rejects batches.
FUNCTIONS = [
    """
CREATE TRIGGER screens_sync_seq BEFORE INSERT OR UPDATE ON screens
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TRIGGER screen_items_sync_seq BEFORE INSERT OR UPDATE ON screen_items
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE FUNCTION sync_tombstone_row() RETURNS trigger AS $$
BEGIN
  PERFORM sync_lock_user(OLD.user_id);
  INSERT INTO sync_tombstones (user_id, entity, public_id, seq)
  VALUES (OLD.user_id, TG_ARGV[0], OLD.public_id, nextval('sync_seq'));
  RETURN OLD;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER screens_sync_tombstone AFTER DELETE ON screens
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('screen')
""",
    """
CREATE TRIGGER screen_items_sync_tombstone AFTER DELETE ON screen_items
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('screen_item')
""",
    """
CREATE FUNCTION create_today_screen() RETURNS trigger AS $$
BEGIN
  INSERT INTO screens (user_id, kind, template_key, template_version, singleton, title, title_kk,
                       icon, position, layout, view_state, created_by)
  SELECT NEW.id, 'system_today', t.key, t.version, t.singleton, t.default_title ->> 'ru',
         t.default_title ->> 'kk', t.icon, '1', t.default_layout, t.default_view, 'system'
  FROM screen_templates t
  WHERE t.key = 'today' AND t.status = 'published'
  ORDER BY t.version DESC
  LIMIT 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER users_today_screen AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION create_today_screen()
""",
]


def _f(field_id: str, ru: str, type_: str, source: str, *, required: bool = False,
       visible: bool = True, options: list[str] | None = None) -> dict:  # fmt: skip
    field: dict = {"id": field_id, "title": {"ru": ru, "kk": None}, "type": type_,
                   "required": required, "default_visible": visible, "source": source}  # fmt: skip
    if options:
        field["options"] = options
    return field


NEVER: dict = {"any": []}
SORT_POSITION = {"sort": "position"}

TEMPLATES: list[dict] = [
    {
        "key": "today", "catalog_visible": False, "catalog_order": 0,
        "title": {"ru": "Сегодня", "kk": "Бүгін"},
        "default_title": {"ru": "Сегодня", "kk": "Бүгін"},
        "description": {"ru": "Что важно сегодня", "kk": None},
        "icon": "today", "singleton": True, "facet": "none", "fields": [],
        "layouts": ["builtin:today"], "default_layout": "builtin:today",
        "auto_rule": NEVER,
    },
    {
        "key": "custom", "catalog_visible": True, "catalog_order": 1,
        "title": {"ru": "Своя страница", "kk": "Жеке бет"},
        "default_title": {"ru": "Моя страница", "kk": None},
        "description": {"ru": "Пустая — назовёте сами", "kk": None},
        "icon": "other", "singleton": False, "facet": "custom",
        "fields": [
            _f("title", "Заголовок", "text", "item.title", required=True),
            _f("text", "Текст", "long_text", "item.text"),
            _f("date", "Дата", "date", "item.occurred_at"),
        ],
        "layouts": ["list", "checklist", "table"], "default_layout": "list",
        "auto_rule": NEVER,
    },
    {
        "key": "notes", "catalog_visible": True, "catalog_order": 2,
        "title": {"ru": "Заметки", "kk": "Жазбалар"},
        "default_title": {"ru": "Заметки", "kk": "Жазбалар"},
        "description": {"ru": "Разложу и уберу повторы", "kk": None},
        "icon": "documents", "singleton": True, "facet": "note",
        "fields": [
            _f("text", "Текст", "long_text", "item.text", required=True),
            _f("title", "Заголовок", "text", "item.title"),
            _f("topics", "Темы", "tags", "envelope.topics"),
            _f("date", "Дата", "date", "item.occurred_at"),
            _f("source", "Источник", "text", "item.source"),
        ],
        "layouts": ["stacks", "list"], "default_layout": "stacks",
        "auto_rule": {"any": [{"always": True}]},
    },
    {
        "key": "tasks", "catalog_visible": True, "catalog_order": 3,
        "title": {"ru": "Дела и напоминания", "kk": "Істер мен еске салғыштар"},
        "default_title": {"ru": "Дела и напоминания", "kk": "Істер мен еске салғыштар"},
        "description": {"ru": "Напомню вовремя", "kk": None},
        "icon": "tasks", "singleton": True, "facet": "task",
        "fields": [
            _f("what", "Что", "text", "task.title", required=True),
            _f("when", "Когда", "datetime", "task.due_at", required=True),
            _f("repeat", "Повтор", "text", "task.repeat"),
            _f("remind_how", "Как напомнить", "enum", "task.level",
               options=["alarm", "notification"]),
            _f("done", "Сделано", "bool", "task.done", required=True),
        ],
        "layouts": ["builtin:tasks"], "default_layout": "builtin:tasks",
        "auto_rule": {"any": [{"envelope_types": ["task", "reminder_request"]},
                              {"aspects": ["reminder", "task"]}]},
    },
    {
        "key": "shopping", "catalog_visible": True, "catalog_order": 4,
        "title": {"ru": "Покупки", "kk": "Сатып алулар"},
        "default_title": {"ru": "Покупки", "kk": "Сатып алулар"},
        "description": {"ru": "Список всегда под рукой", "kk": None},
        "icon": "shopping", "singleton": True, "facet": "shopping",
        "fields": [
            _f("what", "Что", "text", "facet.what", required=True),
            _f("qty", "Сколько", "text", "facet.qty"),
            _f("bought", "Куплено", "bool", "facet.bought", required=True),
            _f("where", "Где купить", "text", "facet.where"),
        ],
        "layouts": ["checklist", "list"], "default_layout": "checklist",
        "auto_rule": {"any": [{"envelope_types": ["shopping_list"]}]},
    },
    {
        "key": "documents", "catalog_visible": True, "catalog_order": 5,
        "title": {"ru": "Документы и КП", "kk": "Құжаттар мен КҰ"},
        "default_title": {"ru": "Документы и КП", "kk": "Құжаттар мен КҰ"},
        "description": {"ru": "Договоры, чеки, новое КП", "kk": None},
        "icon": "work", "singleton": True, "facet": "document",
        "fields": [
            _f("name", "Название", "text", "item.title", required=True),
            _f("doc_type", "Тип", "enum", "document.type",
               options=["kp", "contract", "receipt", "other"]),
            _f("client", "Клиент", "person", "document.client"),
            _f("amount", "Сумма", "money", "document.total"),
            _f("date", "Дата", "date", "item.occurred_at"),
            _f("kp_status", "Статус КП", "enum", "document.status",
               options=["draft", "sent", "accepted", "declined"]),
        ],
        "layouts": ["builtin:kp", "list"], "default_layout": "builtin:kp",
        "auto_rule": {"any": [{"kinds": ["pdf", "docx", "xlsx", "kp", "document"]},
                              {"envelope_types": ["document", "receipt", "contract", "id_document",
                                                  "kp_request", "price_list"]}]},
    },
    {
        "key": "expenses", "catalog_visible": True, "catalog_order": 6,
        "title": {"ru": "Расходы", "kk": "Шығындар"},
        "default_title": {"ru": "Расходы", "kk": "Шығындар"},
        "description": {"ru": "Итог месяца и по категориям", "kk": None},
        "icon": "money", "singleton": True, "facet": "expense",
        "fields": [
            _f("amount", "Сумма", "money", "expense.amount", required=True),
            _f("date", "Дата", "date", "expense.spent_on", required=True),
            _f("category", "Категория", "text", "expense.category"),
            _f("merchant", "На что / где", "text", "expense.merchant"),
            _f("method", "Способ", "text", "expense.method"),
            _f("receipt", "Чек", "link", "expense.receipt"),
        ],
        "layouts": ["builtin:expenses"], "default_layout": "builtin:expenses",
        "aggregates": [{"id": "month_total", "fn": "sum", "field": "amount",
                        "group_by": ["currency"], "period": "month"}],
        "auto_rule": {"any": [{"envelope_types": ["receipt"]}]},
    },
]  # fmt: skip

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _keys(n: int) -> list[str]:
    """`n` evenly spaced base-62 keys (a frozen copy of lexorank.sequence)."""
    width = 1
    while 62**width < (n + 1) * 62:
        width += 1
    step = 62**width // (n + 1)
    out = []
    for i in range(1, n + 1):
        value, digits = i * step, []
        for _ in range(width):
            value, d = divmod(value, 62)
            digits.append(_ALPHABET[d])
        out.append("".join(reversed(digits)).rstrip("0"))
    return out


def _seed(conn: sa.Connection) -> None:
    stmt = sa.text("""
INSERT INTO screen_templates (key, version, catalog_visible, catalog_order, title, description,
    default_title, icon, preview_ref, singleton, facet, fields, layouts, default_layout,
    default_view, aggregates, auto_rule)
VALUES (:key, 1, :catalog_visible, :catalog_order, CAST(:title AS JSONB),
    CAST(:description AS JSONB), CAST(:default_title AS JSONB), :icon, :preview_ref, :singleton,
    :facet, CAST(:fields AS JSONB), CAST(:layouts AS JSONB), :default_layout,
    CAST(:default_view AS JSONB), CAST(:aggregates AS JSONB), CAST(:auto_rule AS JSONB))
""")
    for t in TEMPLATES:
        dumped = {k: json.dumps(t.get(k, []), ensure_ascii=False)
                  for k in ("title", "description", "default_title", "fields", "layouts",
                            "aggregates", "auto_rule")}  # fmt: skip
        conn.execute(stmt, {
            **dumped,
            "key": t["key"],
            "catalog_visible": t["catalog_visible"],
            "catalog_order": t["catalog_order"],
            "icon": t["icon"],
            "preview_ref": f"{t['key']}.v1",
            "singleton": t["singleton"],
            "facet": t["facet"],
            "default_layout": t["default_layout"],
            "default_view": json.dumps(SORT_POSITION),
        })  # fmt: skip


def _backfill(conn: sa.Connection) -> None:
    """Existing users only: the trigger on `users` covers everyone created from now on."""
    conn.execute(sa.text("""
INSERT INTO screens (user_id, kind, template_key, template_version, singleton, title, title_kk,
                     icon, position, layout, view_state, created_by)
SELECT u.id, 'system_today', t.key, t.version, t.singleton, t.default_title ->> 'ru',
       t.default_title ->> 'kk', t.icon, '1', t.default_layout, t.default_view, 'system'
FROM users u CROSS JOIN screen_templates t
WHERE t.key = 'today' AND t.version = 1
"""))
    pages = conn.execute(sa.text("""
INSERT INTO screens (user_id, template_key, template_version, singleton, title, title_kk, icon,
                     position, layout, view_state, created_by)
SELECT u.id, t.key, t.version, t.singleton, t.default_title ->> 'ru', t.default_title ->> 'kk',
       t.icon, CASE t.key WHEN 'notes' THEN '2' ELSE '3' END, t.default_layout, t.default_view,
       'system'
FROM users u CROSS JOIN screen_templates t
WHERE t.key IN ('notes', 'tasks') AND t.version = 1
RETURNING id, user_id, template_key
""")).all()
    only_tasks = "AND i.envelope ->> 'type' IN ('task', 'reminder_request')"
    insert = sa.text("""
INSERT INTO screen_items (screen_id, item_id, user_id, position)
VALUES (:screen_id, :item_id, :user_id, :position)
""")
    for page in pages:
        where = only_tasks if page.template_key == "tasks" else ""
        ids = conn.execute(
            sa.text(f"""
SELECT i.id FROM items i WHERE i.user_id = :uid {where}
ORDER BY coalesce(i.occurred_at, i.created_at) DESC, i.id DESC
"""),
            {"uid": page.user_id},
        ).scalars().all()  # fmt: skip
        if ids:
            conn.execute(insert, [
                {"screen_id": page.id, "item_id": item_id, "user_id": page.user_id, "position": key}
                for item_id, key in zip(ids, _keys(len(ids)), strict=True)
            ])  # fmt: skip


def upgrade() -> None:
    for stmt in TABLES.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))
    for stmt in FUNCTIONS:
        op.execute(stmt)
    conn = op.get_bind()
    _seed(conn)
    _backfill(conn)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS users_today_screen ON users")
    op.execute("DROP FUNCTION IF EXISTS create_today_screen")
    op.execute("DROP TABLE IF EXISTS screen_items")
    op.execute("DROP TABLE IF EXISTS screens")
    op.execute("DROP TABLE IF EXISTS screen_templates")
    op.execute("DROP FUNCTION IF EXISTS sync_tombstone_row")
    op.execute("DELETE FROM sync_tombstones WHERE entity <> 'item'")
    op.execute("ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity")
    op.execute(
        "ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity "
        "CHECK (entity IN ('item'))"
    )
