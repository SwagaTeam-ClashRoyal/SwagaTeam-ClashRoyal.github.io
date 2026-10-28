import html
import json
import urllib.error
import urllib.request
from datetime import timedelta


class TelegramClient:
    def __init__(self, token, chat_id, timeout=30):
        self._url = f"https://api.telegram.org/bot{token}/sendMessage"
        self._chat_id = chat_id
        self._timeout = timeout

    def send(self, text):
        payload = {
            "chat_id": self._chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout):
                return True
        except urllib.error.HTTPError as error:
            print(f"Telegram returned HTTP {error.code}")
        except urllib.error.URLError as error:
            print(f"Telegram failed: {error.reason}")
        return False


class WarDay:
    RESET = timedelta(hours=9, minutes=35)
    BATTLE_TYPES = ("warDay", "colosseum")

    def __init__(self, river_race, now):
        self._race = river_race
        self._now = now

    @property
    def index(self):
        return self._race.get("periodIndex", 0)

    @property
    def offset(self):
        return self.index % 7

    @property
    def training(self):
        return self._race.get("periodType") == "training"

    @property
    def battle(self):
        return self._race.get("periodType") in self.BATTLE_TYPES

    @property
    def start(self):
        return (self._now - self.RESET).date() - timedelta(days=self.offset)

    @property
    def colosseum(self):
        return self._race.get("periodType") == "colosseum" or (self.start + timedelta(days=7)).day <= 7

    @property
    def key(self):
        return f"{self.start.isoformat()}/{self.index}"

    @property
    def hours_left(self):
        moment = self._now - self.RESET
        end = moment.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        return (end - moment).total_seconds() / 3600


class WarMessages:
    SITE = "https://swagateam-clashroyal.github.io/"
    TOP = 5
    DECKS = 4

    def defense(self):
        return (
            "<b>Поставьте защиту на корабль</b>\n"
            "Начались дни тренировки, защиту уже можно ставить. "
            "В четверг начнутся боевые дни."
        )

    def battle(self, hours, place, own, leader, players):
        lines = [
            f"<b>До конца боевого дня около {round(hours)} ч</b>",
            f"Мы на {place} месте: {self.number(own)} медалей, у лидера {self.number(leader)}.",
            "",
            "Ещё не отыграли:",
        ]
        lines += [f"{self.player(player)}: {player.get('decksUsedToday', 0)} из {self.DECKS}" for player in players]
        return "\n".join(lines)

    def results(self, race):
        lines = [
            f"<b>Итоги КВ: сезон {race['season_id']}, неделя {race['section_index'] + 1}</b>",
            f"{race['rank']} место, {self.number(race['fame'])} медалей, кубки КВ {self.signed(race.get('trophy_change', 0))}",
        ]
        fighters = sorted(race.get("participants", []), key=lambda participant: -participant.get("fame", 0))
        fighters = [fighter for fighter in fighters if fighter.get("fame", 0) > 0][: self.TOP]
        if fighters:
            lines += ["", "Лучшие бойцы:"]
            lines += [f"{place}. {self.player(fighter)}: {self.number(fighter['fame'])}" for place, fighter in enumerate(fighters, 1)]
        lines += ["", f'<a href="{self.SITE}#war">Вся статистика на сайте</a>']
        return "\n".join(lines)

    def player(self, fighter):
        return f'<a href="{self.SITE}#player/{fighter["tag"].replace("#", "")}">{html.escape(fighter["name"])}</a>'

    @staticmethod
    def number(value):
        return f"{value:,}".replace(",", " ")

    @classmethod
    def signed(cls, value):
        return f"+{cls.number(value)}" if value > 0 else cls.number(value)


class BattleStanding:
    FINISH = 10000

    def __init__(self, river_race, clan, messages):
        self._race = river_race
        self._clan = clan
        self._messages = messages

    @property
    def clans(self):
        return sorted(self._race.get("clans", []), key=lambda entry: -entry.get("fame", 0))

    @property
    def own(self):
        return self._race.get("clan", {})

    @property
    def place(self):
        own = self.own.get("fame", 0)
        return 1 + sum(1 for entry in self.clans if entry.get("tag") != self.own.get("tag") and entry.get("fame", 0) > own)

    @property
    def lagging(self):
        return self.place > 1 and (self._race.get("periodType") == "colosseum" or self.own.get("fame", 0) < self.FINISH)

    @property
    def idle(self):
        members = {member["tag"] for member in self._clan.get("memberList", [])}
        players = [player for player in self.own.get("participants", []) if player["tag"] in members]
        players = [player for player in players if player.get("decksUsedToday", 0) < self._messages.DECKS]
        return sorted(players, key=lambda player: (player.get("decksUsedToday", 0), player["name"].lower()))

    def message(self, hours):
        leader = self.clans[0].get("fame", 0) if self.clans else 0
        return self._messages.battle(hours, self.place, self.own.get("fame", 0), leader, self.idle)


class TelegramNotifier:
    PATH = "current/telegram.json"
    BATTLE_HOURS = 5

    def __init__(self, store, client, messages=None):
        self._store = store
        self._client = client
        self._messages = messages or WarMessages()

    def notify(self, now, clan, river_race, archived):
        state = self._store.read(self.PATH, {})
        for race in archived:
            self._client.send(self._messages.results(race))
        day = WarDay(river_race, now)
        if day.training and day.offset == 0 and not day.colosseum:
            self._once(state, "defense", day.key, self._messages.defense())
        if day.battle and day.hours_left <= self.BATTLE_HOURS:
            standing = BattleStanding(river_race, clan, self._messages)
            if standing.lagging and standing.idle:
                self._once(state, "battle", day.key, standing.message(day.hours_left))

    def preview(self, now, clan, river_race, races):
        self._client.send(self._messages.defense())
        self._client.send(BattleStanding(river_race, clan, self._messages).message(WarDay(river_race, now).hours_left))
        if races:
            self._client.send(self._messages.results(races[-1]))

    def _once(self, state, kind, key, text):
        if state.get(kind) == key:
            return
        if self._client.send(text):
            state[kind] = key
            self._store.write(self.PATH, state)
