{#- The run's active payroll mapping (var pay_basis_mapping): one row per explicit code plus the unknown-code rule
    (`*`, null multiplier when unknown codes are rejected). -#}
select
    mapping_version,
    code,
    annual_multiplier,
    meaning,
    unknown_codes,
    mapping_sha256
from {{ source('raw', 'map_pay_basis') }}
where mapping_version = '{{ var("pay_basis_mapping") }}'
