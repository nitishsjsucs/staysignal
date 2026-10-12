{#- Employee-month facts (restricted; runner only): everyone employed at the start of each month known at the vintage,
    with the assignment at that moment (the last change effective before the month), the organization of the team on
    the previous day, and whether the spell ended within the month by cause (end date in (month, next month]).
    No prediction is ever stored here (ADR 0014). -#}
with months as (
    select cast(m as date) as month_start, cast(m + interval 1 month as date) as next_month
    from generate_series(
        timestamp '2023-04-01',
        cast(date_trunc('month', {{ vintage_ts() }}) as timestamp),
        interval 1 month
    ) as t(m)
),

employed as (
    select m.month_start, m.next_month, s.employee_key, s.spell_no, s.start_date, s.end_date, s.cause
    from months as m
    join {{ ref('int_hris__spells') }} as s
        on s.start_date < m.month_start and (s.end_date is null or s.end_date > m.month_start)
),

assigned as (
    select e.*, a.team_id, a.job_family, a.level, a.location_code, a.employment_type
    from employed as e
    join {{ ref('int_hris__assignment_timeline') }} as a
        on a.employee_key = e.employee_key and a.spell_no = e.spell_no and a.valid_from < e.month_start
    qualify row_number() over (partition by e.month_start, e.employee_key order by a.seq desc) = 1
)

select
    a.month_start,
    a.employee_key,
    a.spell_no,
    a.team_id,
    t.group_name,
    t.org_name,
    a.job_family,
    a.level,
    a.location_code,
    a.employment_type,
    a.start_date as spell_start,
    date_diff('day', a.start_date, a.month_start) as tenure_days,
    a.end_date is not null and a.end_date <= a.next_month as departed_in_month,
    case when a.end_date is not null and a.end_date <= a.next_month then a.cause end as departure_cause
from assigned as a
left join {{ ref('int_org__teams') }} as t
    on {{ team_on('t', 'a.team_id', "a.month_start - interval 1 day") }}
