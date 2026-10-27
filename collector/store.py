import json
from pathlib import Path


class JsonStore:
    def __init__(self, root):
        self._root = Path(root)

    def exists(self, relative):
        return (self._root / relative).exists()

    def read(self, relative, default=None):
        path = self._root / relative
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def write(self, relative, data):
        path = self._root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
