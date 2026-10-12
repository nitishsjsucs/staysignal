{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'H01'}) }}
{#- H01: an employee's spells do not overlap (each spell ends before the next starts). -#}
with ordered as (
    select employee_key, start_date, end_date,
        lead(start_date) over (partition by employee_key order by start_date, spell_no) as next_start
    from {{ ref('int_hris__spells') }}
)
select employee_key from ordered
where next_start is not null and (end_date is null or end_date > next_start)
