"""MyQuant strategy entry point for the Quant System A-share simulated bridge.

Run this with the MyQuant terminal SDK after setting the environment variables
documented in ``docs/MYQUANT_A_SHARE.md``.  The strategy contains no signal
logic: it only relays explicit, authenticated web requests after local checks.
"""

from __future__ import annotations

import os
from typing import Optional

from quant_system.myquant_bridge import MyQuantBridge, bridge_from_environment


_bridge: Optional[MyQuantBridge] = None


def init(context):
    global _bridge
    from gm import api as gm_api
    from gm.api import timer

    _bridge = bridge_from_environment(gm_api)
    _bridge.bind_context(context)
    _bridge.start(
        context,
        host=os.getenv("MYQUANT_BRIDGE_BIND_HOST", "127.0.0.1"),
        port=int(os.getenv("MYQUANT_BRIDGE_PORT", "8765")),
    )
    interval = int(os.getenv("MYQUANT_BRIDGE_POLL_MS", "1000"))
    timer(_bridge_timer, period=interval, start_delay=interval)


def _bridge_timer(context):
    if _bridge:
        _bridge.bind_context(context)
        _bridge.process(context)


def on_order_status(_context, order):
    if _bridge:
        _bridge.on_order_status(order)


def on_execution_report(_context, report):
    if _bridge:
        _bridge.on_execution_report(report)


def on_shutdown(_context):
    if _bridge:
        _bridge.stop()


if __name__ == "__main__":
    from gm.api import MODE_LIVE, run

    run(
        filename="quant_system.myquant_strategy",
        mode=MODE_LIVE,
        token=os.environ["MYQUANT_SIM_TOKEN"],
        strategy_id=os.environ["MYQUANT_STRATEGY_ID"],
    )
