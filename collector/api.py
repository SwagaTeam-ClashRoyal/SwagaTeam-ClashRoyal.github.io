import json
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    pass


class ClashRoyaleClient:
    def __init__(self, token, base_url, timeout=30):
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def clan(self, tag):
        return self._get(f"/clans/{self._encode(tag)}")

    def current_river_race(self, tag):
        return self._get(f"/clans/{self._encode(tag)}/currentriverrace")

    def river_race_log(self, tag):
        return self._get(f"/clans/{self._encode(tag)}/riverracelog")

    def player(self, tag):
        return self._get(f"/players/{self._encode(tag)}")

    @staticmethod
    def _encode(tag):
        return urllib.parse.quote(tag.upper(), safe="")

    def _get(self, path):
        request = urllib.request.Request(
            self._base_url + path,
            headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ApiError(f"{path} returned HTTP {error.code}: {self._reason(error)}") from None
        except urllib.error.URLError as error:
            raise ApiError(f"{path} failed: {error.reason}") from None

    @staticmethod
    def _reason(error):
        try:
            body = json.load(error)
        except (ValueError, OSError):
            return "no details"
        return body.get("message") or body.get("reason") or "no details"
