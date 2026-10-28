class CardLevels:
    PATH = "current/cards.json"

    def __init__(self, store):
        self._store = store

    def previous(self):
        return self._store.read(self.PATH, {})

    def update(self, profiles):
        levels = {**self.previous()}
        for tag, profile in profiles.items():
            cards = profile.get("cards", [])
            if cards:
                levels[tag] = self._levels(cards)
        self._store.write(self.PATH, levels)
        return levels

    @staticmethod
    def _levels(cards):
        top = max(card.get("maxLevel", 0) for card in cards)
        return {
            card["name"]: [card.get("level", 0) + top - card.get("maxLevel", top), card.get("evolutionLevel", 0)]
            for card in cards
            if "name" in card
        }
