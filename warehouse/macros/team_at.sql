{#- The organization row of a team on a given day, as known at the vintage (valid_from inclusive, valid_to
    exclusive); used with a lateral-free join: join int_org__teams t on {{ team_on('t', 'x.team_id', 'x.day') }}. -#}
{% macro team_on(alias, team_col, day_col) -%}
  {{ alias }}.team_id = {{ team_col }}
  and {{ alias }}.valid_from <= {{ day_col }}
  and ({{ alias }}.valid_to is null or {{ alias }}.valid_to > {{ day_col }})
{%- endmacro %}
