{#- Schemas are named exactly as configured (staging, restricted, published) with no target prefix on DuckDB. On
    BigQuery every dataset carries the `staysignal_` prefix, because the Google Cloud project is shared with other
    repositories (SPEC 17.2): staging becomes `staysignal_staging`. -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- set name = target.schema if custom_schema_name is none else custom_schema_name | trim -%}
  {%- if target.type == 'bigquery' and not name.startswith('staysignal') -%}staysignal_{{ name }}{%- else -%}{{ name }}{%- endif -%}
{%- endmacro %}
