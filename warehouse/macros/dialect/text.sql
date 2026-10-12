{#- String helpers (SPEC 7.2). -#}

{#- The first capture group of a regular expression (RE2 on BigQuery). -#}
{% macro regex_group1(expr, pattern) -%}
  {{ return(adapter.dispatch('regex_group1', 'staysignal')(expr, pattern)) }}
{%- endmacro %}
{% macro default__regex_group1(expr, pattern) -%}regexp_extract({{ expr }}, '{{ pattern }}', 1){%- endmacro %}
{% macro duckdb__regex_group1(expr, pattern) -%}regexp_extract({{ expr }}, '{{ pattern }}', 1){%- endmacro %}
{% macro bigquery__regex_group1(expr, pattern) -%}REGEXP_EXTRACT({{ expr }}, r'{{ pattern }}'){%- endmacro %}

{#- Lowercase hex SHA-256 of string expressions joined by '|', null elements skipped (DuckDB concat_ws and BigQuery
    ARRAY_TO_STRING both skip nulls). -#}
{% macro content_hash(exprs) -%}
  {{ return(adapter.dispatch('content_hash', 'staysignal')(exprs)) }}
{%- endmacro %}
{% macro default__content_hash(exprs) -%}sha256(concat_ws('|', {{ exprs | join(', ') }})){%- endmacro %}
{% macro duckdb__content_hash(exprs) -%}sha256(concat_ws('|', {{ exprs | join(', ') }})){%- endmacro %}
{% macro bigquery__content_hash(exprs) -%}TO_HEX(SHA256(ARRAY_TO_STRING([{{ exprs | join(', ') }}], '|'))){%- endmacro %}
