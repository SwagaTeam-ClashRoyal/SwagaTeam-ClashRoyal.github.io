class DataSource {
  async load(path) {
    const response = await fetch(`data/${path}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  }
}

class Table {
  constructor(columns) {
    this.columns = columns;
  }

  render(rows) {
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const column of this.columns) {
      const cell = document.createElement("th");
      cell.textContent = column.title;
      if (column.numeric) cell.className = "num";
      head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const row of rows) {
      const line = body.insertRow();
      for (const column of this.columns) {
        const cell = line.insertCell();
        cell.textContent = column.value(row);
        if (column.numeric) cell.className = "num";
      }
    }
    return table;
  }
}

class ClanPage {
  static ROLES = {
    leader: "глава",
    coLeader: "соруководитель",
    elder: "старейшина",
    member: "участник",
  };

  static WAR_PERIODS = {
    training: "тренировочные дни",
    warDay: "день войны",
    colosseum: "колизей",
  };

  constructor(source, root) {
    this.source = source;
    this.root = root;
  }

  async show() {
    try {
      const [meta, clan, race, members] = await Promise.all([
        this.source.load("current/meta.json"),
        this.source.load("current/clan.json"),
        this.source.load("current/river_race.json"),
        this.source.load("members.json"),
      ]);
      this.root.replaceChildren(
        this.summary(meta, clan),
        this.section("КВ сейчас", this.warTable(clan, race), this.warNote(race)),
        this.section("Состав", this.memberTable(clan, members)),
      );
    } catch (error) {
      this.root.replaceChildren(this.paragraph(`Не удалось загрузить данные: ${error.message}`));
    }
  }

  summary(meta, clan) {
    const updated = new Date(meta.updated_at).toLocaleString("ru-RU");
    return this.paragraph(
      `Участников: ${clan.members}/50 · кубки КВ: ${clan.clanWarTrophies} · обновлено ${updated}`,
    );
  }

  warNote(race) {
    const period = ClanPage.WAR_PERIODS[race.periodType] ?? race.periodType;
    return this.paragraph(`Сейчас: ${period}. Очки клана: ${race.clan.fame}.`);
  }

  warTable(clan, race) {
    const inClan = new Set(clan.memberList.map((member) => member.tag));
    const rows = race.clan.participants
      .filter((participant) => inClan.has(participant.tag))
      .sort((a, b) => b.fame - a.fame || b.decksUsed - a.decksUsed);
    return new Table([
      { title: "Игрок", value: (row) => row.name },
      { title: "Fame", value: (row) => row.fame, numeric: true },
      { title: "Колоды сегодня", value: (row) => `${row.decksUsedToday}/4`, numeric: true },
      { title: "Колоды всего", value: (row) => row.decksUsed, numeric: true },
    ]).render(rows);
  }

  memberTable(clan, members) {
    const total = (tag) => {
      const record = members[tag];
      return record ? record.donations.closed + record.donations.current : 0;
    };
    return new Table([
      { title: "Игрок", value: (row) => row.name },
      { title: "Роль", value: (row) => ClanPage.ROLES[row.role] ?? row.role },
      { title: "Кубки", value: (row) => row.trophies, numeric: true },
      { title: "Донат за неделю", value: (row) => row.donations, numeric: true },
      { title: "Донат с начала учёта", value: (row) => total(row.tag), numeric: true },
    ]).render(clan.memberList);
  }

  section(title, table, note) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const scroller = document.createElement("div");
    scroller.className = "scroll";
    scroller.append(table);
    section.append(heading, ...(note ? [note] : []), scroller);
    return section;
  }

  paragraph(text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  }
}

new ClanPage(new DataSource(), document.getElementById("content")).show();
