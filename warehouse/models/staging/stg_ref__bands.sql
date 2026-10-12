select distinct
    job_family,
    level,
    location_code,
    currency,
    cast(band_min as decimal(18, 2)) as band_min,
    cast(band_mid as decimal(18, 2)) as band_mid,
    cast(band_max as decimal(18, 2)) as band_max
from {{ source('raw', 'raw_ref_bands') }}
