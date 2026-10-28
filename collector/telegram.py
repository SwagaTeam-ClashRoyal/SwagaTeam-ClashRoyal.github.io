import html
import json
import urllib.error
import urllib.request


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


class WarMessages:
    SITE = "https://swagateam-clashroyal.github.io/"
    TOP = 5

    def defense(self):
        return (
            "<b>Поставьте защиту на корабль</b>\n"
            "Сегодня последний день тренировки, завтра начинаются боевые дни КВ. "
            "Пока идёт тренировка, защиту ещё можно поменять."
        )

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


class TelegramNotifier:
    PATH = "current/telegram.json"
    LAST_TRAINING_DAY = 2
    DEFENSE_HOUR = 14

    def __init__(self, store, client, messages=None):
        self._store = store
        self._client = client
        self._messages = messages or WarMessages()

    def notify(self, now, river_race, archived):
        state = self._store.read(self.PATH, {})
        for race in archived:
            self._client.send(self._messages.results(race))
        week = now.strftime("%G-W%V")
        if self._defense_due(now, river_race) and state.get("defense") != week:
            if self._client.send(self._messages.defense()):
                state["defense"] = week
                self._store.write(self.PATH, state)

    def preview(self, races):
        self._client.send(self._messages.defense())
        if races:
            self._client.send(self._messages.results(races[-1]))

    def _defense_due(self, now, river_race):
        return (
            river_race.get("periodType") == "training"
            and river_race.get("periodIndex", 0) % 7 == self.LAST_TRAINING_DAY
            and now.hour >= self.DEFENSE_HOUR
        )
