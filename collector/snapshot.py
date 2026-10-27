class DailySnapshot:
    DIRECTORY = "history/snapshots"

    def __init__(self, store):
        self._store = store

    def save_if_missing(self, date, clan, players):
        relative = f"{self.DIRECTORY}/{date}.json"
        if self._store.exists(relative):
            return False
        self._store.write(relative, {
            "date": date,
            "clan": {key: value for key, value in clan.items() if key != "memberList"},
            "members": clan.get("memberList", []),
            "players": players,
        })
        return True
