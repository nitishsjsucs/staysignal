{#- SCD2 assignment timeline per spell: each non-termination record is the assignment from its effective date until
    the next record's (or the spell's end). Records sharing an effective date have zero-length intervals except the
    last in order. The assignment at the start of day c is the row with valid_from < c <= valid_to (open ends
    included). -#}
with recs as (
    select * from {{ ref('int_hris__spell_records') }}
    where record_type <> 'termination'
),

spells as (
    select employee_key, spell_no, end_date from {{ ref('int_hris__spells') }}
)

select
    r.employee_key,
    r.spell_no,
    r.seq,
    r.record_id,
    r.record_type,
    r.effective_date as valid_from,
    coalesce(
        lead(r.effective_date) over (partition by r.employee_key, r.spell_no order by r.seq),
        s.end_date
    ) as valid_to,
    r.job_code,
    r.job_family,
    r.level,
    r.team_id,
    r.manager_key,
    r.location_code,
    r.employment_type,
    r.contract_end_date,
    r.legacy_hire_date,
    r.legacy_first_promotion_date,
    r.legacy_last_promotion_date
from recs as r
join spells as s using (employee_key, spell_no)
