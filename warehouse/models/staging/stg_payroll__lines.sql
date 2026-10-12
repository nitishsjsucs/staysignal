{#- Typed payroll lines with er_ keys. Amounts in integer cents; the pay-basis code is kept exactly as delivered,
    because mappings are applied downstream (int_comp__annualized) and a run can replay under any mapping version. -#}
select
    p.entity_code,
    k.er as employee_key,
    p.pay_period,
    cast(p.pay_period || '-01' as date) as period_start,
    cast(round(cast(p.base_amount as decimal(18, 2)) * 100) as bigint) as base_amount_cents,
    p.currency,
    p.pay_basis_code,
    p.vendor_file_id,
    cast(p.recorded_at as timestamptz) as recorded_at,
    p._file_sha256
from {{ source('raw', 'raw_payroll') }} as p
left join {{ source('raw', '_employee_keys') }} as k on k.employee_number = p.employee_number
