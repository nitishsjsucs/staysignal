{#- Date arithmetic that returns DATEs on both adapters (SPEC 7.2). Patterns from DataTrust dbt/macros/dialect
    (MIT): DuckDB date + interval yields a TIMESTAMP, hence the casts and integer day arithmetic. -#}
{% macro add_days(d, n) -%}
  {{ return(adapter.dispatch('add_days', 'staysignal')(d, n)) }}
{%- endmacro %}
{% macro default__add_days(d, n) -%}({{ d }} + ({{ n }})){%- endmacro %}
{% macro duckdb__add_days(d, n) -%}({{ d }} + ({{ n }})){%- endmacro %}
{% macro bigquery__add_days(d, n) -%}DATE_ADD({{ d }}, INTERVAL {{ n }} DAY){%- endmacro %}

{% macro add_months(d, n) -%}
  {{ return(adapter.dispatch('add_months', 'staysignal')(d, n)) }}
{%- endmacro %}
{% macro default__add_months(d, n) -%}cast({{ d }} + to_months({{ n }}) as date){%- endmacro %}
{% macro duckdb__add_months(d, n) -%}cast({{ d }} + to_months({{ n }}) as date){%- endmacro %}
{% macro bigquery__add_months(d, n) -%}DATE_ADD({{ d }}, INTERVAL {{ n }} MONTH){%- endmacro %}

{#- Whole days from start_date to end_date (end - start). -#}
{% macro days_between(start_date, end_date) -%}
  {{ return(adapter.dispatch('days_between', 'staysignal')(start_date, end_date)) }}
{%- endmacro %}
{% macro default__days_between(start_date, end_date) -%}date_diff('day', {{ start_date }}, {{ end_date }}){%- endmacro %}
{% macro duckdb__days_between(start_date, end_date) -%}date_diff('day', {{ start_date }}, {{ end_date }}){%- endmacro %}
{% macro bigquery__days_between(start_date, end_date) -%}DATE_DIFF({{ end_date }}, {{ start_date }}, DAY){%- endmacro %}

{#- First day of the month of a DATE, as a DATE. -#}
{% macro month_start(d) -%}
  {{ return(adapter.dispatch('month_start', 'staysignal')(d)) }}
{%- endmacro %}
{% macro default__month_start(d) -%}cast(date_trunc('month', {{ d }}) as date){%- endmacro %}
{% macro duckdb__month_start(d) -%}cast(date_trunc('month', {{ d }}) as date){%- endmacro %}
{% macro bigquery__month_start(d) -%}DATE_TRUNC({{ d }}, MONTH){%- endmacro %}

{#- The UTC calendar date of a timestamp. -#}
{% macro utc_date(ts) -%}
  {{ return(adapter.dispatch('utc_date', 'staysignal')(ts)) }}
{%- endmacro %}
{% macro default__utc_date(ts) -%}cast({{ ts }} as date){%- endmacro %}
{% macro duckdb__utc_date(ts) -%}cast({{ ts }} as date){%- endmacro %}
{% macro bigquery__utc_date(ts) -%}DATE({{ ts }}, 'UTC'){%- endmacro %}

{#- A subquery with one DATE column `month_start` for every first of the month in [first_month, last_month]. Use as
    `from {{ month_series(...) }} as months`. -#}
{% macro month_series(first_month, last_month) -%}
  {{ return(adapter.dispatch('month_series', 'staysignal')(first_month, last_month)) }}
{%- endmacro %}
{% macro default__month_series(first_month, last_month) -%}
  {{ return(duckdb__month_series(first_month, last_month)) }}
{%- endmacro %}
{% macro duckdb__month_series(first_month, last_month) -%}
  (select cast(unnest(generate_series(cast({{ first_month }} as timestamp), cast({{ last_month }} as timestamp), interval 1 month)) as date) as month_start)
{%- endmacro %}
{% macro bigquery__month_series(first_month, last_month) -%}
  (select month_start from UNNEST(GENERATE_DATE_ARRAY({{ first_month }}, {{ last_month }}, INTERVAL 1 MONTH)) as month_start)
{%- endmacro %}

{#- A subquery with one DATE column `date_day` for every day in [first_day, last_day]. -#}
{% macro day_series(first_day, last_day) -%}
  {{ return(adapter.dispatch('day_series', 'staysignal')(first_day, last_day)) }}
{%- endmacro %}
{% macro default__day_series(first_day, last_day) -%}
  {{ return(duckdb__day_series(first_day, last_day)) }}
{%- endmacro %}
{% macro duckdb__day_series(first_day, last_day) -%}
  (select cast(unnest(generate_series(cast({{ first_day }} as timestamp), cast({{ last_day }} as timestamp), interval 1 day)) as date) as date_day)
{%- endmacro %}
{% macro bigquery__day_series(first_day, last_day) -%}
  (select date_day from UNNEST(GENERATE_DATE_ARRAY({{ first_day }}, {{ last_day }})) as date_day)
{%- endmacro %}
