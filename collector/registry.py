class MemberRegistry:
    PATH = "members.json"
    COUNTERS = {"donations": "donations", "donations_received": "donationsReceived"}

    def __init__(self, store):
        self._store = store
        self._members = store.read(self.PATH, {})

    def update(self, clan_members, now):
        present = set()
        for member in clan_members:
            tag = member["tag"]
            present.add(tag)
            record = self._members.setdefault(tag, self._new_record(now))
            record["name"] = member["name"]
            record["role"] = member["role"]
            record["in_clan"] = True
            record["last_seen_in_clan"] = now
            for key, field in self.COUNTERS.items():
                self._accumulate(record[key], member.get(field, 0), now)
        for tag, record in self._members.items():
            if tag not in present:
                record["in_clan"] = False
        self._store.write(self.PATH, self._members)
        return len(present)

    def _new_record(self, now):
        record = {"first_seen": now}
        for key in self.COUNTERS:
            record[key] = {"closed": 0, "current": 0}
        return record

    @staticmethod
    def _accumulate(counter, value, now):
        if value < counter["current"]:
            counter["closed"] += counter["current"]
            counter.setdefault("weeks", []).append({"closed_at": now, "value": counter["current"]})
        counter["current"] = value
