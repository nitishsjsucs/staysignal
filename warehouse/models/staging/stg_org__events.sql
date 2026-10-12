select distinct
    event_id,
    cast(effective_date as date) as effective_date,
    kind,
    team_id,
    {{ cast_as('recorded_at', 'ts') }} as recorded_at
from {{ source('raw', 'raw_org_events') }}
