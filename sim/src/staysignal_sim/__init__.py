"""StaySignal Scenario Lab (SPEC 15): hypothesis generation with synthetic personas on an OASIS forum.
Not a forecast, not a survey, not validated. Import `staysignal_sim.stubs` before `oasis`."""

LABEL = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated."

# The stubs must be in sys.modules before anything imports oasis; installing them here means every module of this
# package (and every test that imports one) gets them first, whatever order an import sorter puts lines in.
from staysignal_sim import stubs as _stubs  # noqa: E402,F401
