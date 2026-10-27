class DataSource {
  async load(path) {
    const response = await fetch(`data/${path}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  }

  async loadAll() {
    const [meta, clan, race, members, index, players] = await Promise.all([
      this.load("current/meta.json"),
      this.load("current/clan.json"),
      this.load("current/river_race.json"),
      this.load("members.json"),
      this.load("history/river_races/index.json"),
      this.load("current/players.json").catch(() => ({})),
    ]);
    const [rankings, badge] = await Promise.all([
      this.load("current/rankings.json").catch(() => null),
      this.load("current/badge.json").catch(() => null),
    ]);
    const races = await Promise.all(index.map((name) => this.load(`history/river_races/${name}`)));
    return { meta, clan, race, members, races, players, rankings, badge };
  }
}

class RaceCalendar {
  static DAY = 24 * 60 * 60 * 1000;

  constructor(races, current) {
    this.races = [...races].sort((a, b) => a.season_id - b.season_id || a.section_index - b.section_index);
    this.current = current;
    this.currentSeasonId = this.detectCurrentSeason();
  }

  detectCurrentSeason() {
    const last = this.races.at(-1);
    if (!last) return null;
    return this.current.sectionIndex > last.section_index ? last.season_id : last.season_id + 1;
  }

  seasons() {
    const ids = new Set(this.races.map((race) => race.season_id));
    if (this.currentSeasonId !== null) ids.add(this.currentSeasonId);
    return [...ids].sort((a, b) => b - a);
  }

  racesOf(seasonId) {
    return this.races.filter((race) => race.season_id === seasonId);
  }

  isComplete(seasonId) {
    const races = this.racesOf(seasonId);
    return races.some((race) => race.section_index === 0) && this.seasons()[0] > seasonId;
  }

  warDaysStarted() {
    if (this.current.periodType === "training") return 0;
    return Math.min(4, Math.max(0, (this.current.periodIndex % 7) - 2));
  }

  seasonOf(timestamp) {
    const moment = new Date(timestamp).getTime();
    let nearest = null;
    let distance = Infinity;
    for (const race of this.races) {
      const gap = Math.abs(RaceCalendar.parse(race.created_date) - moment);
      if (gap < distance) {
        nearest = race;
        distance = gap;
      }
    }
    return nearest && distance < 2 * RaceCalendar.DAY ? nearest.season_id : this.currentSeasonId;
  }

  static parse(value) {
    const [, y, m, d, h, min, s] = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    return Date.UTC(y, m - 1, d, h, min, s);
  }
}

class WarRanking {
  static DECKS_PER_DAY = 4;
  static DECKS_PER_WEEK = 16;

  constructor(calendar, names) {
    this.calendar = calendar;
    this.names = names;
  }

  standings(seasonId) {
    const totals = new Map();
    const add = (participant, possible) => {
      const total = totals.get(participant.tag) ?? { tag: participant.tag, name: participant.name, fame: 0, decks: 0, possible: 0 };
      total.fame += participant.fame;
      total.decks += participant.decksUsed;
      total.possible += possible;
      totals.set(participant.tag, total);
    };
    for (const race of this.calendar.racesOf(seasonId)) {
      race.participants.forEach((participant) => add(participant, WarRanking.DECKS_PER_WEEK));
    }
    const days = this.calendar.warDaysStarted();
    if (seasonId === this.calendar.currentSeasonId && days > 0) {
      this.calendar.current.clan.participants.forEach((participant) => add(participant, days * WarRanking.DECKS_PER_DAY));
    }
    return [...totals.values()]
      .filter((total) => total.decks > 0)
      .map((total) => ({
        ...total,
        name: this.names.get(total.tag) ?? total.name,
        score: Math.round((total.fame * total.decks) / total.possible),
      }))
      .sort((a, b) => b.score - a.score || b.fame - a.fame);
  }
}

class DonationRanking {
  constructor(calendar, members) {
    this.calendar = calendar;
    this.members = members;
  }

  standings(seasonId) {
    return Object.entries(this.members)
      .map(([tag, record]) => {
        const weeks = (record.donations.weeks ?? []).filter((week) => this.calendar.seasonOf(week.closed_at) === seasonId);
        const current = seasonId === this.calendar.currentSeasonId && record.in_clan ? record.donations.current : 0;
        return {
          tag,
          name: record.name,
          donations: weeks.reduce((sum, week) => sum + week.value, current),
          weeks: weeks.length + (current > 0 ? 1 : 0),
        };
      })
      .filter((row) => row.donations > 0)
      .sort((a, b) => b.donations - a.donations);
  }
}

class WeeklyHistory {
  constructor(calendar) {
    this.calendar = calendar;
    this.weeks = this.build();
  }

  build() {
    const weeks = this.calendar.races.map((race) => {
      const end = new Date(RaceCalendar.parse(race.created_date));
      return {
        label: WeeklyHistory.short(end),
        title: `Сезон ${race.season_id}, неделя ${race.section_index + 1}, до ${end.toLocaleDateString("ru-RU")}`,
        participants: race.participants,
      };
    });
    if (this.calendar.warDaysStarted() > 0) {
      weeks.push({
        label: "сейчас",
        title: `Сезон ${this.calendar.currentSeasonId}, идущая неделя`,
        participants: this.calendar.current.clan.participants,
      });
    }
    return weeks;
  }

  player(tag, metric) {
    return this.weeks.map((week) => {
      const own = week.participants.find((participant) => participant.tag === tag);
      return {
        label: week.label,
        title: week.title,
        value: own ? own[metric] : null,
        reference: WeeklyHistory.median(week.participants.filter((p) => p.decksUsed > 0).map((p) => p[metric])),
      };
    });
  }

  appearances(tag) {
    return this.weeks
      .map((week) => ({ week, participant: week.participants.find((participant) => participant.tag === tag) }))
      .filter((entry) => entry.participant);
  }

  clan(summarize) {
    return this.weeks.map((week) => ({ label: week.label, title: week.title, value: summarize(week.participants) }));
  }

  static short(date) {
    return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  }

  static median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
}

class DonationHistory {
  constructor(members) {
    this.members = members;
    this.weeks = this.build();
  }

  build() {
    const weeks = new Map();
    for (const [tag, record] of Object.entries(this.members)) {
      for (const week of record.donations.weeks ?? []) {
        const key = week.closed_at.slice(0, 10);
        if (!weeks.has(key)) weeks.set(key, new Map());
        weeks.get(key).set(tag, week.value);
      }
    }
    const current = new Map(
      Object.entries(this.members).filter(([, record]) => record.in_clan).map(([tag, record]) => [tag, record.donations.current]),
    );
    return [
      ...[...weeks.keys()].sort().map((key) => ({
        label: WeeklyHistory.short(new Date(key)),
        title: `Неделя до ${new Date(key).toLocaleDateString("ru-RU")}`,
        values: weeks.get(key),
      })),
      { label: "сейчас", title: "Идущая неделя", values: current },
    ];
  }

  player(tag) {
    return this.weeks.map((week) => ({
      label: week.label,
      title: week.title,
      value: week.values.has(tag) ? week.values.get(tag) : null,
      reference: WeeklyHistory.median([...week.values.values()]),
    }));
  }
}

class Elements {
  static create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  static number(value) {
    return value.toLocaleString("ru-RU");
  }

  static playerLink(tag, name) {
    const link = Elements.create("a", "name", name);
    link.href = `#player/${tag.replace("#", "")}`;
    return link;
  }
}

class Membership {
  constructor(clan) {
    this.tags = new Set(clan.memberList.map((member) => member.tag));
  }

  has(tag) {
    return this.tags.has(tag);
  }

  badge(tag) {
    return this.has(tag)
      ? Elements.create("span", "badge in-clan", "в клане")
      : Elements.create("span", "badge left-clan", "не в клане");
  }
}

class RankingList {
  constructor(membership) {
    this.membership = membership;
  }

  render(rows, describe) {
    if (rows.length === 0) {
      return Elements.create("p", "empty", "Пока нет данных за этот сезон.");
    }
    const list = Elements.create("ol", "ranking");
    rows.forEach((row, index) => {
      const place = index + 1;
      const item = Elements.create("li", place <= 3 ? `row podium place-${place}` : "row");
      const who = Elements.create("div", "who");
      const view = describe(row);
      const line = Elements.create("span", "name-line");
      line.appendChild(Elements.playerLink(row.tag, row.name));
      if (!this.membership.has(row.tag)) line.appendChild(this.membership.badge(row.tag));
      who.append(line, Elements.create("span", "details", view.details));
      item.append(Elements.create("span", "place", place), who, Elements.create("span", "score", view.score));
      list.appendChild(item);
    });
    return list;
  }
}

class SeasonPicker {
  constructor(calendar, onChange) {
    this.calendar = calendar;
    this.onChange = onChange;
  }

  render(selected) {
    const select = Elements.create("select", "season");
    select.setAttribute("aria-label", "Сезон");
    for (const id of this.calendar.seasons()) {
      const option = Elements.create("option", null, this.label(id));
      option.value = id;
      option.selected = id === selected;
      select.appendChild(option);
    }
    select.addEventListener("change", () => this.onChange(Number(select.value)));
    return select;
  }

  label(id) {
    if (id === this.calendar.currentSeasonId) return `Сезон ${id} · идёт`;
    return this.calendar.isComplete(id) ? `Сезон ${id}` : `Сезон ${id} · неполные данные`;
  }
}

class WarTab {
  title = "Бойцы КВ";

  constructor(calendar, ranking, list) {
    this.calendar = calendar;
    this.ranking = ranking;
    this.list = list;
    this.season = calendar.currentSeasonId;
  }

  render(container) {
    const picker = new SeasonPicker(this.calendar, (season) => {
      this.season = season;
      this.render(container);
    });
    container.replaceChildren(
      picker.render(this.season),
      Elements.create("p", "hint", "Очки = медали × доля сыгранных колод. Топ-5 каждого сезона уходит в зал славы."),
      this.list.render(this.ranking.standings(this.season), (row) => ({
        score: Elements.number(row.score),
        details: `${Elements.number(row.fame)} медалей · колоды ${row.decks}/${row.possible}`,
      })),
    );
  }
}

class DonationTab {
  title = "Щедрые";

  constructor(calendar, ranking, list) {
    this.calendar = calendar;
    this.ranking = ranking;
    this.list = list;
    this.season = calendar.currentSeasonId;
  }

  render(container) {
    const picker = new SeasonPicker(this.calendar, (season) => {
      this.season = season;
      this.render(container);
    });
    container.replaceChildren(
      picker.render(this.season),
      Elements.create("p", "hint", "Карты, отданные клану за сезон. Учёт идёт с 27 октября 2026 года."),
      this.list.render(this.ranking.standings(this.season), (row) => ({
        score: Elements.number(row.donations),
        details: `недель с донатом: ${row.weeks}`,
      })),
    );
  }
}

class HallOfFameTab {
  static SIZE = 5;
  title = "Зал славы";

  constructor(calendar, ranking, list) {
    this.calendar = calendar;
    this.ranking = ranking;
    this.list = list;
  }

  render(container) {
    const seasons = this.calendar.seasons().filter((id) => this.calendar.isComplete(id));
    if (seasons.length === 0) {
      container.replaceChildren(Elements.create("p", "empty", "Первые чемпионы появятся после завершения сезона."));
      return;
    }
    container.replaceChildren(
      Elements.create("p", "hint", `Топ-${HallOfFameTab.SIZE} бойцов КВ каждого завершённого сезона.`),
      ...seasons.map((id) => this.season(id)),
    );
  }

  season(id) {
    const card = Elements.create("section", "hall");
    card.appendChild(Elements.create("h2", null, `Сезон ${id}`));
    card.appendChild(this.list.render(this.ranking.standings(id).slice(0, HallOfFameTab.SIZE), (row) => ({
      score: Elements.number(row.score),
      details: `${Elements.number(row.fame)} медалей · колоды ${row.decks}/${row.possible}`,
    })));
    return card;
  }
}

class RosterTab {
  static ROLES = {
    leader: "глава",
    coLeader: "соруководитель",
    elder: "старейшина",
    member: "участник",
  };

  title = "Состав";

  constructor(clan, members, list) {
    this.clan = clan;
    this.members = members;
    this.list = list;
    this.trackingStart = Object.values(members).map((record) => record.first_seen.slice(0, 10)).sort()[0];
  }

  render(container) {
    const rows = [...this.clan.memberList].sort((a, b) => a.clanRank - b.clanRank);
    container.replaceChildren(
      Elements.create("p", "hint", `${this.clan.members} из 50 · кубки КВ клана: ${Elements.number(this.clan.clanWarTrophies)}`),
      this.list.render(rows, (row) => ({
        score: Elements.number(row.trophies),
        details: [RosterTab.ROLES[row.role] ?? row.role, `донат за неделю ${row.donations}`, this.since(row.tag)].filter(Boolean).join(" · "),
      })),
    );
  }

  since(tag) {
    const record = this.members[tag];
    if (!record) return "";
    const format = (date) => new Date(date).toLocaleDateString("ru-RU");
    if (record.joined_precision === "before") return `в клане раньше ${format(record.joined)}`;
    if (record.joined_precision === "approx") return `в клане примерно с ${format(record.joined)}`;
    const date = record.joined ?? (record.first_seen.slice(0, 10) > this.trackingStart ? record.first_seen : null);
    return date ? `в клане с ${format(date)}` : "";
  }
}

class ClanSummary {
  static TYPES = { open: "открытый", inviteOnly: "по приглашению", closed: "закрытый" };
  static RANKING_SIZE = 1000;

  constructor(clan, rankings, badge) {
    this.clan = clan;
    this.rankings = rankings;
    this.badge = badge;
  }

  static badgeUrl(badge) {
    return badge ? `data/current/badge.png?v=${badge.name}-${badge.league}` : null;
  }

  render() {
    const card = Elements.create("section", "profile clan-card");
    const title = Elements.create("div", "clan-title");
    const url = ClanSummary.badgeUrl(this.badge);
    if (url) {
      const image = Elements.create("img", "clan-badge");
      image.src = url;
      image.alt = "Бейдж клана";
      title.appendChild(image);
    }
    const name = Elements.create("div");
    name.append(Elements.create("h2", null, this.clan.name));
    if (this.badge?.league_title) name.append(Elements.create("p", "details", this.badge.league_title));
    title.appendChild(name);
    card.appendChild(title);
    if (this.clan.description) card.appendChild(Elements.create("p", "clan-description", this.clan.description));
    const stats = Elements.create("dl", "stats");
    const add = (term, value) => stats.append(Elements.create("dt", null, term), Elements.create("dd", null, value));
    add("Кубки клана", Elements.number(this.clan.clanScore));
    add("Кубки КВ", Elements.number(this.clan.clanWarTrophies));
    add("Участников", `${this.clan.members} из 50`);
    add("Донат за неделю", Elements.number(this.clan.donationsPerWeek));
    add("Вход", `от ${Elements.number(this.clan.requiredTrophies)} кубков, ${ClanSummary.TYPES[this.clan.type] ?? this.clan.type}`);
    if (this.clan.location?.name) add("Страна", this.clan.location.name === "Russia" ? "Россия" : this.clan.location.name);
    card.appendChild(stats);
    if (this.rankings) card.append(Elements.create("h3", "subheading", "Место в рейтингах"), this.rankingList());
    return card;
  }

  rankingList() {
    const stats = Elements.create("dl", "stats");
    const local = this.clan.location?.name === "Russia" ? "Россия" : this.rankings.location;
    const boards = [
      ["Мир, кубки", this.rankings.global?.trophies, this.clan.clanScore],
      ["Мир, КВ", this.rankings.global?.war, this.clan.clanWarTrophies],
      [`${local}, кубки`, this.rankings.local?.trophies, this.clan.clanScore],
      [`${local}, КВ`, this.rankings.local?.war, this.clan.clanWarTrophies],
    ];
    for (const [term, board, own] of boards) {
      if (!board) continue;
      stats.append(Elements.create("dt", null, term), Elements.create("dd", null, this.position(board, own)));
    }
    return stats;
  }

  position(board, own) {
    if (board.rank) return `${Elements.number(board.rank)} место`;
    const gap = board.cutoff ? board.cutoff - own : null;
    return gap > 0
      ? `не в топ-${ClanSummary.RANKING_SIZE}, не хватает ${Elements.number(gap)}`
      : `не в топ-${ClanSummary.RANKING_SIZE}`;
  }
}

class ClanTab {
  title = "Клан";

  constructor(history, summary) {
    this.history = history;
    this.summary = summary;
  }

  render(container) {
    const sum = (participants, field) => participants.reduce((total, participant) => total + participant[field], 0);
    container.replaceChildren(
      this.summary.render(),
      Elements.create("p", "hint", "Вся история КВ, что есть в архиве. Наведи или нажми на столбец, чтобы увидеть цифры."),
      new BarChart({ title: "Медали клана за неделю", subtitle: "сумма медалей всех участников", valueLabel: "Медали" })
        .render(this.history.clan((participants) => sum(participants, "fame"))),
      new BarChart({ title: "Сыгранные колоды за неделю", subtitle: "максимум 16 на игрока", valueLabel: "Колоды" })
        .render(this.history.clan((participants) => sum(participants, "decksUsed"))),
      new BarChart({ title: "Игроков в КВ", subtitle: "сыграли хотя бы одну колоду", valueLabel: "Игроков" })
        .render(this.history.clan((participants) => participants.filter((participant) => participant.decksUsed > 0).length)),
    );
  }
}

class ProfileView {
  static LEGENDS = 10;

  constructor(data, { roster, history, donations, membership, calendar, war }) {
    this.data = data;
    this.roster = roster;
    this.history = history;
    this.donations = donations;
    this.membership = membership;
    this.calendar = calendar;
    this.war = war;
  }

  render(container, tag) {
    const record = this.data.members[tag];
    const member = this.data.clan.memberList.find((entry) => entry.tag === tag);
    const appearances = this.history.appearances(tag);
    const name = member?.name ?? record?.name ?? appearances.at(-1)?.participant.name;
    if (!name) {
      container.replaceChildren(Elements.create("p", "empty", "Игрок не найден."));
      return;
    }
    const profile = this.data.players[tag] ?? {};
    const back = Elements.create("a", "back", "← назад");
    back.href = "#roster";
    container.replaceChildren(
      back,
      this.header(tag, name, member, profile, appearances),
      this.contribution(tag, record, appearances),
      ...(member ? [this.deck(profile)] : []),
      new BarChart({ title: "Медали за неделю КВ", valueLabel: "Медали", referenceLabel: "Медиана клана" })
        .render(this.history.player(tag, "fame")),
      new BarChart({ title: "Колоды за неделю КВ", subtitle: "из 16 возможных", valueLabel: "Колоды", referenceLabel: "Медиана клана", max: 16, step: 4 })
        .render(this.history.player(tag, "decksUsed")),
      ...(record
        ? [new BarChart({ title: "Донат за неделю", subtitle: "учёт с 27.10.2026", valueLabel: "Донат", referenceLabel: "Медиана клана" })
          .render(this.donations.player(tag))]
        : []),
    );
  }

  header(tag, name, member, profile, appearances) {
    const card = Elements.create("section", "profile");
    const title = Elements.create("div", "profile-title");
    title.append(Elements.create("h2", null, name), this.membership.badge(tag));
    card.appendChild(title);
    const last = appearances.at(-1)?.week;
    const facts = [
      tag,
      member ? RosterTab.ROLES[member.role] ?? member.role : null,
      this.roster.since(tag),
      !member && last ? `последняя неделя КВ в клане: ${last.title.replace(/^Сезон \d+, /, "")}` : null,
    ].filter(Boolean);
    card.appendChild(Elements.create("p", "details", facts.join(" · ")));
    const stats = Elements.create("dl", "stats");
    const add = (term, value) => {
      if (value === undefined || value === null) return;
      stats.append(Elements.create("dt", null, term), Elements.create("dd", null, value));
    };
    add("Кубки", profile.trophies !== undefined ? Elements.number(profile.trophies) : member && Elements.number(member.trophies));
    add("Path of Legends", this.league(profile.currentPathOfLegendSeasonResult));
    add("Лучший сезон PoL", this.league(profile.bestPathOfLegendSeasonResult));
    add("Донат за всю игру", profile.totalDonations !== undefined ? Elements.number(profile.totalDonations) : null);
    add("Любимая карта", profile.currentFavouriteCard?.name);
    if (stats.children.length > 0) card.appendChild(stats);
    return card;
  }

  contribution(tag, record, appearances) {
    const card = Elements.create("section", "profile");
    card.appendChild(Elements.create("h3", null, "Вклад в клан"));
    card.appendChild(Elements.create("p", "details", `по ${this.history.weeks.length} неделям КВ в архиве`));
    const participants = appearances.map((entry) => entry.participant);
    const played = participants.filter((participant) => participant.decksUsed > 0);
    const best = played.reduce((top, participant) => (participant.fame > (top?.fame ?? -1) ? participant : top), null);
    const stats = Elements.create("dl", "stats");
    const add = (term, value) => stats.append(Elements.create("dt", null, term), Elements.create("dd", null, value));
    add("Медали", Elements.number(participants.reduce((sum, participant) => sum + participant.fame, 0)));
    add("Колоды", Elements.number(participants.reduce((sum, participant) => sum + participant.decksUsed, 0)));
    add("Недель в КВ", `${played.length} из ${participants.length} в клане`);
    if (best) add("Лучшая неделя", `${Elements.number(best.fame)} медалей`);
    if (record) add("Донат с начала учёта", Elements.number(record.donations.closed + record.donations.current));
    const hall = this.hallOfFame(tag);
    add("Зал славы", hall.length > 0 ? hall.join(", ") : "пока нет");
    card.appendChild(stats);
    return card;
  }

  hallOfFame(tag) {
    return this.calendar.seasons()
      .filter((id) => this.calendar.isComplete(id))
      .map((id) => ({ id, place: this.war.standings(id).slice(0, HallOfFameTab.SIZE).findIndex((row) => row.tag === tag) + 1 }))
      .filter((entry) => entry.place > 0)
      .map((entry) => `${entry.place} место в сезоне ${entry.id}`);
  }

  league(result) {
    if (!result || !result.leagueNumber || (result.leagueNumber === 1 && !result.trophies)) return null;
    if (result.leagueNumber < ProfileView.LEGENDS) return `лига ${result.leagueNumber} из ${ProfileView.LEGENDS}`;
    const place = result.rank ? `, место ${Elements.number(result.rank)}` : "";
    return `Ultimate Champion, ${Elements.number(result.trophies)}${place}`;
  }

  deck(profile) {
    const section = Elements.create("section", "deck-block");
    const cards = profile.currentDeck ?? [];
    if (cards.length === 0) {
      section.appendChild(Elements.create("p", "empty", "Колода появится после следующего обновления данных."));
      return section;
    }
    const elixir = cards.reduce((sum, card) => sum + (card.elixirCost ?? 0), 0) / cards.length;
    section.append(
      Elements.create("h3", null, "Текущая колода"),
      Elements.create("p", "details", `средний эликсир ${elixir.toFixed(1)}`),
    );
    const grid = Elements.create("ul", "deck");
    for (const card of cards) {
      const item = Elements.create("li", card.evolved ? "card evolved" : "card");
      const image = Elements.create("img");
      image.src = card.icon;
      image.alt = card.name;
      image.loading = "lazy";
      item.append(image, Elements.create("span", "card-name", card.name));
      grid.appendChild(item);
    }
    section.appendChild(grid);
    return section;
  }
}

class ClanApp {
  constructor(source, nav, content, footer, logo) {
    this.source = source;
    this.logo = logo;
    this.nav = nav;
    this.content = content;
    this.footer = footer;
  }

  async start() {
    try {
      const data = await this.source.loadAll();
      const calendar = new RaceCalendar(data.races, data.race);
      const names = new Map(Object.entries(data.members).map(([tag, record]) => [tag, record.name]));
      const war = new WarRanking(calendar, names);
      const history = new WeeklyHistory(calendar);
      const membership = new Membership(data.clan);
      const list = new RankingList(membership);
      const roster = new RosterTab(data.clan, data.members, list);
      this.tabs = {
        war: new WarTab(calendar, war, list),
        donations: new DonationTab(calendar, new DonationRanking(calendar, data.members), list),
        hall: new HallOfFameTab(calendar, war, list),
        clan: new ClanTab(history, new ClanSummary(data.clan, data.rankings, data.badge)),
        roster,
      };
      this.profile = new ProfileView(data, { roster, history, donations: new DonationHistory(data.members), membership, calendar, war });
      const badge = ClanSummary.badgeUrl(data.badge);
      if (badge) {
        this.logo.src = badge;
        this.logo.hidden = false;
      }
      this.footer.textContent = `Обновлено ${new Date(data.meta.updated_at).toLocaleString("ru-RU")}`;
      this.renderNav();
      window.addEventListener("hashchange", () => this.show());
      this.show();
    } catch (error) {
      this.content.replaceChildren(Elements.create("p", "empty", `Не удалось загрузить данные: ${error.message}`));
    }
  }

  renderNav() {
    this.nav.replaceChildren(
      ...Object.entries(this.tabs).map(([key, tab]) => {
        const link = Elements.create("a", "tab", tab.title);
        link.href = `#${key}`;
        link.dataset.key = key;
        return link;
      }),
    );
  }

  show() {
    const route = decodeURIComponent(location.hash.slice(1));
    if (route.startsWith("player/")) {
      this.highlight(null);
      this.profile.render(this.content, `#${route.slice("player/".length).toUpperCase()}`);
      window.scrollTo(0, 0);
      return;
    }
    const key = route in this.tabs ? route : "war";
    this.highlight(key);
    this.tabs[key].render(this.content);
  }

  highlight(key) {
    for (const link of this.nav.children) {
      link.classList.toggle("active", link.dataset.key === key);
    }
  }
}

new ClanApp(
  new DataSource(),
  document.getElementById("tabs"),
  document.getElementById("content"),
  document.getElementById("updated"),
  document.getElementById("logo"),
).start();
