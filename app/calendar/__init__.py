"""Calendar integration for the voice agent.

As of Phase 2, calendar operations route through Vercel via the HMAC
agent client. Railway never holds Google OAuth tokens.

The legacy direct-Google modules (`client`, `availability`, `atomic`) are
deprecated and no longer imported here. They remain on disk for reference
and will be deleted in a future cleanup PR.
"""

from app.calendar.agent_client import (
    AgentApiError,
    check_availability,
    create_booking,
)

__all__ = ["AgentApiError", "check_availability", "create_booking"]
