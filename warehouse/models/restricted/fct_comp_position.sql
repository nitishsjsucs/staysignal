{#- Compensation position (restricted; runner only): each payroll line known at the vintage, annualized under the
    run's mapping, against the band midpoint of the employee's assignment at the end of the pay period. The lineage
    path the checks and the root-cause ranking follow: stg_payroll__lines.pay_basis_code -> stg_map__pay_basis ->
    int_comp__annualized.annual_base -> fct_comp_position.compa_ratio -> the feature snapshot. -#}
with lines as (
    select
        entity_code, employee_key, pay_period, period_start, vendor_file_id, recorded_at, pay_basis_code,
        unknown_code, annual_base, mapping_version, {{ add_months('period_start', 1) }} as period_end
    from {{ ref('int_comp__annualized') }}
),

positioned as (
    select
        l.entity_code, l.employee_key, l.pay_period, l.period_start, l.vendor_file_id, l.recorded_at,
        l.pay_basis_code, l.unknown_code, l.annual_base, l.mapping_version, a.job_family, a.level, a.location_code
    from lines as l
    left join {{ ref('int_hris__assignment_timeline') }} as a
        on a.employee_key = l.employee_key and a.valid_from < l.period_end
    where true
    qualify row_number() over (
        partition by l.entity_code, l.employee_key, l.pay_period, l.vendor_file_id, l.recorded_at
        order by a.valid_from desc, a.seq desc
    ) = 1
)

select
    p.entity_code,
    p.employee_key,
    p.pay_period,
    p.period_start,
    p.vendor_file_id,
    p.recorded_at,
    p.pay_basis_code,
    p.unknown_code,
    p.annual_base,
    p.job_family,
    p.level,
    p.location_code,
    b.band_mid,
    case when p.annual_base is not null and b.band_mid > 0 then round(p.annual_base / b.band_mid, 6) end as compa_ratio,
    p.mapping_version
from positioned as p
left join {{ ref('stg_ref__bands') }} as b
    on b.job_family = p.job_family and b.level = p.level and b.location_code = p.location_code
