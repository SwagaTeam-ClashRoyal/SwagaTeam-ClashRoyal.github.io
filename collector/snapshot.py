from .api import ApiError


class DailySnapshot:
    DIRECTORY = "history/snapshots"
    PLAYER_FIELDS = (
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

    def save_if_missing(self, date, clan):
        relative = f"{self.DIRECTORY}/{date}.json"
        if self._store.exists(relative):
            return False
        members = clan.get("memberList", [])
        self._store.write(relative, {
            "date": date,
            "clan": {key: value for key, value in clan.items() if key != "memberList"},
            "members": members,
            "players": self._players(members),
        })
        return True

    def _players(self, members):
        players = {}
        for member in members:
            try:
                profile = self._client.player(member["tag"])
            except ApiError as error:
                print(f"Skipped player {member['tag']}: {error}")
                continue
            players[member["tag"]] = {field: profile[field] for field in self.PLAYER_FIELDS if field in profile}
        return players
