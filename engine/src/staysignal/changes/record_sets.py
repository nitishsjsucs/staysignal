"""Record sets for the five-factor change decomposition (SPEC 12).

Between a previous run P (cutoff s0, vintage v0, model m0, definition d0) and a current run Q (s1, v1, m1, d1):
  base         every record known at v0 (so "all factors off" is exactly P's inputs);
  Composition  records recorded in (v0, v1] effective in [s0, s1]: joiners, leavers and moves as time passes;
  Input data   records recorded in (v0, v1] effective before s0: late data about the past (late records, corrections);
  Calendar     the clock and window move from s0 to s1 (season and aging), with no new events;
  Model        artifact m0 or m1;  Definition  metric definition d0 or d1 (population scope only).
Population, assignment and pay are taken at A = s1 when Composition is on (else s0); clocks and look-back windows at
s1 when Calendar is on (else s0). With every factor off this reproduces P, with every factor on Q.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime

from staysignal.ingest.landing import Sources

FACTORS = ("calendar", "composition", "input_data", "model", "definition")
LABELS = {
    "calendar": "Calendar (season and aging)",
    "composition": "Composition (joiners, leavers, moves)",
    "input_data": "Input data (late data about the past)",
    "model": "Model (retrain)",
    "definition": "Definition (metric scope)",
}


def _eff(item: object) -> date:
    for attr in ("effective_date", "valid_from", "event_date", "decision_date"):
        if hasattr(item, attr):
            return getattr(item, attr)
    if hasattr(item, "period_start"):
        # A payroll line describes pay at the close of its period: it takes effect on the first day after the period,
        # so the regular monthly file is Composition (time passing), not a restatement of the past.
        ps = item.period_start  # type: ignore[attr-defined]
        return date(ps.year + (ps.month == 12), ps.month % 12 + 1, 1)
    raise TypeError(f"no effective date on {type(item).__name__}")


@dataclass
class Split:
    base: Sources
    composition: Sources
    input_data: Sources


def _empty_like(src: Sources) -> Sources:
    return Sources(bands=src.bands)


def split(src: Sources, v0: datetime, v1: datetime, s0: date, s1: date) -> Split:
    out = Split(_empty_like(src), _empty_like(src), _empty_like(src))
    for field in ("hris", "payroll", "teams", "org_events", "reqs", "offers"):
        for item in getattr(src, field):
            rec = item.recorded_at
            if rec <= v0:
                getattr(out.base, field).append(item)
            elif rec <= v1:
                e = _eff(item)
                if e < s0:
                    getattr(out.input_data, field).append(item)
                elif e <= s1:
                    getattr(out.composition, field).append(item)
    return out


def combine(parts: list[Sources], bands) -> Sources:
    out = Sources(bands=bands)
    for p in parts:
        for field in ("hris", "payroll", "teams", "org_events", "reqs", "offers"):
            getattr(out, field).extend(getattr(p, field))
    return out


FAR_FUTURE = datetime(2100, 1, 1, tzinfo=UTC)
