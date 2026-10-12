select line_id, amount, code as pay_basis_code from {{ ref('raw_lines') }}
