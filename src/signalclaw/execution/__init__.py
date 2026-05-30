"""Execution-layer simulation: child-order slicing across an intraday session.

Models VWAP, TWAP, and Percent-of-Volume schedules with per-slice slippage,
participation caps, and realized vs benchmark price attribution. Pure-Python,
deterministic, no market-data dependency.
"""
from .router import (
    IntradayBar,
    SessionVolumeCurve,
    ParentOrder,
    ChildFill,
    ExecutionReport,
    SliceSchedule,
    ScheduleKind,
    simulate_execution,
    build_uniform_curve,
    build_u_shape_curve,
)

__all__ = [
    "IntradayBar",
    "SessionVolumeCurve",
    "ParentOrder",
    "ChildFill",
    "ExecutionReport",
    "SliceSchedule",
    "ScheduleKind",
    "simulate_execution",
    "build_uniform_curve",
    "build_u_shape_curve",
]
