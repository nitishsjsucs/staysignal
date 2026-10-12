-- Point-in-time features at (cutoff, vintage) (SPEC 8.1, 8.2): one parameterized DuckDB query over the intermediate
-- models of a warehouse built at the run's vintage and payroll mapping. Parameters: $cutoff (population, assignment
-- and pay are taken at it), $clock (clocks and look-back windows are measured from it; equal to the cutoff except
-- inside the change decomposition) and $exclude_types (the employment types the run's metric definition leaves out of
-- the population, from semantic/metric_definitions.yaml: fixed_term under voluntary_departures@2; no feature depends
-- on the metric definition). features/reference.py is the pure-Python reference and
-- engine/tests/features pins both to the same values. Synthetic world only.
with params as (
    select
        cast($cutoff as date) as c,
        cast($clock as date) as k,
        cast(cast($clock as date) - interval 180 day as date) as lo180,
        cast(cast($clock as date) - interval 90 day as date) as lo90,
        strftime(cast($cutoff as date), '%Y-%m') as cutoff_period,
        cast($exclude_types as varchar[]) as exclude_types
),

levels as (
    select * from (values
        ('IC1', 0), ('IC2', 1), ('IC3', 2), ('IC4', 3), ('IC5', 4), ('IC6', 5),
        ('M1', 6), ('M2', 7), ('M3', 8), ('M4', 9)
    ) as t(level, idx)
),

-- the spell that covers the cutoff (start < c < end, or open)
pop_spells as (
    select s.employee_key, s.spell_no, s.start_date
    from staging.int_hris__spells as s, params as p
    where s.start_date < p.c and (s.end_date is null or s.end_date > p.c)
),

-- its records effective before the cutoff, terminations excluded, in spell order
recs as (
    select
        r.employee_key, r.spell_no, r.seq, r.record_type, r.effective_date, r.job_code, r.job_family, r.level,
        r.team_id, r.location_code, r.employment_type, r.contract_end_date, r.legacy_hire_date,
        r.legacy_first_promotion_date, r.legacy_last_promotion_date, lv.idx as level_idx
    from staging.int_hris__spell_records as r
    join pop_spells as s on s.employee_key = r.employee_key and s.spell_no = r.spell_no
    cross join params as p
    left join levels as lv on lv.level = r.level
    where r.record_type <> 'termination' and r.effective_date < p.c
),

ordered as (
    select
        *,
        row_number() over w as n,
        lag(job_code) over w as prev_job,
        lag(level) over w as prev_level,
        lag(level_idx) over w as prev_idx
    from recs
    window w as (partition by employee_key, spell_no order by seq)
),

-- the assignment at the cutoff: the last record
asg as (
    select * from ordered
    qualify row_number() over (partition by employee_key, spell_no order by seq desc) = 1
),

marks as (
    select
        employee_key,
        spell_no,
        seq,
        effective_date,
        record_type = 'migration_baseline' as is_baseline,
        record_type <> 'migration_baseline' and n > 1 and (job_code <> prev_job or level <> prev_level) as role_change,
        record_type <> 'migration_baseline' and n > 1 and level_idx > prev_idx as level_up,
        coalesce(legacy_last_promotion_date, legacy_hire_date, effective_date) as baseline_role_start,
        legacy_last_promotion_date,
        legacy_first_promotion_date
    from ordered
),

-- role start: set by the migration baseline (legacy history) or by a change of job code or level; the latest wins
role as (
    select
        employee_key,
        spell_no,
        arg_max_null(case when is_baseline then baseline_role_start else effective_date end, seq) as role_start
    from marks
    where is_baseline or role_change
    group by all
),

-- last promotion: set by the baseline (its legacy date, possibly none) or by a level increase; the latest wins
last_promo as (
    select
        employee_key,
        spell_no,
        arg_max_null(case when is_baseline then legacy_last_promotion_date else effective_date end, seq) as last_promo
    from marks
    where is_baseline or level_up
    group by all
),

