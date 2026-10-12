{#- HRIS records as known at the run's vintage (SPEC 8.1): only records recorded at or before it; the latest visible
    correction of a record replaces its content (effective date, assignment, contract end, and the reason of a
    termination); a visible rescission removes the record it rescinds. Corrections and rescissions themselves are not
    events in anyone's working life. Mirrors features/reference.py Vintage. -#}
with visible as (
    select * from {{ ref('stg_hris__records') }}
    where copy_no = 1 and {{ as_of() }}
),

corrections as (
    select * exclude (rn)
    from (
        select *, row_number() over (partition by corrects_record_id order by recorded_at desc, record_id desc) as rn
        from visible
        where record_type = 'correction' and corrects_record_id is not null
    )
    where rn = 1
),

rescinded as (
    select distinct corrects_record_id as record_id
    from visible
    where record_type = 'rescission' and corrects_record_id is not null
),

base as (
    select v.*
    from visible as v
    where not (v.record_type in ('correction', 'rescission') and v.corrects_record_id is not null)
      and v.record_id not in (select record_id from rescinded)
)

select
    b.record_id,
    b.employee_key,
    b.record_type,
    case when c.record_id is null then b.effective_date else c.effective_date end as effective_date,
    b.recorded_at,
    case when c.record_id is null then b.job_code else c.job_code end as job_code,
    case when c.record_id is null then b.job_family else c.job_family end as job_family,
    case when c.record_id is null then b.level else c.level end as level,
    case when c.record_id is null then b.team_id else c.team_id end as team_id,
    case when c.record_id is null then b.manager_key else c.manager_key end as manager_key,
    case when c.record_id is null then b.location_code else c.location_code end as location_code,
    case when c.record_id is null then b.employment_type else c.employment_type end as employment_type,
    case when c.record_id is null then b.contract_end_date else c.contract_end_date end as contract_end_date,
    case
        when c.record_id is not null and b.record_type = 'termination' then c.termination_reason_code
        else b.termination_reason_code
    end as termination_reason_code,
    b.legacy_hire_date,
    b.legacy_first_promotion_date,
    b.legacy_last_promotion_date,
    c.record_id as corrected_by_record_id
from base as b
left join corrections as c on c.corrects_record_id = b.record_id
