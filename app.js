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
    const [rankings, badge, renders, rankingHistory, events] = await Promise.all([
      this.load("current/rankings.json").catch(() => null),
      this.load("current/badge.json").catch(() => null),
      this.renders(),
      this.load("history/rankings.json").catch(() => []),
      this.load("history/events.json").catch(() => []),
    ]);
    const races = await Promise.all(index.map((name) => this.load(`history/river_races/${name}`)));
    return { meta, clan, race, members, races, players, rankings, badge, renders, rankingHistory, events };
  }

  async renders() {
    const response = await fetch("assets/renders/index.json").catch(() => null);
    return response?.ok ? response.json() : {};
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

class KickWatch {
  static IDLE_WARN = 5;
  static IDLE_KICK = 7;
  static MISSES_KICK = 2;
  static CONTENDERS = 5;
  static ELDERS = 3;

  constructor(calendar, ranking, now = Date.now()) {
    this.calendar = calendar;
    this.now = now;
    this.places = new Map(ranking.standings(calendar.currentSeasonId).slice(0, KickWatch.CONTENDERS).map((row, index) => [row.tag, index + 1]));
  }

  misses(tag) {
    let count = 0;
    for (const race of [...this.calendar.races].reverse()) {
      const participant = race.participants.find((p) => p.tag === tag);
      if (!participant || participant.decksUsed > 0) break;
      count += 1;
    }
    return count;
  }

  idleDays(member) {
    if (!member.lastSeen) return 0;
    return Math.floor((this.now - RaceCalendar.parse(member.lastSeen)) / RaceCalendar.DAY);
  }

  status(member) {
    const misses = this.misses(member.tag);
    const idle = this.idleDays(member);
    const notes = [];
    if (misses >= KickWatch.MISSES_KICK) notes.push({ text: `${misses} ${KickWatch.plural(misses)}`, title: `${misses} недели КВ подряд без единой колоды` });
    else if (misses === 1) notes.push({ text: "пропуск КВ", title: "Прошлую неделю КВ не сыграл ни одной колоды" });
    if (idle >= KickWatch.IDLE_WARN) notes.push({ text: `${idle} дн. офлайн`, title: `Не заходил в игру ${idle} дн.` });
    if (misses >= KickWatch.MISSES_KICK || idle >= KickWatch.IDLE_KICK) return { mark: "kick", notes };
    if (notes.length > 0) return { mark: "warn", notes };
    const place = this.places.get(member.tag);
    if (place <= KickWatch.ELDERS) {
      return { mark: "elder", notes: [{ text: `${place} место`, title: `Сейчас ${place}-й боец КВ сезона: попадёт в зал славы и станет старейшиной` }] };
    }
    if (place) {
      return { mark: "star", notes: [{ text: `${place} место`, title: `Сейчас ${place}-й боец КВ сезона, претендент в зал славы` }] };
    }
    return { mark: null, notes };
  }

  static legend() {
    const legend = Elements.create("ul", "legend");
    for (const [mark, text] of [
      ["kick", `на кик: ${KickWatch.MISSES_KICK} пропуска КВ подряд или ${KickWatch.IDLE_KICK}+ дней не в игре`],
      ["warn", `внимание: 1 пропуск КВ или ${KickWatch.IDLE_WARN}+ дней не в игре`],
      ["elder", `топ-${KickWatch.ELDERS} сезона: попадут в зал славы и станут старейшинами`],
      ["star", `топ-${KickWatch.CONTENDERS} сезона, претенденты в зал славы`],
    ]) {
      const item = Elements.create("li", null, text);
      item.prepend(Elements.create("span", `swatch mark-${mark}`));
      legend.appendChild(item);
    }
    return legend;
  }

  static plural(count) {
    const tens = count % 100;
    const ones = count % 10;
    return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? "пропуска" : "пропусков";
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

  static glossy(element) {
    element.classList.add("glossy");
    element.dataset.text = element.textContent;
    return element;
  }

  static icon(name, alt = "") {
    const image = Elements.create("img", "icon");
    image.src = `assets/icons/${name}.png`;
    image.alt = alt;
    return image;
  }
}

class Membership {
  constructor(clan) {
    this.roles = new Map(clan.memberList.map((member) => [member.tag, member.role]));
  }

  has(tag) {
    return this.roles.has(tag);
  }

  role(tag) {
    const role = this.roles.get(tag);
    return role ? Roster.ROLES[role] ?? role : null;
  }

  badge(tag) {
    return this.has(tag)
      ? Elements.create("span", "badge in-clan", "в клане")
      : Elements.create("span", "badge left-clan", "не в клане");
  }
}

class RankingList {
  static RELEASE_DELAY = 300;

  constructor(membership) {
    this.membership = membership;
  }

  render(rows, describe) {
    if (rows.length === 0) {
      return Elements.create("p", "empty", "Пока нет данных за этот сезон.");
    }
    const list = Elements.create("ol", "roster");
    rows.forEach((row, index) => list.appendChild(this.row(row, index + 1, describe(row))));
    return list;
  }

  row(row, place, view) {
    const item = Elements.create("li");
    const card = Elements.create("a", "member");
    if (view.mark) card.classList.add(`mark-${view.mark}`);
    card.href = `#player/${row.tag.replace("#", "")}`;
    card.addEventListener("click", (event) => this.open(event, card));
    const who = Elements.create("div", "who");
    const first = Elements.create("span", "name-line");
    first.appendChild(Elements.glossy(Elements.create("span", "name", row.name)));
    if (!this.membership.has(row.tag)) first.appendChild(this.membership.badge(row.tag));
    const second = Elements.create("span", "role");
    second.append(...(view.line ?? []));
    who.append(first, second);
    card.append(Elements.glossy(Elements.create("span", `rank rank-${place}`, place)), Elements.create("span", "avatar"), who);
    if (view.stack) card.appendChild(this.stack(view.stack));
    if (view.pill) card.appendChild(this.pill(view.pill));
    item.appendChild(card);
    return item;
  }

  stack({ icon, label, value }) {
    const stack = Elements.create("div", "stack");
    stack.append(Elements.icon(icon, label), Elements.glossy(Elements.create("span", null, value)));
    return stack;
  }

  pill({ icon, label, value, tint }) {
    const pill = Elements.create("div", "score-pill");
    pill.title = label;
    const image = Elements.icon(icon, label);
    if (tint) image.classList.add(`tint-${tint}`);
    pill.append(image, Elements.glossy(Elements.create("span", null, value)));
    return pill;
  }

  static stat(icon, label, value) {
    const stat = Elements.create("span", "inline-stat");
    stat.title = label;
    stat.append(Elements.icon(icon, label), value);
    return stat;
  }

  open(event, card) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    card.classList.add("released");
    setTimeout(() => {
      location.hash = card.getAttribute("href");
    }, RankingList.RELEASE_DELAY);
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
        line: [
          RankingList.stat("cw-fame", "Медали", Elements.number(row.fame)),
          RankingList.stat("cw-battle", "Колоды", `${row.decks}/${row.possible}`),
        ],
        pill: { icon: "trophy-ribbon", label: "Очки", value: Elements.number(row.score), tint: "white" },
      })),
    );
  }
}

