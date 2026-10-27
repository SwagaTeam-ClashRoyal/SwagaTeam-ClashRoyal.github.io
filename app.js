class DataSource {
  async load(path) {
    const response = await fetch(`data/${path}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  }

  async loadAll() {
    const [meta, clan, race, members, index] = await Promise.all([
      this.load("current/meta.json"),
      this.load("current/clan.json"),
      this.load("current/river_race.json"),
      this.load("members.json"),
      this.load("history/river_races/index.json"),
    ]);
    const races = await Promise.all(index.map((name) => this.load(`history/river_races/${name}`)));
    return { meta, clan, race, members, races };
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
}

class RankingList {
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
      who.append(Elements.create("span", "name", row.name), Elements.create("span", "details", view.details));
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

  constructor(calendar, ranking) {
    this.calendar = calendar;
    this.ranking = ranking;
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
      new RankingList().render(this.ranking.standings(this.season), (row) => ({
        score: Elements.number(row.score),
        details: `${Elements.number(row.fame)} медалей · колоды ${row.decks}/${row.possible}`,
      })),
    );
  }
}

class DonationTab {
  title = "Щедрые";

  constructor(calendar, ranking) {
    this.calendar = calendar;
    this.ranking = ranking;
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
      new RankingList().render(this.ranking.standings(this.season), (row) => ({
        score: Elements.number(row.donations),
        details: `недель с донатом: ${row.weeks}`,
      })),
    );
  }
}

class HallOfFameTab {
  static SIZE = 5;
  title = "Зал славы";

  constructor(calendar, ranking) {
    this.calendar = calendar;
    this.ranking = ranking;
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
    card.appendChild(new RankingList().render(this.ranking.standings(id).slice(0, HallOfFameTab.SIZE), (row) => ({
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

  constructor(clan, members) {
    this.clan = clan;
    this.members = members;
    this.trackingStart = Object.values(members).map((record) => record.first_seen.slice(0, 10)).sort()[0];
  }

  render(container) {
    const rows = [...this.clan.memberList].sort((a, b) => a.clanRank - b.clanRank);
    container.replaceChildren(
      Elements.create("p", "hint", `${this.clan.members} из 50 · кубки КВ клана: ${Elements.number(this.clan.clanWarTrophies)}`),
      new RankingList().render(rows, (row) => ({
        score: Elements.number(row.trophies),
        details: [RosterTab.ROLES[row.role] ?? row.role, `донат за неделю ${row.donations}`, this.since(row.tag)].filter(Boolean).join(" · "),
      })),
    );
  }

  since(tag) {
    const record = this.members[tag];
    if (!record) return "";
    const date = record.joined ?? (record.first_seen.slice(0, 10) > this.trackingStart ? record.first_seen : null);
    return date ? `в клане с ${new Date(date).toLocaleDateString("ru-RU")}` : "";
  }
}

class ClanApp {
  constructor(source, nav, content, footer) {
    this.source = source;
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
      this.tabs = {
        war: new WarTab(calendar, war),
        donations: new DonationTab(calendar, new DonationRanking(calendar, data.members)),
        hall: new HallOfFameTab(calendar, war),
        roster: new RosterTab(data.clan, data.members),
      };
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
    const key = location.hash.slice(1) in this.tabs ? location.hash.slice(1) : "war";
    for (const link of this.nav.children) {
      link.classList.toggle("active", link.dataset.key === key);
    }
    this.tabs[key].render(this.content);
  }
}

new ClanApp(
  new DataSource(),
  document.getElementById("tabs"),
  document.getElementById("content"),
  document.getElementById("updated"),
).start();
