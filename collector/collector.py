from datetime import datetime, timezone

from .players import PlayerProfiles
from .rankings import ClanRankings
from .registry import MemberRegistry
from .river_races import RiverRaceArchive
from .snapshot import DailySnapshot


class Collector:
    def __init__(self, client, store, clan_tag):
        self._client = client
        self._store = store
        self._clan_tag = clan_tag

    def run(self, now=None):
        now = now or datetime.now(timezone.utc)
        stamp = now.isoformat(timespec="seconds")
        clan = self._client.clan(self._clan_tag)
        river_race = self._client.current_river_race(self._clan_tag)
        log = self._client.river_race_log(self._clan_tag)
        self._store.write("current/clan.json", clan)
        self._store.write("current/river_race.json", river_race)
        members = MemberRegistry(self._store).update(clan.get("memberList", []), stamp)
        archived = RiverRaceArchive(self._store, self._clan_tag).update(log)
        players = PlayerProfiles(self._store, self._client).update(clan.get("memberList", []))
        snapshot = DailySnapshot(self._store).save_if_missing(now.date().isoformat(), clan, players)
        rankings = ClanRankings(self._store, self._client, self._clan_tag).update(clan)
        self._store.write("current/meta.json", {"clan_tag": self._clan_tag, "updated_at": stamp})
        print(f"Members in clan: {members}")
        print(f"New river races archived: {archived}")
        print(f"Daily snapshot created: {'yes' if snapshot else 'no'}")
        print(f"Rankings: {rankings}")
