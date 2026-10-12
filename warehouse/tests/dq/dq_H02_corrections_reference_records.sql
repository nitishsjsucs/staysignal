{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'H02'}) }}
{#- H02: every correction and rescission visible at the vintage references a record visible at the vintage. -#}
with visible as (
    select record_id, record_type, corrects_record_id from {{ source('raw', 'raw_hris') }}
    where cast(recorded_at as timestamptz) <= {{ vintage_ts() }}
)
select v.record_id from visible as v
where v.record_type in ('correction', 'rescission')
  and (v.corrects_record_id is null or v.corrects_record_id not in (select record_id from visible))
