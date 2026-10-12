"""Planted data problems (SPEC 6.5): corrections, duplicates, late and reclassified terminations, rescinded
terminations, the 2026-09-15 audit batch, and the payroll pay-basis defect. Exact counts per profile.

Every planted record is marked: `true=False` for records that never described reality (erroneous rows that a later
correction or rescission fixes). The truth is unchanged; only what the source system recorded, and when, changes.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

from staysignal.clock import batch_time
from staysignal.prng import stream
from staysignal.world.simulate import Record, World

AUDIT_BATCH_AT = datetime(2026, 9, 15, 6, 0, tzinfo=UTC)
AUDIT_WINDOW = (date(2026, 7, 1), date(2026, 9, 1))


class Planter:
    def __init__(self, world: World) -> None:
        self.w = world
        self.r = stream(world.profile.seed, "defects")
        self.used: set[str] = set()
        self.seq = max(int(r.record_id[1:]) for r in world.records)
        self.planted: dict[str, list[str]] = {}
        self.by_en: dict[str, list[Record]] = {}
        for rec in world.records:
            self.by_en.setdefault(rec.employee_number, []).append(rec)

    def new_id(self) -> str:
        self.seq += 1
        return f"H{self.seq:08d}"

    def note(self, kind: str, rec_id: str) -> None:
        self.planted.setdefault(kind, []).append(rec_id)

    def pick(self, candidates: list[Record], k: int, kind: str) -> list[Record]:
        pool = sorted((c for c in candidates if c.record_id not in self.used), key=lambda r: r.record_id)
        if len(pool) < k:
            raise ValueError(f"only {len(pool)} candidates for {k} planted {kind}")
        chosen = self.r.sample(pool, k)
        for c in chosen:
            self.used.add(c.record_id)
        return sorted(chosen, key=lambda r: r.record_id)

    def true_snapshot(self, en: str, d: date) -> Record | None:
        best = None
        for rec in self.by_en.get(en, []):
            eligible = rec.true and rec.record_type not in ("correction", "rescission") and rec.effective_date <= d
            if eligible and (
                best is None
                or (rec.effective_date, rec.recorded_at, rec.record_id)
                > (best.effective_date, best.recorded_at, best.record_id)
            ):
                best = rec
        return best

    def correction_of(self, original: Record, truth: Record, delay_days: int) -> Record:
        rec = replace(
            truth,
            record_id=self.new_id(),
            record_type="correction",
            corrects_record_id=original.record_id,
            recorded_at=original.recorded_at + timedelta(days=delay_days),
            true=True,
        )
        rec.legacy_hire_date = rec.legacy_first_promotion_date = rec.legacy_last_promotion_date = None
        self.w.records.append(rec)
        return rec

    def other_manager(self, original: Record) -> str:
        managers = sorted(
            {
                r.manager_employee_number
                for r in self.w.records
                if r.manager_employee_number
                and r.manager_employee_number not in (original.manager_employee_number, original.employee_number)
            }
        )
        return self.r.choice(managers)

    def run(self) -> dict[str, list[str]]:
        p = self.w.profile.planted
        if p is None:
            return {}
        recs = list(self.w.records)
        terms = [r for r in recs if r.record_type == "termination" and r.true]
        eng_teams = {t.id for t in self.w.teams.values() if t.org == "Engineering"}

        # Audit batch: late July and August terminations in Engineering, recorded 2026-09-15 (SPEC 6.5).
        lo, hi = AUDIT_WINDOW
        window = [t for t in terms if lo <= t.effective_date < hi and t.team_id in eng_teams]
        vol = [t for t in window if t.termination_reason_code == "VOL_RESIGN"]
        inv = [t for t in window if t.termination_reason_code not in ("VOL_RESIGN", "RETIRE")]
        # Composition knob (SPEC 6.5): 9 voluntary and 3 involuntary when the window has them; otherwise the shortfall in
        # one cause is filled from the other so the batch keeps its 12 terminations. The realized mix is in the manifest.
        n_inv = min(p.audit_batch_terminations - p.audit_batch_terminations_voluntary, len(inv))
        n_vol = min(p.audit_batch_terminations - n_inv, len(vol))
        for t in self.pick(vol, n_vol, "audit voluntary terminations") + self.pick(
            inv, n_inv, "audit involuntary terminations"
        ):
            t.recorded_at = AUDIT_BATCH_AT
            t.source_batch_id = "HRIS-AUDIT-2026-09-15"
            self.note("audit_batch_termination", t.record_id)
        mgr_window = [
            r
            for r in recs
            if r.record_type == "manager_change"
            and r.true
            and r.team_id in eng_teams
            and date(2026, 3, 15) <= r.effective_date < date(2026, 9, 1)
        ]
        for orig in self.pick(
            mgr_window, min(p.audit_batch_manager_corrections, len(mgr_window)), "audit manager corrections"
        ):
            truth = replace(orig)
            orig.manager_employee_number = self.other_manager(orig)
            orig.true = False
            corr = self.correction_of(orig, truth, 0)
            corr.recorded_at = AUDIT_BATCH_AT
            corr.source_batch_id = "HRIS-AUDIT-2026-09-15"
            self.note("audit_batch_manager_correction", corr.record_id)

        # Late terminations: recorded 30 to 75 days after the effective date.
        for t in self.pick(terms, p.late_terminations, "late terminations"):
            t.recorded_at = batch_time(t.effective_date + timedelta(days=30 + self.r.below(46)))
            self.note("late_termination", t.record_id)

        # Exit reason reclassified: voluntary and involuntary swapped, corrected 10 to 60 days later.
        swappable = [
            t for t in terms if t.termination_reason_code in ("VOL_RESIGN", "INVOL_PERFORMANCE", "INVOL_POSITION")
        ]
        for t in self.pick(swappable, p.reclassified_reasons, "reclassified reasons"):
            truth = replace(t)
            t.termination_reason_code = (
                "INVOL_PERFORMANCE" if t.termination_reason_code == "VOL_RESIGN" else "VOL_RESIGN"
            )
            t.true = False
            self.note("reclassified_reason", self.correction_of(t, truth, 10 + self.r.below(51)).record_id)

        # Manager changes recorded with the wrong manager, corrected to the right one 3 to 60 days later.
        mgr = [r for r in recs if r.record_type == "manager_change" and r.true]
        for orig in self.pick(mgr, p.manager_changes_to_other, "manager changes to another manager"):
            truth = replace(orig)
            orig.manager_employee_number = self.other_manager(orig)
            orig.true = False
            self.note("manager_change_to_other", self.correction_of(orig, truth, 3 + self.r.below(58)).record_id)

        # Erroneous manager changes, reverted by a correction 3 to 60 days later (net zero changes).
        start, end = self.w.profile.start, self.w.end
        people = sorted(self.w.people)
        for _ in range(p.manager_reverts):
            for _attempt in range(200):
                en = self.r.choice(people)
                d = start + timedelta(days=30 + self.r.below((end - start).days - 60))
                snap = self.true_snapshot(en, d)
                person = self.w.people[en]
                alive = any(s <= d and (e is None or e > d) for s, e, _, _ in person.spells)
                if snap is not None and alive and snap.record_type != "termination":
                    break
            else:
                raise ValueError("no candidate for an erroneous manager change")
            bad = replace(
                snap,
                record_id=self.new_id(),
                record_type="manager_change",
                effective_date=d,
                recorded_at=batch_time(d + timedelta(days=self.r.below(3))),
                true=False,
                corrects_record_id=None,
                termination_reason_code=None,
            )
            bad.legacy_hire_date = bad.legacy_first_promotion_date = bad.legacy_last_promotion_date = None
            bad.manager_employee_number = self.other_manager(snap)
            self.w.records.append(bad)
            truth = replace(snap, effective_date=d)
            self.note("manager_revert", self.correction_of(bad, truth, 3 + self.r.below(58)).record_id)

        # Value corrections: a wrong effective date, level or team, corrected 3 to 60 days later.
        values = [
            r
            for r in recs
            if r.true and r.record_type in ("promotion", "transfer", "team_change", "job_change", "hire")
        ]
        live_teams = sorted(t.id for t in self.w.teams.values())
        for orig in self.pick(values, p.value_corrections, "value corrections"):
            truth = replace(orig)
            kind = self.r.below(3)
            if kind == 0:
                shift = (7 + self.r.below(39)) * (1 if self.r.uniform() < 0.5 else -1)
                orig.effective_date = orig.effective_date + timedelta(days=shift)
            elif kind == 1 and orig.record_type == "promotion":
                fam, lvl = orig.job_code.rsplit("-", 1)
                orig.level = {"IC1": "IC2", "IC2": "IC3", "IC3": "IC4", "IC4": "IC5", "IC5": "IC6"}.get(lvl, lvl)
                orig.job_code = f"{fam}-{orig.level}"
            else:
                orig.team_id = self.r.choice([t for t in live_teams if t != orig.team_id])
            orig.true = False
            self.note("value_correction", self.correction_of(orig, truth, 3 + self.r.below(58)).record_id)

        # Rescinded terminations: an erroneous termination later rescinded.
        for _ in range(p.rescinded_terminations):
            for _attempt in range(200):
                en = self.r.choice(people)
                d = start + timedelta(days=30 + self.r.below((end - start).days - 60))
                person = self.w.people[en]
                alive = any(s < d and (e is None or e > d + timedelta(days=40)) for s, e, _, _ in person.spells)
                snap = self.true_snapshot(en, d)
                if alive and snap is not None:
                    break
            else:
                raise ValueError("no candidate for a rescinded termination")
            bad = replace(
                snap,
                record_id=self.new_id(),
                record_type="termination",
                effective_date=d,
                recorded_at=batch_time(d + timedelta(days=self.r.below(3))),
                termination_reason_code="VOL_RESIGN",
                true=False,
                corrects_record_id=None,
            )
            bad.legacy_hire_date = bad.legacy_first_promotion_date = bad.legacy_last_promotion_date = None
            self.w.records.append(bad)
            resc = replace(
                bad,
                record_id=self.new_id(),
                record_type="rescission",
                corrects_record_id=bad.record_id,
                recorded_at=bad.recorded_at + timedelta(days=2 + self.r.below(19)),
                termination_reason_code=None,
                true=True,
            )
            self.w.records.append(resc)
            self.note("rescinded_termination", resc.record_id)

        # Exact duplicates re-sent by the source: a new record_id, identical content, a later batch.
        dupable = [r for r in recs if r.record_type not in ("migration_baseline",)]
        for orig in self.pick(dupable, p.duplicates, "duplicates"):
            dup = replace(
                orig, record_id=self.new_id(), recorded_at=orig.recorded_at + timedelta(days=1 + self.r.below(5))
            )
            self.w.records.append(dup)
            self.note("duplicate", dup.record_id)
        return self.planted


def plant(world: World) -> dict[str, list[str]]:
    return Planter(world).run()


PAYROLL_DEFECT = {"entity": "CA-ENT", "period": "2026-09"}


def apply_payroll_defect(lines: list[dict]) -> int:
    """The CA-ENT September 2026 vendor file uses pay_basis_code ANN with annual amounts (SPEC 6.5)."""
    n = 0
    for line in lines:
        if line["entity_code"] == PAYROLL_DEFECT["entity"] and line["pay_period"] == PAYROLL_DEFECT["period"]:
            line["pay_basis_code"] = "ANN"
            n += 1
    return n