class DonationTab {
  title = "Щедрые";

  constructor(calendar, ranking, list, membership) {
    this.calendar = calendar;
    this.ranking = ranking;
    this.list = list;
    this.membership = membership;
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
        line: [this.membership.role(row.tag) ?? ""],
        pill: { icon: "cards", label: "Донат за сезон", value: Elements.number(row.donations) },
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
      line: [
        RankingList.stat("cw-fame", "Медали", Elements.number(row.fame)),
        RankingList.stat("cw-battle", "Колоды", `${row.decks}/${row.possible}`),
      ],
      pill: { icon: "trophy-ribbon", label: "Очки", value: Elements.number(row.score), tint: "white" },
    })));
    return card;
  }
}

class Roster {
  static ROLES = {
    leader: "глава",
    coLeader: "соруководитель",
    elder: "старейшина",
    member: "участник",
  };

  constructor(clan, members, list, watch) {
    this.clan = clan;
    this.members = members;
    this.list = list;
    this.watch = watch;
    this.trackingStart = Object.values(members).map((record) => record.first_seen.slice(0, 10)).sort()[0];
  }

  render() {
    const rows = [...this.clan.memberList].sort((a, b) => a.clanRank - b.clanRank);
    const list = this.list.render(rows, (row) => {
      const status = this.watch.status(row);
      return {
        mark: status.mark,
        line: [Elements.create("span", "role-name", Roster.ROLES[row.role] ?? row.role), ...status.notes.map((note) => this.flag(status.mark, note))],
        stack: { icon: "cards", label: "Донат за неделю", value: Elements.number(row.donations) },
        pill: { icon: "trophy", label: "Кубки", value: row.trophies },
      };
    });
    const legend = KickWatch.legend();
    legend.classList.add("legend-below");
    return [Elements.create("h2", "section-title", `Участники ${this.clan.members}/50`), list, legend];
  }

