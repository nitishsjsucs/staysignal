select line_id, annual_base / 100.0 as compa_ratio from {{ ref('int_annual') }}
