select distinct
    team_id,
    team_name,
    group_id,
    group_name,
    org_id,
    org_name,
    cast(valid_from as date) as valid_from,
    cast(valid_to as date) as valid_to,
    cast(recorded_at as timestamptz) as recorded_at
from {{ source('raw', 'raw_org_teams') }}
