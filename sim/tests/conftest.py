import asyncio

import pytest


@pytest.fixture()
def run():
    return lambda coro: asyncio.run(coro)
