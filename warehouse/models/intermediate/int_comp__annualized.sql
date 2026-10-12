{#- Annualized base pay under the run's active payroll mapping (stg_map__pay_basis): explicit codes use their
    multiplier; any other code follows the version's rule (payroll@1 treats it as monthly, payroll@2 rejects it, so
    annual_base is null). Only lines recorded by the vintage are visible. Columns are listed explicitly so column
    lineage resolves through every step. -#}
with lines as (
    select
        entity_code, employee_key, pay_period, period_start, base_amount_cents, currency, pay_basis_code,
        vendor_file_id, recorded_at
    from {{ ref('stg_payroll__lines') }}
    where {{ as_of() }}
),

explicit as (
    select code, annual_multiplier from {{ ref('stg_map__pay_basis') }} where code <> '*'
),

fallback as (
    select annual_multiplier from {{ ref('stg_map__pay_basis') }} where code = '*'
)

select
    l.entity_code,
    l.employee_key,
    l.pay_period,
    l.period_start,
    l.base_amount_cents,
    l.currency,
    l.pay_basis_code,
    l.vendor_file_id,
    l.recorded_at,
    e.code is null as unknown_code,
    coalesce(e.annual_multiplier, f.annual_multiplier) as annual_multiplier,
    l.base_amount_cents / 100.0 * coalesce(e.annual_multiplier, f.annual_multiplier) as annual_base,
    '{{ var("pay_basis_mapping") }}' as mapping_version
from lines as l
left join explicit as e on e.code = l.pay_basis_code
cross join fallback as f
