"""Governed query shapes and the parameter contract of the semantic catalog (SPEC 7.3). Pattern from PeopleLens
`src/peoplelens/catalog/params.py` and `keys.py` (MIT), adapted for StaySignal.

A shape is (metric bundle, cohort level, grain). Every entry takes the same parameters, bound by the server, never by
a model:
  start_month, end_month    first of month, inclusive window over the month dimension (DATE on DuckDB, TIMESTAMP on
                            BigQuery, where MetricFlow's time dimensions are timestamps)
  f_organization            organizations to keep, ['__all__'] when unfiltered (the user's cohort)
  f_group_name              groups to keep, ['__all__'] when unfiltered
  scope_organizations       organizations the principal may read, ['__all__'] for company-wide roles (authorization)
Nothing in the catalog identifies a person; the smallest cell is a group-month with 10 or more people.
"""

from __future__ import annotations

from datetime import date

ALL = "__all__"

ENTITY = "group_month"
DIMENSIONS = {"organization": f"{ENTITY}__organization", "group_name": f"{ENTITY}__group_name"}
TIME_DIMENSION = "metric_time"

BUNDLES: dict[str, list[str]] = {
    "workforce_flows": [
        "headcount",
        "hires",
        "transfers_in",
        "restructured_in",
        "transfers_out",
        "restructured_out",
        "voluntary_departures",
        "involuntary_departures",
        "retirements",
    ],
}
LEVELS: dict[str, tuple[str, ...]] = {
    "company": (),
    "organization": ("organization",),
    "group": ("organization", "group_name"),
}
GRAINS = ("none", "month")
PARAMS = ("start_month", "end_month", "f_organization", "f_group_name", "scope_organizations")
TYPES = {"duckdb": {"date": "DATE", "array": "VARCHAR[]"}, "bigquery": {"date": "TIMESTAMP", "array": "ARRAY<STRING>"}}


def catalog_key(bundle: str, level: str, grain: str) -> str:
    """`bundle|level|grain`, for example `workforce_flows|organization|month`."""
    return f"{bundle}|{level}|{grain}"


def shapes() -> list[tuple[str, str, str]]:
    return [(b, lv, g) for b in BUNDLES for lv in LEVELS for g in GRAINS]


def time_name(grain: str) -> str | None:
    return None if grain == "none" else f"{TIME_DIMENSION}__{grain}"


def group_by_names(level: str, grain: str) -> list[str]:
    names = [DIMENSIONS[d] for d in LEVELS[level]]
    t = time_name(grain)
    return names + ([t] if t else [])


def param_contract(dialect: str) -> list[dict[str, str]]:
    types = TYPES[dialect]
    return [{"name": p, "type": types["date"] if p.endswith("_month") else types["array"]} for p in PARAMS]


def where_filters(dialect: str) -> list[str]:
    def p(name: str) -> str:
        return f"@{name}" if dialect == "bigquery" else f"${name}"

    def member(ref: str, name: str) -> str:
        if dialect == "bigquery":
            return f"('{ALL}' IN UNNEST({p(name)}) OR {ref} IN UNNEST({p(name)}))"
        return f"(list_contains({p(name)}, '{ALL}') OR list_contains({p(name)}, {ref}))"

    org = "{{ Dimension('" + DIMENSIONS["organization"] + "') }}"
    grp = "{{ Dimension('" + DIMENSIONS["group_name"] + "') }}"
    month = "{{ TimeDimension('" + TIME_DIMENSION + "', 'month') }}"
    return [
        member(org, "f_organization"),
        member(grp, "f_group_name"),
        member(org, "scope_organizations"),
        f"{month} BETWEEN {p('start_month')} AND {p('end_month')}",
    ]


def bind_values(
    start: date,
    end: date,
    organizations: list[str] | None = None,
    groups: list[str] | None = None,
    scope: list[str] | None = None,
) -> dict[str, object]:
    """Parameter values for one execution (the shim, the parity test and the fixture export)."""
    return {
        "start_month": start,
        "end_month": end,
        "f_organization": list(organizations or [ALL]),
        "f_group_name": list(groups or [ALL]),
        "scope_organizations": list(scope or [ALL]),
    }


__all__ = [
    "ALL",
    "BUNDLES",
    "DIMENSIONS",
    "GRAINS",
    "LEVELS",
    "PARAMS",
    "bind_values",
    "catalog_key",
    "group_by_names",
    "param_contract",
    "shapes",
    "time_name",
    "where_filters",
]
