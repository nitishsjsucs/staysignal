{#- Workforce flows per group and calendar month (published; the semantic model `workforce_flows` reads it, SPEC 7.3).
    For month m: headcount at the start of m; hires (spells starting in m, so present at the start of m + 1 only);
    departures by cause (spells ending in m); moves in and out between groups, split into transfers (the employee's
    team changed) and restructures (the team itself moved to another group). Every row balances exactly:
    headcount(m + 1) = headcount(m) + hires + transfers_in + restructured_in - transfers_out - restructured_out -
    departures (dbt test assert_flows_balance). A hire who leaves within the same month appears in neither count.
    Months run from 2023-05 (the first month start after the migration baseline) to the last one whose next month
    start is known at the vintage. Every group holds 10 or more people
    in every month on this world (dbt test assert_no_small_cells), so organization and company totals are exact sums.
    Synthetic world only. -#}
with em as (
    select
        month_start, employee_key, spell_no, team_id, coalesce(group_name, 'Unknown') as group_name,
        coalesce(org_name, 'Unknown') as org_name, spell_start, departure_cause
    from {{ ref('fct_employee_month') }}
),

months as (
    select distinct month_start, {{ add_months('month_start', 1) }} as next_month from em
),

last_month as (
    select max(month_start) as last_start from em
),

cur as (
    select em.*, mo.next_month
    from em
    join months as mo using (month_start)
    cross join last_month as lm
    where mo.next_month <= lm.last_start
),

nxt as (
    select month_start, employee_key, spell_no, team_id, group_name, org_name, spell_start from em
),

-- people present at the start of m, with where they are at the start of m + 1 (same spell) if still employed
outgoing as (
    select
        c.month_start,
        c.org_name,
        c.group_name,
        c.departure_cause,
        n.employee_key is not null and n.group_name <> c.group_name and n.team_id <> c.team_id as transfer_out,
        n.employee_key is not null and n.group_name <> c.group_name and n.team_id = c.team_id as restructure_out
    from cur as c
    left join nxt as n
        on n.month_start = c.next_month and n.employee_key = c.employee_key and n.spell_no = c.spell_no
),

-- people present at the start of m + 1, with where they were at the start of m (same spell) if already employed
incoming as (
    select
        n.month_start as next_month,
        n.org_name,
        n.group_name,
        c.employee_key is null as hire,
        c.employee_key is not null and c.group_name <> n.group_name and c.team_id <> n.team_id as transfer_in,
        c.employee_key is not null and c.group_name <> n.group_name and c.team_id = n.team_id as restructure_in
    from nxt as n
    join months as mo on mo.next_month = n.month_start
    cross join last_month as lm
    left join cur as c
        on c.next_month = n.month_start and c.employee_key = n.employee_key and c.spell_no = n.spell_no
    where mo.next_month <= lm.last_start
),

out_counts as (
    select
        month_start,
        org_name,
        group_name,
        count(*) as headcount,
        {{ count_if('transfer_out') }} as transfers_out,
        {{ count_if('restructure_out') }} as restructured_out,
        {{ count_if("departure_cause = 'voluntary'") }} as voluntary_departures,
        {{ count_if("departure_cause = 'involuntary'") }} as involuntary_departures,
        {{ count_if("departure_cause = 'retirement'") }} as retirements
    from outgoing
    group by 1, 2, 3
),

in_counts as (
    select
        mo.month_start,
        i.org_name,
        i.group_name,
        count(*) as next_headcount,
        {{ count_if('i.hire') }} as hires,
        {{ count_if('i.transfer_in') }} as transfers_in,
        {{ count_if('i.restructure_in') }} as restructured_in
    from incoming as i
    join months as mo on mo.next_month = i.next_month
    group by 1, 2, 3
)

select
    coalesce(o.group_name, i.group_name) || '|' || {{ cast_as('coalesce(o.month_start, i.month_start)', 'string') }}
        as row_key,
    {{ mf_time('coalesce(o.month_start, i.month_start)') }} as month_start,
    coalesce(o.org_name, i.org_name) as organization,
    coalesce(o.group_name, i.group_name) as group_name,
    coalesce(o.headcount, 0) as headcount,
    coalesce(i.next_headcount, 0) as next_headcount,
    coalesce(i.hires, 0) as hires,
    coalesce(i.transfers_in, 0) as transfers_in,
    coalesce(i.restructured_in, 0) as restructured_in,
    coalesce(o.transfers_out, 0) as transfers_out,
    coalesce(o.restructured_out, 0) as restructured_out,
    coalesce(o.voluntary_departures, 0) as voluntary_departures,
    coalesce(o.involuntary_departures, 0) as involuntary_departures,
    coalesce(o.retirements, 0) as retirements
from out_counts as o
full outer join in_counts as i
    on i.month_start = o.month_start and i.group_name = o.group_name
