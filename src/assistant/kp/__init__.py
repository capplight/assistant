"""КП engine (week 14; spec 3.6, 4.7, 6.7; F-13, F-14, F-34; R-27, R-29, R-30). Contract:
docs/api/kp.md. Every number of a КП is code's; the model gives data and picks price references.

Public surface:
- `calc` (pure): lines, totals, VAT modes, `CALC_VERSION`; `vat`: the dated rate config (Ф-18);
  `words`: the sum in words RU / KK.
- `norm`: names (`name_norm`), units, numbers written in a text.
- `profile`: «Моя компания» (checked numbers, PROFILE_EXTRACT draft, encrypted БИН / bank).
- `pricelist`: «Мой прайс» (table by code, PRICE_LIST_EXTRACT, «Ввести цены подряд»);
  `prices`: candidates, past КП, `price_source` captions.
- `extract`: KP_EXTRACT parts and code's checks; `jobs.run_extract` (job `kp:extract`, worker
  `python -m assistant.kp`).
- `service`: documents, versions, rows for sync and pages; `patch`: tap edits (JSON Patch).
- `render`: Jinja2 → WeasyPrint PDF (`WeasyPdfRenderer`, `FakePdfRenderer` for tests).
"""

from typing import Any

from assistant.kp import calc, extract, norm, patch, pricelist, prices, profile, vat, words

JOB_EXTRACT = "kp:extract"


def __getattr__(name: str) -> Any:
    # `jobs` writes actions, and the action engine imports this package's pure parts: lazy.
    if name == "run_extract":
        from assistant.kp.jobs import run_extract

        return run_extract
    raise AttributeError(name)

__all__ = ["JOB_EXTRACT", "calc", "extract", "norm", "patch", "pricelist", "prices", "profile",
           "run_extract", "vat", "words"]  # fmt: skip
