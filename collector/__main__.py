import os
import sys

from .api import ApiError, ClashRoyaleClient
from .collector import Collector
from .store import JsonStore


class Application:
    DEFAULT_BASE_URL = "https://proxy.royaleapi.dev/v1"
    DEFAULT_CLAN_TAG = "#QVQUPC8Q"

    def run(self):
        token = os.environ.get("CR_API_KEY")
        if not token:
            sys.exit("CR_API_KEY is not set")
        client = ClashRoyaleClient(token, os.environ.get("CR_API_BASE_URL", self.DEFAULT_BASE_URL))
        store = JsonStore(os.environ.get("DATA_DIR", "data"))
        try:
            Collector(client, store, os.environ.get("CLAN_TAG", self.DEFAULT_CLAN_TAG)).run()
        except ApiError as error:
            sys.exit(f"API error: {error}")


Application().run()
