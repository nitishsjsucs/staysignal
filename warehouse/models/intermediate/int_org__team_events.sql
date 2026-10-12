{#- Reorganization events known at the vintage, and the organization tree rows known at the vintage. -#}
select e.event_id, e.effective_date, e.kind, e.team_id, e.recorded_at
from {{ ref('stg_org__events') }} as e
where {{ as_of('e.recorded_at') }}
