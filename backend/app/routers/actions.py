"""Human-in-the-loop action approvals (Phase 3 canonical path).

The V2 pending_actions router remains the implementation; this module is the
Phase 3 layout name (routers/actions.py) re-exporting it so both
/api/actions/* (new) and /pending-actions (V2) serve approvals.
"""
from __future__ import annotations

from .pending_actions import router  # noqa: F401
