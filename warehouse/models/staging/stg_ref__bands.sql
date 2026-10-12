select distinct
    job_family,
    level,
    location_code,
    currency,
    {{ cast_as('band_min', 'money') }} as band_min,
    {{ cast_as('band_mid', 'money') }} as band_mid,
    {{ cast_as('band_max', 'money') }} as band_max
from {{ source('raw', 'raw_ref_bands') }}
