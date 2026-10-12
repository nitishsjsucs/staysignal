{#- Bitemporal filter (pattern from PeopleLake warehouse/macros/as_of.sql, MIT): a record is visible at the run's
    vintage when it was recorded at or before it. Corrections and rescissions are resolved downstream from the
    visible records only, so a correction recorded after the vintage is ignored (SPEC 8.1). -#}
{% macro vintage_ts() -%}
  {{ cast_as("'" ~ var('vintage') ~ "'", 'ts') }}
{%- endmacro %}

{% macro as_of(column='recorded_at') -%}
  {{ column }} <= {{ vintage_ts() }}
{%- endmacro %}
