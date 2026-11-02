"""Country helpers: single-timezone countries and names (for trip matching).

The places provider gives a country code but no timezone with our field mask, so the event
tz is derived from the country when the country has exactly one zone.
"""

from datetime import tzinfo
from zoneinfo import ZoneInfo

# ISO2 -> (IANA tz, or None when the country spans several zones; lowercase names for matching)
COUNTRIES: dict[str, tuple[str | None, tuple[str, ...]]] = {
    "KZ": ("Asia/Almaty", ("казахстан", "kazakhstan", "қазақстан")),
    "KG": ("Asia/Bishkek", ("кыргызстан", "киргизия", "kyrgyzstan")),
    "UZ": ("Asia/Tashkent", ("узбекистан", "uzbekistan")),
    "VN": ("Asia/Ho_Chi_Minh", ("вьетнам", "vietnam", "viet nam")),
    "TH": ("Asia/Bangkok", ("таиланд", "тайланд", "thailand")),
    "KH": ("Asia/Phnom_Penh", ("камбоджа", "cambodia")),
    "LA": ("Asia/Vientiane", ("лаос", "laos")),
    "MY": ("Asia/Kuala_Lumpur", ("малайзия", "malaysia")),
    "SG": ("Asia/Singapore", ("сингапур", "singapore")),
    "PH": ("Asia/Manila", ("филиппины", "philippines")),
    "CN": ("Asia/Shanghai", ("китай", "china")),
    "HK": ("Asia/Hong_Kong", ("гонконг", "hong kong")),
    "JP": ("Asia/Tokyo", ("япония", "japan")),
    "KR": ("Asia/Seoul", ("корея", "korea")),
    "IN": ("Asia/Kolkata", ("индия", "india", "гоа", "goa")),
    "LK": ("Asia/Colombo", ("шри-ланка", "шри ланка", "sri lanka")),
    "MV": ("Indian/Maldives", ("мальдивы", "maldives")),
    "NP": ("Asia/Kathmandu", ("непал", "nepal")),
    "AE": ("Asia/Dubai", ("оаэ", "эмираты", "дубай", "uae", "emirates", "dubai")),
    "QA": ("Asia/Qatar", ("катар", "qatar")),
    "OM": ("Asia/Muscat", ("оман", "oman")),
    "SA": ("Asia/Riyadh", ("саудовская аравия", "saudi arabia")),
    "TR": ("Europe/Istanbul", ("турция", "turkey", "türkiye")),
    "GE": ("Asia/Tbilisi", ("грузия", "georgia")),
    "AM": ("Asia/Yerevan", ("армения", "armenia")),
    "AZ": ("Asia/Baku", ("азербайджан", "azerbaijan")),
    "EG": ("Africa/Cairo", ("египет", "egypt")),
    "MA": ("Africa/Casablanca", ("марокко", "morocco")),
    "TN": ("Africa/Tunis", ("тунис", "tunisia")),
    "CY": ("Asia/Nicosia", ("кипр", "cyprus")),
    "GR": ("Europe/Athens", ("греция", "greece")),
    "IT": ("Europe/Rome", ("италия", "italy")),
    "FR": ("Europe/Paris", ("франция", "france")),
    "DE": ("Europe/Berlin", ("германия", "germany")),
    "AT": ("Europe/Vienna", ("австрия", "austria")),
    "CH": ("Europe/Zurich", ("швейцария", "switzerland")),
    "CZ": ("Europe/Prague", ("чехия", "czechia")),
    "HU": ("Europe/Budapest", ("венгрия", "hungary")),
    "PL": ("Europe/Warsaw", ("польша", "poland")),
    "NL": ("Europe/Amsterdam", ("нидерланды", "голландия", "netherlands")),
    "GB": ("Europe/London", ("великобритания", "англия", "united kingdom", "england")),
    "ME": ("Europe/Podgorica", ("черногория", "montenegro")),
    "RS": ("Europe/Belgrade", ("сербия", "serbia")),
    "HR": ("Europe/Zagreb", ("хорватия", "croatia")),
    "ES": ("Europe/Madrid", ("испания", "spain")),
    "PT": ("Europe/Lisbon", ("португалия", "portugal")),
    "ID": (None, ("индонезия", "бали", "indonesia", "bali")),
    "RU": (None, ("россия", "russia")),
    "US": (None, ("сша", "америка", "usa", "united states")),
}


def normalize_country(country: str | None) -> str | None:
    if not country:
        return None
    c = country.strip().upper()
    return c if len(c) == 2 and c.isalpha() else None


def tz_for_country(country: str | None) -> str | None:
    entry = COUNTRIES.get(normalize_country(country) or "")
    return entry[0] if entry else None


def country_names(country: str | None) -> tuple[str, ...]:
    entry = COUNTRIES.get(normalize_country(country) or "")
    return entry[1] if entry else ()


def load_zone(name: str | None) -> tzinfo | None:
    """ZoneInfo, or None when the name is unknown or the tz database is missing."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError, OSError):  # ZoneInfoNotFoundError is a KeyError
        return None
