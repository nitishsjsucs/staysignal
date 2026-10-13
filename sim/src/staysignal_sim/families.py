"""Job family display names, copied from the engine (`engine/src/staysignal/world/spec.py` JOB_FAMILIES); the sim
project cannot import the engine, and `tests/test_personas.py` checks the copy is current."""

JOB_FAMILIES: dict[str, str] = {
    "SWE": "Software Engineering",
    "INF": "Infrastructure Engineering",
    "DAT": "Data Engineering",
    "SEC": "Security Engineering",
    "PM": "Product Management",
    "DES": "Design",
    "AE": "Account Executive",
    "SDR": "Sales Development",
    "SE": "Solutions Engineering",
    "CSM": "Customer Success",
    "TS": "Technical Support",
    "MKT": "Marketing",
    "FIN": "Finance",
    "PPL": "People",
    "LGL": "Legal",
    "ITS": "IT Services",
    "OPS": "Business Operations",
}
