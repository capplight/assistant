"""Mobile REST API (/v1): auth, consents, devices, uploads. Entry: `python -m assistant.api`.

Public surface for other modules: `create_app`, and the consent gate dependencies
(`require_ai_consent`, `require_base_consent`) every AI/STT endpoint must use, and
`storage_from_settings` (the object store the ingest worker reads originals from).
"""

from assistant.api.app import create_app, storage_from_settings
from assistant.api.consent_gate import ConsentRequired, require_ai_consent, require_base_consent

__all__ = ["ConsentRequired", "create_app", "require_ai_consent", "require_base_consent",
           "storage_from_settings"]
