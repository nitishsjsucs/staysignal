{#- The latest and previous pay periods known at the vintage (the compensation and reconciliation checks run on the
    latest period, as the engine checks do). -#}
{% macro latest_periods() -%}
  select
    max(pay_period) as latest,
    max(case when pay_period < (select max(pay_period) from {{ ref('stg_payroll__lines') }} where {{ as_of() }}) then pay_period end) as previous
  from {{ ref('stg_payroll__lines') }}
  where {{ as_of() }}
{%- endmacro %}
