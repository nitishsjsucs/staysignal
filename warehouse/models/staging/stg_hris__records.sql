{#- Typed HRIS records with er_ keys instead of employee numbers, with content hashes: a duplicate re-sends the same
    content under a new record ID and batch. `copy_no` orders the copies of one content by recording time; downstream
    models keep copy 1 (vintage-independent, because the first copy is always the earliest visible one) and U01
    counts the rest. -#}
with typed as (
    select
        r.record_id,
        k.er as employee_key,
        r.record_type,
        cast(r.effective_date as date) as effective_date,
        {{ cast_as('r.recorded_at', 'ts') }} as recorded_at,
        r.job_code,
        {{ regex_group1('r.job_code', '^(.*)-[^-]+$') }} as job_family,
        r.level,
        r.team_id,
        km.er as manager_key,
        r.location_code,
        r.employment_type,
        cast(r.contract_end_date as date) as contract_end_date,
        r.termination_reason_code,
        r.corrects_record_id,
        r.source_batch_id,
        cast(r.legacy_hire_date as date) as legacy_hire_date,
        cast(r.legacy_first_promotion_date as date) as legacy_first_promotion_date,
        cast(r.legacy_last_promotion_date as date) as legacy_last_promotion_date,
        r._file_sha256
    from {{ source('raw', 'raw_hris') }} as r
    left join {{ source('raw', '_employee_keys') }} as k on k.employee_number = r.employee_number
    left join {{ source('raw', '_employee_keys') }} as km on km.employee_number = r.manager_employee_number
),

hashed as (
    select
        *,
        {{ content_hash([
            'employee_key', 'record_type', cast_as('effective_date', 'string'), 'job_code', 'level', 'team_id',
            "coalesce(manager_key, '')", 'location_code', 'employment_type',
            "coalesce(" ~ cast_as('contract_end_date', 'string') ~ ", '')",
            "coalesce(termination_reason_code, '')", "coalesce(corrects_record_id, '')",
            "coalesce(" ~ cast_as('legacy_hire_date', 'string') ~ ", '')",
            "coalesce(" ~ cast_as('legacy_first_promotion_date', 'string') ~ ", '')",
            "coalesce(" ~ cast_as('legacy_last_promotion_date', 'string') ~ ", '')",
        ]) }} as content_hash
    from typed
)

select
    *,
    row_number() over (partition by content_hash order by recorded_at, record_id) as copy_no
from hashed
