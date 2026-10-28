import os
import sys
from datetime import datetime, timezone

from .api import ApiError, ClashRoyaleClient
from .collector import Collector
from .river_races import RiverRaceArchive
from .store import JsonStore
from .telegram import TelegramClient, TelegramNotifier


class Application:
    DEFAULT_BASE_URL = "https://proxy.royaleapi.dev/v1"
    DEFAULT_CLAN_TAG = "#QVQUPC8Q"

    def run(self):
        token = os.environ.get("CR_API_KEY")
        if not token:
            sys.exit("CR_API_KEY is not set")
        client = ClashRoyaleClient(token, os.environ.get("CR_API_BASE_URL", self.DEFAULT_BASE_URL))
        store = JsonStore(os.environ.get("DATA_DIR", "data"))
        notifier = self.notifier(store)
        try:
            Collector(client, store, os.environ.get("CLAN_TAG", self.DEFAULT_CLAN_TAG), notifier).run()
        except ApiError as error:
            sys.exit(f"API error: {error}")
        if notifier and os.environ.get("TELEGRAM_PREVIEW") == "true":
            notifier.preview(datetime.now(timezone.utc), store.read(Collector.CLAN_PATH, {}), store.read("current/river_race.json", {}), self.races(store))

    @staticmethod
    def notifier(store):
        token = os.environ.get("TELEGRAM_BOT_TOKEN")
        chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        if not token or not chat_id:
            print("Telegram is not configured")
            return None
        return TelegramNotifier(store, TelegramClient(token, chat_id))

    @staticmethod
    def races(store):
        names = [name for name in store.list(RiverRaceArchive.DIRECTORY) if name != "index.json"]
        return [store.read(f"{RiverRaceArchive.DIRECTORY}/{name}") for name in names]


Application().run()