  flag(mark, { text, title }) {
    const flag = Elements.create("span", `flag flag-${mark}`, text);
    flag.title = title;
    return flag;
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

class RankingBoards {
  static SIZE = 1000;

  constructor(clan, rankings, history) {
    this.clan = clan;
    this.rankings = rankings;
    this.history = history;
  }

  list() {
    if (!this.rankings) return [];
    const local = this.clan.location?.name === "Russia" ? "Россия" : this.rankings.location;
    return [
      { key: "global-trophies", scope: "global", board: "trophies", label: "Мир, кубки", icon: "trophy", own: this.clan.clanScore },
      { key: "global-war", scope: "global", board: "war", label: "Мир, КВ", icon: "cw-trophy", own: this.clan.clanWarTrophies },
      { key: "local-trophies", scope: "local", board: "trophies", label: `${local}, кубки`, icon: "trophy", own: this.clan.clanScore },
      { key: "local-war", scope: "local", board: "war", label: `${local}, КВ`, icon: "cw-trophy", own: this.clan.clanWarTrophies },
    ]
      .map((entry) => ({ ...entry, current: this.rankings[entry.scope]?.[entry.board] }))
      .filter((entry) => entry.current);
  }

  status({ current, own }) {
    if (current.rank) return `${Elements.number(current.rank)} место`;
    const gap = current.cutoff ? current.cutoff - own : null;
    return gap > 0
      ? `не в топ-${RankingBoards.SIZE}, не хватает ${Elements.number(gap)}`
      : `не в топ-${RankingBoards.SIZE}`;
  }

  trend({ scope, board, current, own }) {
    const today = this.history.at(-1)?.date;
    const previous = this.history.filter((entry) => entry.date < today).at(-1);
    const before = previous?.[scope]?.[board];
    if (!before) return null;
    if (current.rank && before.rank) return { delta: before.rank - current.rank, unit: "мест" };
    if (current.rank || before.rank) return { delta: current.rank ? 1 : -1, unit: null };
    if (!current.cutoff || !before.cutoff) return null;
    return { delta: (before.cutoff - previous.score[board]) - (current.cutoff - own), unit: "кубков" };
  }

  points({ scope, board }) {
    return this.history
      .filter((entry) => entry[scope]?.[board])
      .map((entry) => {
        const { rank, cutoff } = entry[scope][board];
        const score = entry.score[board];
        const date = new Date(`${entry.date}T00:00:00`);
        return {
          label: WeeklyHistory.short(date),
          title: date.toLocaleDateString("ru-RU"),
          value: rank || !cutoff ? 0 : Math.max(cutoff - score, 0),
          rank,
          cutoff,
          score,
        };
      });
  }
}

class TrendMark {
  static render(trend) {
    if (!trend) return null;
    const direction = trend.delta > 0 ? "up" : trend.delta < 0 ? "down" : "flat";
    const arrow = { up: "▲", down: "▼", flat: "±0" }[direction];
    const mark = Elements.create("span", `trend trend-${direction}`, trend.unit && trend.delta !== 0 ? `${arrow} ${Elements.number(Math.abs(trend.delta))}` : arrow);
    mark.title = TrendMark.describe(trend, direction);
    return mark;
  }

  static describe(trend, direction) {
    if (direction === "flat") return "За день без изменений";
    if (!trend.unit) return direction === "up" ? "За день вошли в рейтинг" : "За день выпали из рейтинга";
    const amount = `${Elements.number(Math.abs(trend.delta))} ${trend.unit}`;
    if (trend.unit === "мест") return direction === "up" ? `За день поднялись на ${amount}` : `За день опустились на ${amount}`;
    return direction === "up" ? `За день приблизились к топу на ${amount}` : `За день отстали от топа ещё на ${amount}`;
  }
}

class ClanSummary {
  static TYPES = { open: "открытый", inviteOnly: "по приглашению", closed: "закрытый" };

  constructor(clan, boards, badge) {
    this.clan = clan;
    this.boards = boards;
    this.badge = badge;
    this.open = false;
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
    const more = Elements.create("details", "fold clan-more");
    more.open = this.open;
    more.addEventListener("toggle", () => {
      this.open = more.open;
    });
    more.appendChild(Elements.create("summary", null, "Кубки, донат, вход и места в рейтингах"));
    more.appendChild(this.infoGrid());
    const boards = this.boards.list();
    if (boards.length > 0) {
      more.append(Elements.create("h3", "subheading", "Место в рейтингах"), this.rankingList(boards));
    }
    card.appendChild(more);
    return card;
  }

  infoGrid() {
    const grid = Elements.create("ul", "info-grid");
    const tiles = [
      ["trophy", "Кубки клана", Elements.number(this.clan.clanScore)],
      ["cw-trophy", "Кубки КВ", Elements.number(this.clan.clanWarTrophies)],
      ["people", "Участников", `${this.clan.members} из 50`],
      ["cards", "Донат за неделю", Elements.number(this.clan.donationsPerWeek)],
      ["social", "Вход", `от ${Elements.number(this.clan.requiredTrophies)}, ${ClanSummary.TYPES[this.clan.type] ?? this.clan.type}`],
    ];
    if (this.clan.location?.name) tiles.push(["region", "Страна", this.clan.location.name === "Russia" ? "Россия" : this.clan.location.name]);
    for (const [icon, label, value] of tiles) {
      const tile = Elements.create("li", "info-tile");
      const text = Elements.create("div");
      text.append(Elements.create("span", "info-label", label), Elements.create("span", "info-value", value));
      tile.append(Elements.icon(icon, label), text);
      grid.appendChild(tile);
    }
    return grid;
  }

  rankingList(boards) {
    const list = Elements.create("ul", "rank-list");
    for (const entry of boards) {
      const row = Elements.create("a", "rank-row");
      row.href = `#rankings/${entry.key}`;
      const text = Elements.create("div");
      text.append(Elements.create("span", "info-value", entry.label), Elements.create("span", "info-label", this.boards.status(entry)));
      row.append(Elements.icon(entry.icon, entry.label), text);
      const trend = TrendMark.render(this.boards.trend(entry));
      if (trend) row.appendChild(trend);
      row.appendChild(Elements.create("span", "chevron", "›"));
      const item = Elements.create("li");
      item.appendChild(row);
      list.appendChild(item);
    }
    return list;
  }
}

class RankingsView {
  constructor(boards) {
    this.boards = boards;
  }

  render(container, focus) {
    const back = Elements.create("a", "back", "← назад");
    back.href = "#clan";
    const boards = this.boards.list();
    container.replaceChildren(
      back,
      Elements.create("p", "hint", "Сколько кубков клану не хватает до топ-1000 рейтинга, по дням. Чем ниже столбец, тем ближе топ. Наведи или нажми на столбец, чтобы увидеть цифры."),
      ...boards.map((entry) => this.chart(entry)),
    );
    document.getElementById(`board-${focus}`)?.scrollIntoView();
  }

  chart(entry) {
    const section = Elements.create("section", "ranking-chart");
    section.id = `board-${entry.key}`;
    const head = Elements.create("div", "ranking-head");
    head.append(Elements.icon(entry.icon, entry.label), Elements.create("h2", "section-title", entry.label));
    const trend = TrendMark.render(this.boards.trend(entry));
    if (trend) head.appendChild(trend);
    section.append(
      head,
      new BarChart({
        title: this.boards.status(entry),
        subtitle: `данные с ${this.boards.history[0] ? new Date(`${this.boards.history[0].date}T00:00:00`).toLocaleDateString("ru-RU") : "сегодня"}`,
        valueLabel: "Не хватает",
        periodLabel: "День",
        extra: (point) => [
          `Наши кубки: ${Elements.number(point.score)}`,
          point.rank ? `Место: ${Elements.number(point.rank)}` : `Порог топ-${RankingBoards.SIZE}: ${Elements.number(point.cutoff)}`,
        ],
      }).render(this.boards.points(entry)),
    );
    return section;
  }
}

class ClanTab {
  title = "Клан";

  constructor(history, summary, roster) {
    this.history = history;
    this.summary = summary;
    this.roster = roster;
    this.statsOpen = false;
  }

  render(container) {
    container.replaceChildren(this.summary.render(), this.stats(), ...this.roster.render());
  }

  stats() {
    const block = Elements.create("details", "fold clan-stats");
    block.open = this.statsOpen;
    block.addEventListener("toggle", () => {
      this.statsOpen = block.open;
    });
    const sum = (participants, field) => participants.reduce((total, participant) => total + participant[field], 0);
    block.append(
      Elements.create("summary", null, "Статистика КВ: медали, колоды, игроки"),
      Elements.create("p", "hint", "Вся история КВ, что есть в архиве. Наведи или нажми на столбец, чтобы увидеть цифры."),
      new BarChart({ title: "Медали клана за неделю", subtitle: "сумма медалей всех участников", valueLabel: "Медали" })
        .render(this.history.clan((participants) => sum(participants, "fame"))),
      new BarChart({ title: "Сыгранные колоды за неделю", subtitle: "максимум 16 на игрока", valueLabel: "Колоды" })
        .render(this.history.clan((participants) => sum(participants, "decksUsed"))),
      new BarChart({ title: "Игроков в КВ", subtitle: "сыграли хотя бы одну колоду", valueLabel: "Игроков" })
        .render(this.history.clan((participants) => participants.filter((participant) => participant.decksUsed > 0).length)),
    );
    return block;
  }
}

class EventFeed {
  static PAGE = 60;
  static CARDS_SHOWN = 3;
  static ICONS = {
    joined: "people",
    left: "people",
    promoted: "social",
    demoted: "social",
    arena: "trophy",
    king_level: "experience",
    league: "tournament",
    cards: "cards",
    evolution: "star-level",
    anniversary: "crown-blue",
    war_week: "clan-war",
  };

  constructor(events) {
    this.events = events.filter((event) => event.type in EventFeed.ICONS).reverse();
  }

  static period(months) {
    if (months === 1) return "Месяц";
    if (months === 6) return "Полгода";
    if (months === 12) return "Год";
    if (months % 12 === 0) {
      const years = months / 12;
      return `${years} ${years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 12 || years % 100 > 14) ? "года" : "лет"}`;
    }
    return `${months} ${months >= 2 && months <= 4 ? "месяца" : "месяцев"}`;
  }

  describe(event) {
    const role = (key) => Roster.ROLES[key] ?? key;
    const cards = (list) => {
      const shown = list.slice(0, EventFeed.CARDS_SHOWN).join(", ");
      return list.length > EventFeed.CARDS_SHOWN ? `${shown} и ещё ${list.length - EventFeed.CARDS_SHOWN}` : shown;
    };
    switch (event.type) {
      case "joined": return "Новый участник клана";
      case "left": return "Выход из клана";
      case "promoted": return `Повышение: ${role(event.previous)} → ${role(event.role)}`;
      case "demoted": return `Понижение: ${role(event.previous)} → ${role(event.role)}`;
      case "arena": return `Новая арена: ${event.arena}`;
      case "king_level": return `Уровень короля ${event.level}`;
      case "league": return `Path of Legends: лига ${event.league}`;
      case "cards": return `Прокачка: ${cards(event.cards.map((card) => `${card.name} до ${card.level}`))}`;
      case "evolution": return `Эволюция: ${cards(event.cards)}`;
      case "anniversary": return `${EventFeed.period(event.months)} в клане`;
      case "war_week": {
        const best = event.best ? `, лучший боец ${event.best.name} (${Elements.number(event.best.fame)})` : "";
        return `${event.rank} место${best}`;
      }
      default: return event.type;
    }
  }

  render(container, limit = EventFeed.PAGE) {
    if (this.events.length === 0) {
      container.replaceChildren(Elements.create("p", "empty", "Событий пока нет."));
      return;
    }
    const feed = Elements.create("div", "feed");
    let day = null;
    let list = null;
    for (const event of this.events.slice(0, limit)) {
      const date = new Date(event.at);
      const key = date.toLocaleDateString("ru-RU");
      if (key !== day) {
        day = key;
        feed.appendChild(Elements.create("h2", "section-title", this.dayTitle(date)));
        list = Elements.create("ul", "feed-list");
        feed.appendChild(list);
      }
      list.appendChild(this.item(event, date));
    }
    const nodes = [Elements.create("p", "hint", "Что происходит в клане: вступления, повышения, юбилеи, прокачка карт, новые арены и итоги недель КВ."), feed];
    if (this.events.length > limit) {
      const more = Elements.create("button", "feed-more", "Показать ещё");
      more.addEventListener("click", () => this.render(container, limit + EventFeed.PAGE));
      nodes.push(more);
    }
    container.replaceChildren(...nodes);
  }

  item(event, date) {
    const item = Elements.create("li", `feed-item feed-${event.type}`);
    const text = Elements.create("div", "feed-text");
    if (event.type === "war_week") {
      text.appendChild(Elements.create("span", "feed-who", `Неделя КВ ${event.week}, сезон ${event.season}`));
    } else {
      const who = Elements.create("a", "feed-who", event.name);
      who.href = `#player/${event.tag.replace("#", "")}`;
      text.appendChild(who);
    }
    text.appendChild(Elements.create("span", "feed-what", this.describe(event)));
    const time = Elements.create("time", "feed-time", date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
    time.dateTime = event.at;
    item.append(Elements.icon(EventFeed.ICONS[event.type] ?? "loading", ""), text, time);
    return item;
  }

  dayTitle(date) {
    const today = new Date();
    const yesterday = new Date(today.getTime() - RaceCalendar.DAY);
    if (date.toDateString() === today.toDateString()) return "Сегодня";
    if (date.toDateString() === yesterday.toDateString()) return "Вчера";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
}

class EventsTab {
  title = "События";

  constructor(feed) {
    this.feed = feed;
  }

  render(container) {
    this.feed.render(container);
  }
}

class DeckRails {
  static PER_SIDE = 4;

  constructor(host, renders) {
    this.renders = renders;
    this.rails = ["left", "right"].map((side) => {
      const rail = Elements.create("aside", `deck-rail ${side}`);
      rail.setAttribute("aria-hidden", "true");
      host.appendChild(rail);
      return rail;
    });
  }

  show(cards) {
    if (cards.length === 0) {
      this.hide();
      return;
    }
    this.rails.forEach((rail, side) => {
      const slice = cards.slice(side * DeckRails.PER_SIDE, (side + 1) * DeckRails.PER_SIDE);
      rail.replaceChildren(...slice.map((card, index) => {
        const render = this.renders[card.name];
        const slot = Elements.create("div", "rail-slot");
        const image = Elements.create("img", render ? "rail-card render" : `rail-card icon${card.evolved ? " evolved" : ""}`);
        image.src = render ?? card.icon;
        image.alt = "";
        image.style.animationDelay = `${(side * DeckRails.PER_SIDE + index) * 60}ms`;
        slot.appendChild(image);
        return slot;
      }));
      rail.classList.add("visible");
    });
  }

  hide() {
    for (const rail of this.rails) {
      rail.classList.remove("visible");
      rail.replaceChildren();
    }
  }
}

class ProfileView {
  static LEGENDS = 10;

  constructor(data, { roster, history, donations, membership, calendar, war, rails }) {
    this.data = data;
    this.rails = rails;
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
    back.href = "#clan";
    const medals = this.hallOfFame(tag);
    this.rails.show(profile.currentDeck ?? []);
    container.replaceChildren(
      back,
      this.header(tag, name, member, profile, appearances),
      ...(medals.length > 0 ? [this.medals(medals)] : []),
      this.contribution(tag, record, appearances, medals),
      ...(member || profile.currentDeck?.length ? [this.deck(profile, Boolean(member))] : []),
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
      member ? Roster.ROLES[member.role] ?? member.role : null,
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

  medals(entries) {
    const card = Elements.create("section", "profile medals");
    card.appendChild(Elements.create("h3", null, "Медали зала славы"));
    const list = Elements.create("ul", "medal-list");
    for (const { id, place } of entries) {
      const item = Elements.create("li", "medal");
      item.title = `${place} место в сезоне ${id}`;
      item.append(Elements.glossy(Elements.create("span", `rank rank-${place}`, place)), Elements.create("span", "medal-season", `Сезон ${id}`));
      list.appendChild(item);
    }
    card.appendChild(list);
    return card;
  }

  contribution(tag, record, appearances, medals) {
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
    add("Зал славы", medals.length > 0 ? medals.map(({ id, place }) => `${place} место в сезоне ${id}`).join(", ") : "пока нет");
    card.appendChild(stats);
    return card;
  }

  hallOfFame(tag) {
    return this.calendar.seasons()
      .filter((id) => this.calendar.isComplete(id))
      .map((id) => ({ id, place: this.war.standings(id).slice(0, HallOfFameTab.SIZE).findIndex((row) => row.tag === tag) + 1 }))
      .filter((entry) => entry.place > 0);
  }

  league(result) {
    if (!result || !result.leagueNumber || (result.leagueNumber === 1 && !result.trophies)) return null;
    if (result.leagueNumber < ProfileView.LEGENDS) return `лига ${result.leagueNumber} из ${ProfileView.LEGENDS}`;
    const place = result.rank ? `, место ${Elements.number(result.rank)}` : "";
    return `Ultimate Champion, ${Elements.number(result.trophies)}${place}`;
  }

  deck(profile, current) {
    const section = Elements.create("section", "deck-block");
    const cards = profile.currentDeck ?? [];
    if (cards.length === 0) {
      section.appendChild(Elements.create("p", "empty", "Колода появится после следующего обновления данных."));
      return section;
    }
    const elixir = cards.reduce((sum, card) => sum + (card.elixirCost ?? 0), 0) / cards.length;
    section.append(
      Elements.create("h3", null, current ? "Текущая колода" : "Последняя колода в клане"),
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

class AboutView {
  constructor(meta) {
    this.meta = meta;
  }

  render(container) {
    const back = Elements.create("a", "back", "← назад");
    back.href = "#clan";
    const panel = Elements.create("section", "about");
    const items = [
      `Данные берутся из официального API Clash Royale и обновляются каждые 60 минут. Последнее обновление: ${new Date(this.meta.updated_at).toLocaleString("ru-RU")}.`,
      "История клановых войн учитывается с 17.08.2026, донаты с 27.10.2026. Более старых данных API не хранит.",
      "Сезон на сайте совпадает с сезоном Clash Royale.",
      "Очки бойца КВ = медали × сыгранные колоды ÷ возможные колоды. Возможных колод 16 в неделю: по 4 в каждый из четырёх дней войны. В идущую неделю считаются только уже начавшиеся дни.",
      "В рейтингах учитываются и те, кто уже вышел из клана: их вклад остаётся в истории.",
      "Пять лучших бойцов КВ каждого завершённого сезона навсегда попадают в зал славы.",
      "Участники зала славы смогут выбрать себе фразу и картинку, они сохранятся на сайте.",
      `Топ-${KickWatch.ELDERS} зала славы каждого сезона становятся старейшинами.`,
    ];
    const list = Elements.create("ul");
    list.append(...items.map((text) => Elements.create("li", null, text)));
    panel.append(
      Elements.glossy(Elements.create("h2", "about-title", "Как работает сайт")),
      list,
      Elements.glossy(Elements.create("h2", "about-title about-subtitle", "Цвета в составе")),
      KickWatch.legend(),
      Elements.create("p", "about-author", "Сайт создал участник клана kkyo."),
    );
    container.replaceChildren(back, panel);
  }
}

class ClanApp {
  constructor(source, nav, content, logo, footerLogo) {
    this.source = source;
    this.logo = logo;
    this.footerLogo = footerLogo;
    this.nav = nav;
    this.content = content;
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
      const roster = new Roster(data.clan, data.members, list, new KickWatch(calendar, war));
      const boards = new RankingBoards(data.clan, data.rankings, data.rankingHistory);
      this.tabs = {
        clan: new ClanTab(history, new ClanSummary(data.clan, boards, data.badge), roster),
        war: new WarTab(calendar, war, list),
        donations: new DonationTab(calendar, new DonationRanking(calendar, data.members), list, membership),
        hall: new HallOfFameTab(calendar, war, list),
        events: new EventsTab(new EventFeed(data.events)),
      };
      this.rankings = new RankingsView(boards);
      this.rails = new DeckRails(document.getElementById("stage"), data.renders);
      this.profile = new ProfileView(data, { roster, history, donations: new DonationHistory(data.members), membership, calendar, war, rails: this.rails });
      const badge = ClanSummary.badgeUrl(data.badge);
      if (badge) {
        this.logo.src = badge;
        this.logo.hidden = false;
      }
      const warTrophies = document.getElementById("war-trophies");
      warTrophies.textContent = Elements.number(data.clan.clanWarTrophies);
      warTrophies.dataset.text = warTrophies.textContent;
      document.getElementById("war-pill").hidden = false;
      this.about = new AboutView(data.meta);
      if (badge) {
        this.footerLogo.src = badge;
        this.footerLogo.hidden = false;
      }
      this.renderNav();
      window.addEventListener("hashchange", () => this.show());
      document.addEventListener("touchstart", () => {}, { passive: true });
      this.show();
    } catch (error) {
      this.content.replaceChildren(Elements.create("p", "empty", `Не удалось загрузить данные: ${error.message}`));
    }
  }

  renderNav() {
    this.nav.replaceChildren(
      ...Object.entries(this.tabs).map(([key, tab]) => {
        const link = Elements.glossy(Elements.create("a", "tab", tab.title));
        link.href = `#${key}`;
        link.dataset.key = key;
        return link;
      }),
    );
  }

  show() {
    const route = decodeURIComponent(location.hash.slice(1));
    this.rails.hide();
    if (route.startsWith("player/")) {
      this.highlight(null);
      this.profile.render(this.content, `#${route.slice("player/".length).toUpperCase()}`);
      window.scrollTo(0, 0);
      return;
    }
    if (route === "rankings" || route.startsWith("rankings/")) {
      this.highlight("clan");
      window.scrollTo(0, 0);
      this.rankings.render(this.content, route.slice("rankings/".length));
      return;
    }
    if (route === "about") {
      this.highlight(null);
      this.about.render(this.content);
      window.scrollTo(0, 0);
      return;
    }
    const key = route in this.tabs ? route : "clan";
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
  document.getElementById("logo"),
  document.getElementById("footer-logo"),
).start();
