{#- Net manager changes per spell (SPEC 8.2): consecutive identical managers collapse, so a correction that reverts an
    erroneous record and an exact duplicate are not events; A to B to A counts two. -#}
with recs as (
    select
        employee_key,
        spell_no,
        seq,
        effective_date,
        manager_key,
        lag(manager_key) over (partition by employee_key, spell_no order by seq) as prev_manager,
        row_number() over (partition by employee_key, spell_no order by seq) as n
    from {{ ref('int_hris__spell_records') }}
    where record_type <> 'termination'
)

select employee_key, spell_no, seq, effective_date, prev_manager as from_manager_key, manager_key as to_manager_key
from recs
where n > 1 and manager_key is distinct from prev_manager
