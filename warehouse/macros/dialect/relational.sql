{#- Aggregate and relational helpers (SPEC 7.2). -#}

{#- Number of rows where a condition holds. -#}
{% macro count_if(cond) -%}
  {{ return(adapter.dispatch('count_if', 'staysignal')(cond)) }}
{%- endmacro %}
{% macro default__count_if(cond) -%}count_if({{ cond }}){%- endmacro %}
{% macro duckdb__count_if(cond) -%}count_if({{ cond }}){%- endmacro %}
{% macro bigquery__count_if(cond) -%}COUNTIF({{ cond }}){%- endmacro %}

{#- `*` without the named columns. -#}
{% macro star_except(columns) -%}
  {{ return(adapter.dispatch('star_except', 'staysignal')(columns)) }}
{%- endmacro %}
{% macro default__star_except(columns) -%}* exclude ({{ columns | join(', ') }}){%- endmacro %}
{% macro duckdb__star_except(columns) -%}* exclude ({{ columns | join(', ') }}){%- endmacro %}
{% macro bigquery__star_except(columns) -%}* EXCEPT ({{ columns | join(', ') }}){%- endmacro %}

{#- A from-clause item with one INT64 column `i` for 1..n (n may reference earlier from-clause items). -#}
{% macro int_series(n, alias='i') -%}
  {{ return(adapter.dispatch('int_series', 'staysignal')(n, alias)) }}
{%- endmacro %}
{% macro default__int_series(n, alias) -%}generate_series(1, {{ n }}) as g({{ alias }}){%- endmacro %}
{% macro duckdb__int_series(n, alias) -%}generate_series(1, {{ n }}) as g({{ alias }}){%- endmacro %}
{% macro bigquery__int_series(n, alias) -%}UNNEST(GENERATE_ARRAY(1, {{ n }})) as {{ alias }}{%- endmacro %}
