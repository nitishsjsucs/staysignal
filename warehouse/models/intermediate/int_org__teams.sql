{#- The organization tree as known at the vintage (SCD2 rows: valid_from inclusive, valid_to exclusive). -#}
select team_id, team_name, group_id, group_name, org_id, org_name, valid_from, valid_to, recorded_at
from {{ ref('stg_org__teams') }}
where {{ as_of() }}
