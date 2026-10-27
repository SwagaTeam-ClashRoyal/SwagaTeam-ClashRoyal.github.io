from .api import ApiError


class PlayerProfiles:
    PATH = "current/players.json"
    FIELDS = (
        "expLevel",
        "trophies",
        "bestTrophies",
        "wins",
        "losses",
        "battleCount",
        "threeCrownWins",
        "warDayWins",
        "clanCardsCollected",
        "totalDonations",
        "currentPathOfLegendSeasonResult",
        "lastPathOfLegendSeasonResult",
        "bestPathOfLegendSeasonResult",
    )

    def __init__(self, store, client):
        self._store = store
        self._client = client

    def update(self, members):
        players = {}
        for member in members:
            try:
                profile = self._client.player(member["tag"])
            except ApiError as error:
                print(f"Skipped player {member['tag']}: {error}")
                continue
            players[member["tag"]] = self._compact(profile)
        self._store.write(self.PATH, players)
        return players

    def _compact(self, profile):
        data = {field: profile[field] for field in self.FIELDS if field in profile}
        data["currentDeck"] = [self._card(card) for card in profile.get("currentDeck", [])]
        favourite = profile.get("currentFavouriteCard")
        if favourite:
            data["currentFavouriteCard"] = self._card(favourite)
        return data

    @staticmethod
    def _card(card):
        icons = card.get("iconUrls", {})
        evolved = card.get("evolutionLevel", 0) > 0
        return {
            "name": card.get("name"),
            "rarity": card.get("rarity"),
            "elixirCost": card.get("elixirCost"),
            "evolved": evolved,
            "icon": icons.get("evolutionMedium") if evolved and "evolutionMedium" in icons else icons.get("medium"),
        }
