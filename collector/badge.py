import json
import urllib.error
import urllib.request


class ClanBadge:
    PATH = "current/badge.json"
    IMAGE = "current/badge.png"
    CATALOG_URL = "https://raw.githubusercontent.com/RoyaleAPI/cr-api-data/master/docs/json/alliance_badges.json"
    IMAGE_URL = "https://cdn.royaleapi.com/static/img/badge/{league}/{name}.png"
    LEAGUES = (
        (5000, "legendary-3", "Легендарная лига III"),
        (4000, "legendary-2", "Легендарная лига II"),
        (3000, "legendary-1", "Легендарная лига I"),
        (2500, "gold-3", "Золотая лига III"),
        (2000, "gold-2", "Золотая лига II"),
        (1500, "gold-1", "Золотая лига I"),
        (1000, "silver-3", "Серебряная лига III"),
        (800, "silver-2", "Серебряная лига II"),
        (600, "silver-1", "Серебряная лига I"),
        (400, "bronze-3", "Бронзовая лига III"),
        (200, "bronze-2", "Бронзовая лига II"),
        (0, "bronze-1", "Бронзовая лига I"),
    )

    def __init__(self, store, timeout=30):
        self._store = store
        self._timeout = timeout

    def update(self, clan):
        previous = self._store.read(self.PATH, {})
        trophies = clan.get("clanWarTrophies", 0)
        league, title = next((key, name) for minimum, key, name in self.LEAGUES if trophies >= minimum)
        badge = {"id": clan.get("badgeId"), "name": previous.get("name"), "league": league, "league_title": title}
        try:
            if badge["id"] != previous.get("id") or not badge["name"]:
                badge["name"] = self._name(badge["id"])
            if (badge["name"], league) != (previous.get("name"), previous.get("league")) or not self._store.exists(self.IMAGE):
                self._store.write_bytes(self.IMAGE, self._download(self.IMAGE_URL.format(league=league, name=badge["name"])))
        except (urllib.error.URLError, ValueError, StopIteration) as error:
            print(f"Badge not updated: {error}")
            return previous
        self._store.write(self.PATH, badge)
        return badge

    def _name(self, badge_id):
        catalog = json.loads(self._download(self.CATALOG_URL))
        return next(entry["name"] for entry in catalog if entry["id"] == badge_id)

    def _download(self, url):
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; SwagaTeamCollector/1.0)"})
        with urllib.request.urlopen(request, timeout=self._timeout) as response:
            return response.read()
