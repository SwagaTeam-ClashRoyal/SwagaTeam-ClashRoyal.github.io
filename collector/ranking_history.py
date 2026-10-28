class RankingHistory:
    PATH = "history/rankings.json"
    SCOPES = ("global", "local")
    BOARDS = ("trophies", "war")

    def __init__(self, store):
        self._store = store

    def record(self, date, clan, rankings):
        history = [entry for entry in self._store.read(self.PATH, []) if entry["date"] != date]
        history.append(self.entry(date, clan, rankings))
        history.sort(key=lambda entry: entry["date"])
        self._store.write(self.PATH, history)
        return len(history)

    @classmethod
    def entry(cls, date, clan, rankings):
        entry = {"date": date, "score": {"trophies": clan.get("clanScore"), "war": clan.get("clanWarTrophies")}}
        for scope in cls.SCOPES:
            boards = rankings.get(scope) or {}
            entry[scope] = {
                board: {"rank": boards[board].get("rank"), "cutoff": boards[board].get("cutoff")}
                for board in cls.BOARDS
                if boards.get(board)
            }
        return entry
