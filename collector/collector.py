from datetime import datetime, timezone

from .badge import ClanBadge
from .cards import CardLevels
from .events import Anniversaries, ClanEvents, EventLog, WarWeekEvents
from .players import PlayerProfiles
from .ranking_history import RankingHistory
from .rankings import ClanRankings
from .registry import MemberRegistry
from .river_races import RiverRaceArchive
from .snapshot import DailySnapshot


class Collector:
    CLAN_PATH = "current/clan.json"

    def __init__(self, client, store, clan_tag, notifier=None):
        self._client = client
        self._store = store
        self._clan_tag = clan_tag
        self._notifier = notifier

    def run(self, now=None):
        now = now or datetime.now(timezone.utc)
        stamp = now.isoformat(timespec="seconds")
        profiles_store = PlayerProfiles(self._store, self._client)
        card_levels = CardLevels(self._store)
        before = {
            "members": self._store.read(self.CLAN_PATH, {}).get("memberList", []),
            "players": profiles_store.previous(),
            "cards": card_levels.previous(),
        }
        clan = self._client.clan(self._clan_tag)
        river_race = self._client.current_river_race(self._clan_tag)
        log = self._client.river_race_log(self._clan_tag)
        self._store.write(self.CLAN_PATH, clan)
        self._store.write("current/river_race.json", river_race)
        members = MemberRegistry(self._store).update(clan.get("memberList", []), stamp)
        archived = RiverRaceArchive(self._store, self._clan_tag).update(log)
        profiles = profiles_store.fetch(clan.get("memberList", []))
        players = profiles_store.update(profiles)
        cards = card_levels.update(profiles)
        snapshot = DailySnapshot(self._store).save_if_missing(now.date().isoformat(), clan, players)
        rankings = ClanRankings(self._store, self._client, self._clan_tag).update(clan)
        RankingHistory(self._store).record(now.date().isoformat(), clan, rankings)
        after = {"members": clan.get("memberList", []), "players": players, "cards": cards}
        event_log = EventLog(self._store)
        events = (
            ClanEvents().detect(before, after)
            + WarWeekEvents().detect(archived)
            + Anniversaries().detect(self._store.read(MemberRegistry.PATH, {}), now, event_log.read())
        )
        logged = event_log.append(stamp, events)
        badge = ClanBadge(self._store).update(clan)
        if self._notifier:
            self._notifier.notify(now, river_race, archived)
        self._store.write("current/meta.json", {"clan_tag": self._clan_tag, "updated_at": stamp})
        print(f"Members in clan: {members}")
        print(f"New river races archived: {len(archived)}")
        print(f"Daily snapshot created: {'yes' if snapshot else 'no'}")
        print(f"Rankings: {rankings}")
        print(f"Events logged: {logged}")
        print(f"Badge: {badge.get('name')} {badge.get('league')}")
