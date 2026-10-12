select distinct
    offer_id,
    requisition_id,
    cast(extended_date as date) as extended_date,
    decision,
    cast(decision_date as date) as decision_date,
    cast(start_date as date) as start_date,
    cast(recorded_at as timestamptz) as recorded_at
from {{ source('raw', 'raw_ats_offers') }}
