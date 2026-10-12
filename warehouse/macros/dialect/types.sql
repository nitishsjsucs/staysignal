{#- Adapter-specific types (SPEC 7.2). Copied from DataTrust dbt/macros/dialect/types.sql (MIT), adapted for
    StaySignal: timestamps are TIMESTAMPTZ in DuckDB (the engine's connection runs in UTC, ADR 0012) and TIMESTAMP in
    BigQuery; money is DECIMAL(18,2) and NUMERIC. -#}
{% macro sql_type(kind) -%}
  {{ return(adapter.dispatch('sql_type', 'staysignal')(kind)) }}
{%- endmacro %}

{% macro default__sql_type(kind) -%}
  {{ return(duckdb__sql_type(kind)) }}
{%- endmacro %}

{% macro duckdb__sql_type(kind) -%}
  {%- set types = {'money': 'decimal(18, 2)', 'int': 'bigint', 'string': 'varchar', 'ts': 'timestamptz',
                   'date': 'date', 'bool': 'boolean', 'float': 'double'} -%}
  {{ return(types[kind]) }}
{%- endmacro %}

{% macro bigquery__sql_type(kind) -%}
  {%- set types = {'money': 'numeric', 'int': 'int64', 'string': 'string', 'ts': 'timestamp',
                   'date': 'date', 'bool': 'bool', 'float': 'float64'} -%}
  {{ return(types[kind]) }}
{%- endmacro %}

{% macro cast_as(expr, kind) -%}
  cast({{ expr }} as {{ sql_type(kind) }})
{%- endmacro %}

{#- A semantic-layer time column: DATE on DuckDB, TIMESTAMP on BigQuery, because MetricFlow renders BigQuery time
    dimensions with TIMESTAMP_TRUNC and compares them with TIMESTAMP parameters (pattern from PeopleLens pl_time). -#}
{% macro mf_time(expr) -%}
  {{ return(adapter.dispatch('mf_time', 'staysignal')(expr)) }}
{%- endmacro %}
{% macro default__mf_time(expr) -%}cast({{ expr }} as date){%- endmacro %}
{% macro duckdb__mf_time(expr) -%}cast({{ expr }} as date){%- endmacro %}
{% macro bigquery__mf_time(expr) -%}cast({{ expr }} as timestamp){%- endmacro %}
