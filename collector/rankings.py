from .api import ApiError


class ClanRankings:
    PATH = "current/rankings.json"
    BOARDS = {"trophies": "clans", "war": "clanwars"}

    def __init__(self, store, client, clan_tag):
        self._store = store
        self._client = client
        self._clan_tag = clan_tag.upper()

    def update(self, clan):
        location = clan.get("location", {})
        scopes = {"global": "global", "local": location.get("id")}
        result = {"location": location.get("name")}
        for scope, location_id in scopes.items():
            if location_id is None:
                continue
            result[scope] = {board: self._rank(location_id, path) for board, path in self.BOARDS.items()}
        self._store.write(self.PATH, result)
        return result

    def _rank(self, location_id, board):
        try:
            items = self._client.clan_rankings(location_id, board).get("items", [])
        except ApiError as error:
            print(f"Skipped ranking {location_id}/{board}: {error}")
            return None
        rank = next((item["rank"] for item in items if item["tag"].upper() == self._clan_tag), None)
        return {"rank": rank, "size": len(items), "cutoff": items[-1].get("clanScore") if items else None}
