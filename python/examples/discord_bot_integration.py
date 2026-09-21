"""Gating premium features in a Discord bot.

VectoBeat is licensed per guild, not per device: the bot runs on one server and
serves thousands of guilds, so the question is never "may this computer run?"
but "is this guild premium?".

That makes it the one case where the device half of the library is not used at
all. What is used is the entitlement lookup, and the rule that comes with it:
``verify_subject`` answers **for an unlicensed guild too**, with the free tier's
name and features. A freemium product asks for every guild, and "no premium" is
a valid answer rather than an error - so there is one code path here, not two.

Runnable: it talks to a stand-in server at the bottom of the file rather than to
a real one, because an example that cannot be executed is an example nobody
notices has rotted. ``discord`` is a peer of the host application and is not
imported.
"""

from __future__ import annotations

import time
from typing import Any

from uplytech_license import (
    ApiError,
    EntitlementResult,
    FeatureIndex,
    LicenseClient,
    MemoryStorage,
    NetworkError,
)

API_BASE_URL = "http://localhost:8000"
API_KEY = "utk_..."  # from `uplytech` - a machine-to-machine key, scope read

#: How long an answer is trusted. Long enough that a busy bot does not ask per
#: command, short enough that somebody who just paid does not wait for lunch.
CACHE_SECONDS = 300


#: What a guild gets when the licence server cannot be reached and nothing has
#: been cached for it. Written out rather than left empty: a bot that answers
#: "no" to everything during an outage is indistinguishable, to its users, from
#: a bot that is broken.
FREE_TIER = EntitlementResult(licensed=False, tier="free", features=("playback", "queue"))


class Entitlements:
    """Per-guild premium lookup with a small in-memory cache.

    Only the entitlement half of the client is used: there is no device, no seat
    and no offline window here. The bot is the licensed installation, and it is
    online by definition - which is why the storage below is a
    :class:`MemoryStorage` that never holds anything.
    """

    def __init__(self, product_slug: str = "vectobeat", send: Any = None) -> None:
        self.product_slug = product_slug
        self._client = LicenseClient(
            api_base_url=API_BASE_URL,
            product_slug=product_slug,
            app_version="1.4.0",
            public_keys={},
            storage=MemoryStorage(),
            send=send,
        )
        self._cache: dict[str, tuple[float, EntitlementResult, FeatureIndex]] = {}

    def for_guild(self, guild_id: str) -> EntitlementResult:
        cached = self._cache.get(guild_id)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]

        try:
            answer = self._client.verify_subject(
                API_KEY, {"type": "discord_guild", "ref": guild_id}
            )
        except (NetworkError, ApiError):
            # The licence server being down must not take the bot's free tier
            # with it. A stale answer is better than no music; no answer at all
            # falls back to free.
            if cached:
                return cached[1]
            return FREE_TIER

        # The index is built once per answer rather than per command: a busy
        # guild asks this hundreds of times between two lookups.
        self._cache[guild_id] = (time.monotonic(), answer, FeatureIndex(answer.features))
        return answer

    def has(self, guild_id: str, feature: str) -> bool:
        self.for_guild(guild_id)
        cached = self._cache.get(guild_id)
        if cached is None:
            return FeatureIndex(FREE_TIER.features).has(feature)
        return cached[2].has(feature)

    def forget(self, guild_id: str) -> None:
        """Drop the cached answer - call this from the payment webhook.

        Without it a guild that just upgraded waits up to five minutes for its
        premium features, which is exactly the five minutes somebody spends
        writing to support.
        """
        self._cache.pop(guild_id, None)


entitlements = Entitlements()


# -----------------------------------------------------------------------------
# What it looks like at the call site
# -----------------------------------------------------------------------------


def command_filters(guild_id: str, filter_name: str) -> str:
    if not entitlements.has(guild_id, "filters"):
        # Naming the tier beats "not allowed": the person asking is a potential
        # customer, and this is the moment they find out what premium is for.
        return "Audio-Filter gehören zu VectoBeat Premium. /premium zeigt, was dazugehört."
    return f"Filter {filter_name} aktiviert."


def command_247(guild_id: str) -> str:
    if not entitlements.has(guild_id, "247"):
        return "Dauerbetrieb gehört zu VectoBeat Premium."
    return "Der Bot bleibt jetzt dauerhaft im Sprachkanal."


def on_payment_succeeded(guild_id: str) -> None:
    """Webhook handler. The licence exists the moment the payment lands."""
    entitlements.forget(guild_id)


# -----------------------------------------------------------------------------
# Runnable, against a stand-in server
# -----------------------------------------------------------------------------


def _stand_in_server(
    _method: str, url: str, _body: bytes | None, _headers: dict[str, str], _timeout: float
) -> tuple[int, str, dict[str, str]]:
    """One licensed guild, everything else on the free tier."""
    import json

    licensed = "subject_ref=1" in url and "subject_ref=11" not in url
    return (
        200,
        json.dumps(
            {
                "licensed": licensed,
                "tier": "premium" if licensed else "free",
                "features": ["playback", "queue", "filters", "247"]
                if licensed
                else ["playback", "queue"],
                "license_id": "lic_demo" if licensed else None,
                "expires_at": None,
                "subject": {"type": "discord_guild", "ref": "1"},
            }
        ),
        {},
    )


if __name__ == "__main__":
    entitlements = Entitlements(send=_stand_in_server)

    for guild in ("1", "11"):
        print(f"guild {guild}: {entitlements.for_guild(guild).tier}")
        print("  ", command_filters(guild, "bassboost"))
        print("  ", command_247(guild))

    # The second round comes out of the cache: one lookup per guild, not one
    # per command.
    entitlements.for_guild("1")