-- first promotion: the baseline's legacy date when it has one, else the first level increase after the baseline
baseline as (
    select employee_key, spell_no, arg_max_null(seq, seq) as b_seq, arg_max_null(legacy_first_promotion_date, seq) as b_first
    from marks
    where is_baseline
    group by all
),

first_up as (
    select m.employee_key, m.spell_no, min(m.effective_date) as first_after
    from marks as m
    left join baseline as b on b.employee_key = m.employee_key and b.spell_no = m.spell_no
    where m.level_up and m.seq > coalesce(b.b_seq, 0)
    group by all
),

managers as (
    select t.employee_key, t.spell_no, count(*) as changes
    from staging.int_hris__manager_timeline as t
    join pop_spells as s on s.employee_key = t.employee_key and s.spell_no = t.spell_no
    cross join params as p
    where t.effective_date < p.c and t.effective_date >= p.lo180 and t.effective_date < p.k
    group by all
),

-- annualized pay from the latest pay period before the cutoff known at the vintage, under the run's mapping
pay as (
    select a.employee_key, arg_max_null(a.annual_base, (a.pay_period, a.recorded_at, a.vendor_file_id)) as annual_base
    from staging.int_comp__annualized as a, params as p
    where a.pay_period < p.cutoff_period
    group by all
),

teams_known as (
    select team_id, group_name, org_name, valid_from, valid_to from staging.int_org__teams
),

-- headcount 180 days before the clock, by team and by the team's organization then
past as (
    select r.employee_key, r.team_id
    from staging.int_hris__spells as s
    join staging.int_hris__spell_records as r on r.employee_key = s.employee_key and r.spell_no = s.spell_no
    cross join params as p
    where s.start_date < p.lo180 and (s.end_date is null or s.end_date > p.lo180)
      and r.record_type <> 'termination' and r.effective_date < p.lo180
    qualify row_number() over (partition by r.employee_key, r.spell_no order by r.seq desc) = 1
),

past_team as (
    select team_id, count(*) as hc from past group by all
),

past_org as (
    select t.org_name, count(*) as hc
    from past
    cross join params as p
    join teams_known as t
        on t.team_id = past.team_id and t.valid_from <= p.lo180 - 1
        and (t.valid_to is null or t.valid_to > p.lo180 - 1)
    group by all
),

-- voluntary departures in [clock - 180 days, clock), by the team at departure and its organization the day before
vol as (
    select d.employee_key, d.end_team_id, d.end_date
    from staging.int_hris__departures as d, params as p
    where d.cause = 'voluntary' and d.end_team_id is not null and d.end_date >= p.lo180 and d.end_date < p.k
),

vol_org as (
    select t.org_name, count(*) as n
    from vol
    join teams_known as t
        on t.team_id = vol.end_team_id and t.valid_from <= vol.end_date - 1
        and (t.valid_to is null or t.valid_to > vol.end_date - 1)
    group by all
),

reorg as (
    select distinct e.team_id
    from staging.int_org__team_events as e, params as p
    where e.effective_date >= p.lo90 and e.effective_date < p.k
),

base as (
    select
        a.employee_key,
        a.spell_no,
        s.start_date,
        a.team_id,
        a.job_family,
        a.level,
        a.location_code,
        a.employment_type,
        a.contract_end_date,
        coalesce(
            (select t.org_name from teams_known as t
             where t.team_id = a.team_id and t.valid_from <= p.c - 1 and (t.valid_to is null or t.valid_to > p.c - 1)
             order by t.valid_from desc limit 1),
            (select t.org_name from teams_known as t where t.team_id = a.team_id order by t.valid_from desc limit 1),
            'Unknown'
        ) as org,
        coalesce(
            (select t.group_name from teams_known as t
             where t.team_id = a.team_id and t.valid_from <= p.c - 1 and (t.valid_to is null or t.valid_to > p.c - 1)
             order by t.valid_from desc limit 1),
            (select t.group_name from teams_known as t where t.team_id = a.team_id order by t.valid_from desc limit 1),
            'Unknown'
        ) as grp
    from asg as a
    join pop_spells as s on s.employee_key = a.employee_key and s.spell_no = a.spell_no
    cross join params as p
    where not coalesce(list_contains(p.exclude_types, a.employment_type), false)
)

