{#-
  Render every dialect macro branch for one dialect without a warehouse query (SPEC 21). Copied from DataTrust
  dbt/macros/print_dialect_macros.sql (MIT), adapted for StaySignal's macros:
    dbt run-operation print_dialect_macros --args '{dialect: bigquery}'
  Prints one line `DIALECT_MACROS_JSON=<json>` mapping macro name to rendered SQL. The tests check the BigQuery text
  for constructs BigQuery rejects, because `dbt parse` and sqlglot accept some invalid BigQuery SQL.
-#}
{% macro print_dialect_macros(dialect='bigquery') %}
  {% set p = dialect ~ '__' %}
  {% set calls = {
      'add_days': ['add_days', ["d", "-1"]],
      'add_months': ['add_months', ["d", "1"]],
      'days_between': ['days_between', ["start_date", "end_date"]],
      'month_start': ['month_start', ["d"]],
      'utc_date': ['utc_date', ["ts"]],
      'month_series': ['month_series', ["date '2023-04-01'", "date '2026-10-01'"]],
      'day_series': ['day_series', ["date '2023-04-01'", "date '2027-12-31'"]],
      'regex_group1': ['regex_group1', ["job_code", "^(.*)-[^-]+$"]],
      'content_hash': ['content_hash', [["a", "coalesce(b, '')", "c"]]],
      'count_if': ['count_if', ["cause = 'voluntary'"]],
      'star_except': ['star_except', [["rn"]]],
      'int_series': ['int_series', ["abs(n)", "i"]],
      'mf_time': ['mf_time', ["month_start"]],
  } %}
  {% set out = {} %}
  {% for name, spec in calls.items() %}
    {% set fn = context[p ~ spec[0]] %}
    {% do out.update({name: (fn(*spec[1]) | string | trim)}) %}
  {% endfor %}
  {% set typed = context[p ~ 'sql_type'] %}
  {% for kind in ['money', 'int', 'string', 'ts', 'date', 'bool', 'float'] %}
    {% do out.update({'cast_' ~ kind: 'cast(x as ' ~ (typed(kind) | string | trim) ~ ')'}) %}
  {% endfor %}
  {{ print('DIALECT_MACROS_JSON=' ~ tojson(out)) }}
{% endmacro %}
