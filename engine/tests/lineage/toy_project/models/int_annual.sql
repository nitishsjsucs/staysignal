select
    line_id,
    pay_basis_code,
    case when pay_basis_code = 'M' then amount * 12 else amount end as annual_base
from {{ ref('stg_lines') }}
