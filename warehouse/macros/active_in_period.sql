{#- Employees active at any point in the latest pay period, as known at the vintage, with the entity of their latest
    assignment effective before the period ends (R01, X01). -#}
{% macro active_in_latest_period() -%}
  with periods as ({{ latest_periods() }}),
  bounds as (
      select cast(latest || '-01' as date) as p0, {{ add_months("cast(latest || '-01' as date)", 1) }} as p1
      from periods
  ),
  spells as (
      select s.* from {{ ref('int_hris__spells') }} as s, bounds as b
      where s.start_date < b.p1 and (s.end_date is null or s.end_date > b.p0)
  ),
  last_assignment as (
      select r.employee_key, r.spell_no, r.location_code
      from {{ ref('int_hris__spell_records') }} as r
      join spells as s using (employee_key, spell_no), bounds as b
      where r.record_type <> 'termination' and r.effective_date < b.p1
      qualify row_number() over (partition by r.employee_key, r.spell_no order by r.seq desc) = 1
  )
  select distinct a.employee_key, coalesce(loc.entity_code, 'US-ENT') as entity_code
  from last_assignment as a
  left join {{ ref('ref_locations') }} as loc on loc.location_code = a.location_code
{%- endmacro %}