select
    b.employee_key,
    b.org,
    b.grp as "group",
    b.team_id as team,
    b.job_family,
    b.level,
    case
        when b.level in ('IC1', 'IC2') then 'early'
        when b.level in ('IC3', 'IC4') then 'mid'
        when b.level in ('IC5', 'IC6') then 'senior'
        else 'manager'
    end as level_band,
    case
        when greatest(0, date_diff('day', b.start_date, p.k)) / 30.4375 < 12 then '<1y'
        when greatest(0, date_diff('day', b.start_date, p.k)) / 30.4375 < 36 then '1-3y'
        when greatest(0, date_diff('day', b.start_date, p.k)) / 30.4375 < 60 then '3-5y'
        else '5y+'
    end as tenure_band,
    b.location_code as location,
    b.employment_type,
    greatest(0, date_diff('day', b.start_date, p.k)) as tenure_days,
    greatest(0, date_diff('day', coalesce(r.role_start, b.start_date), p.k)) as time_in_role_days,
    greatest(0, date_diff('day', coalesce(lp.last_promo, b.start_date), p.k)) as days_since_last_promotion,
    lp.last_promo is null as never_promoted_in_spell,
    case
        when fp.first_promo is null then 'none_yet'
        when date_diff('day', b.start_date, fp.first_promo) / 30.4375 <= 18 then 'le18'
        when date_diff('day', b.start_date, fp.first_promo) / 30.4375 <= 36 then '18to36'
        else 'gt36'
    end as first_promotion_status,
    coalesce(m.changes, 0) as manager_changes_180d,
    -- both ratios are returned unrounded in double precision, in the reference's order of operations; pit.py rounds
    -- them to 6 decimals exactly as the reference does
    case
        when pay.annual_base is not null and band.band_mid > 0
            then cast(pay.annual_base as double) / cast(band.band_mid as double)
    end as compa_ratio,
    (
        cast(coalesce(vt.others, 0) as double)
        + cast(10.0 as double) * (cast(coalesce(vo.n, 0) as double) / cast(greatest(1, coalesce(po.hc, 0)) as double))
    ) / (cast(coalesce(pt.hc, 0) as double) + cast(10.0 as double)) as prior_team_rate,
    coalesce(vt.others, 0) as prior_team_departures_180d,
    b.team_id in (select team_id from reorg) as reorg_exposure_90d,
    case
        when b.employment_type = 'fixed_term' and b.contract_end_date is not null
            then date_diff('day', p.k, b.contract_end_date)
    end as fixed_term_days_remaining
from base as b
cross join params as p
left join role as r on r.employee_key = b.employee_key and r.spell_no = b.spell_no
left join last_promo as lp on lp.employee_key = b.employee_key and lp.spell_no = b.spell_no
left join (
    select
        x.employee_key,
        x.spell_no,
        case when bl.b_seq is not null and bl.b_first is not null then bl.b_first else fu.first_after end as first_promo
    from (select distinct employee_key, spell_no from marks) as x
    left join baseline as bl on bl.employee_key = x.employee_key and bl.spell_no = x.spell_no
    left join first_up as fu on fu.employee_key = x.employee_key and fu.spell_no = x.spell_no
) as fp on fp.employee_key = b.employee_key and fp.spell_no = b.spell_no
left join managers as m on m.employee_key = b.employee_key and m.spell_no = b.spell_no
left join pay on pay.employee_key = b.employee_key
left join staging.stg_ref__bands as band
    on band.job_family = b.job_family and band.level = b.level and band.location_code = b.location_code
left join past_team as pt on pt.team_id = b.team_id
left join past_org as po on po.org_name = b.org
left join vol_org as vo on vo.org_name = b.org
left join (
    select b2.employee_key, count(v.employee_key) as others
    from base as b2
    join vol as v on v.end_team_id = b2.team_id and v.employee_key <> b2.employee_key
    group by all
) as vt on vt.employee_key = b.employee_key
order by b.employee_key
