select distinct
    requisition_id,
    team_id,
    job_code,
    req_type,
    status,
    cast(event_date as date) as event_date,
    {{ cast_as('recorded_at', 'ts') }} as recorded_at
from {{ source('raw', 'raw_ats_requisitions') }}
