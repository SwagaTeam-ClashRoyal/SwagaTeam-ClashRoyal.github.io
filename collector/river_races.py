class RiverRaceArchive:
    DIRECTORY = "history/river_races"

    def __init__(self, store, clan_tag):
        self._store = store
        self._clan_tag = clan_tag.upper()

    def update(self, log):
        added = 0
        for race in log.get("items", []):
            relative = f"{self.DIRECTORY}/{race['seasonId']:03d}-{race['sectionIndex']:02d}.json"
            if self._store.exists(relative):
                continue
            self._store.write(relative, self._compact(race))
            added += 1
        return added

    def _compact(self, race):
        standings = race.get("standings", [])
        own = next(s for s in standings if s["clan"]["tag"].upper() == self._clan_tag)
        return {
            "season_id": race["seasonId"],
            "section_index": race["sectionIndex"],
            "created_date": race.get("createdDate"),
            "rank": own["rank"],
            "trophy_change": own.get("trophyChange", 0),
            "fame": own["clan"].get("fame", 0),
            "participants": own["clan"].get("participants", []),
            "standings": [self._standing(s) for s in standings],
        }

    @staticmethod
    def _standing(standing):
        return {
            "rank": standing["rank"],
            "tag": standing["clan"]["tag"],
            "name": standing["clan"]["name"],
            "fame": standing["clan"].get("fame", 0),
            "trophy_change": standing.get("trophyChange", 0),
        }
