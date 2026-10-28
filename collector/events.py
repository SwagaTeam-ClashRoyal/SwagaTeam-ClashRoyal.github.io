class ClanEvents:
    ROLE_ORDER = {"member": 0, "elder": 1, "coLeader": 2, "leader": 3}
    TROPHY_STEP = 1000

    def detect(self, before, after):
        events = []
        old_members = {member["tag"]: member for member in before.get("members", [])}
        new_members = {member["tag"]: member for member in after.get("members", [])}
        if not old_members:
            return events
        for tag, member in new_members.items():
            old = old_members.get(tag)
            if old is None:
                events.append(self._event("joined", member))
                continue
            events.extend(self._membership(old, member))
            events.extend(self._profile(member, before.get("players", {}).get(tag), after.get("players", {}).get(tag)))
            events.extend(self._cards(member, before.get("cards", {}).get(tag), after.get("cards", {}).get(tag)))
        for tag, member in old_members.items():
            if tag not in new_members:
                events.append(self._event("left", member))
        return events

    def _membership(self, old, new):
        events = []
        if old["role"] != new["role"]:
            rising = self.ROLE_ORDER.get(new["role"], 0) > self.ROLE_ORDER.get(old["role"], 0)
            events.append(self._event("promoted" if rising else "demoted", new, role=new["role"], previous=old["role"]))
        old_arena = (old.get("arena") or {}).get("id")
        new_arena = new.get("arena") or {}
        if old_arena and new_arena.get("id", 0) > old_arena:
            events.append(self._event("arena", new, arena=new_arena.get("name"), raw=new_arena.get("rawName")))
        return events

    def _profile(self, member, old, new):
        if not old or not new:
            return []
        events = []
        old_best = old.get("bestTrophies", 0) // self.TROPHY_STEP
        new_best = new.get("bestTrophies", 0) // self.TROPHY_STEP
        if new_best > old_best and old_best > 0:
            events.append(self._event("trophies", member, value=new_best * self.TROPHY_STEP))
        if new.get("expLevel", 0) > old.get("expLevel", 0) > 0:
            events.append(self._event("king_level", member, level=new["expLevel"]))
        old_league = (old.get("currentPathOfLegendSeasonResult") or {}).get("leagueNumber") or 0
        new_league = (new.get("currentPathOfLegendSeasonResult") or {}).get("leagueNumber") or 0
        if new_league > old_league > 0:
            events.append(self._event("league", member, league=new_league))
        return events

    def _cards(self, member, old, new):
        if not old or not new:
            return []
        upgraded = []
        evolved = []
        unlocked = []
        for name, (level, evolution) in new.items():
            if name not in old:
                unlocked.append(name)
                continue
            old_level, old_evolution = old[name]
            if level > old_level:
                upgraded.append({"name": name, "level": level})
            if evolution > 0 and old_evolution == 0:
                evolved.append(name)
        events = []
        if upgraded:
            upgraded.sort(key=lambda card: -card["level"])
            events.append(self._event("cards", member, cards=upgraded))
        if evolved:
            events.append(self._event("evolution", member, cards=evolved))
        if unlocked:
            events.append(self._event("unlocked", member, cards=unlocked))
        return events

    @staticmethod
    def _event(kind, member, **details):
        return {"type": kind, "tag": member["tag"], "name": member["name"], **details}


class WarWeekEvents:
    def detect(self, races):
        events = []
        for race in races:
            best = max(race.get("participants", []), key=lambda participant: participant.get("fame", 0), default=None)
            event = {
                "type": "war_week",
                "at": race.get("created_date"),
                "season": race["season_id"],
                "week": race["section_index"] + 1,
                "rank": race["rank"],
                "fame": race["fame"],
                "trophy_change": race.get("trophy_change", 0),
            }
            if best and best.get("fame", 0) > 0:
                event["best"] = {"tag": best["tag"], "name": best["name"], "fame": best["fame"]}
            events.append(event)
        return events


class EventLog:
    PATH = "history/events.json"
    LIMIT = 2000

    def __init__(self, store):
        self._store = store

    def append(self, stamp, events):
        if not events:
            return 0
        log = self._store.read(self.PATH, [])
        log.extend({**event, "at": self.moment(event.get("at") or stamp)} for event in events)
        log.sort(key=lambda event: event["at"])
        self._store.write(self.PATH, log[-self.LIMIT:])
        return len(events)

    @staticmethod
    def moment(value):
        if value and len(value) >= 15 and value[8] == "T" and "-" not in value[:8]:
            return f"{value[:4]}-{value[4:6]}-{value[6:8]}T{value[9:11]}:{value[11:13]}:{value[13:15]}+00:00"
        return value
