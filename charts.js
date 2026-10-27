class Svg {
  static NS = "http://www.w3.org/2000/svg";

  static create(tag, attributes = {}) {
    const element = document.createElementNS(Svg.NS, tag);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, value);
    }
    return element;
  }

  static bar(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height);
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
  }
}

class ChartTooltip {
  constructor(host) {
    this.element = document.createElement("div");
    this.element.className = "chart-tip";
    this.element.hidden = true;
    host.appendChild(this.element);
  }

  show(lines, x, y) {
    this.element.replaceChildren(
      ...lines.map((line, index) => {
        const row = document.createElement("div");
        row.className = index === 0 ? "tip-title" : "tip-row";
        row.textContent = line;
        return row;
      }),
    );
    this.element.hidden = false;
    const host = this.element.parentElement.getBoundingClientRect();
    const left = Math.min(Math.max(x - host.left, 8), host.width - this.element.offsetWidth - 8);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${Math.max(y - host.top - this.element.offsetHeight - 12, 0)}px`;
  }

  hide() {
    this.element.hidden = true;
  }
}

class BarChart {
  static WIDTH = 600;
  static HEIGHT = 220;
  static PADDING = { top: 12, right: 8, bottom: 28, left: 44 };
  static MAX_BAR = 24;

  constructor({ title, subtitle, valueLabel, referenceLabel, format = (value) => value.toLocaleString("ru-RU"), max, step }) {
    this.title = title;
    this.subtitle = subtitle;
    this.valueLabel = valueLabel;
    this.referenceLabel = referenceLabel;
    this.format = format;
    this.max = max;
    this.step = step;
  }

  render(points) {
    const figure = document.createElement("figure");
    figure.className = "chart";
    const heading = document.createElement("figcaption");
    const title = document.createElement("span");
    title.className = "chart-title";
    title.textContent = this.title;
    heading.appendChild(title);
    if (this.subtitle) {
      const subtitle = document.createElement("span");
      subtitle.className = "chart-subtitle";
      subtitle.textContent = this.subtitle;
      heading.appendChild(subtitle);
    }
    figure.appendChild(heading);
    if (this.referenceLabel) {
      figure.appendChild(this.legend());
    }
    const plot = document.createElement("div");
    plot.className = "chart-plot";
    plot.appendChild(this.svg(points, new ChartTooltip(plot)));
    figure.append(plot, this.table(points));
    return figure;
  }

  legend() {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    for (const [className, text] of [["swatch-bar", this.valueLabel], ["swatch-ref", this.referenceLabel]]) {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.className = className;
      item.append(swatch, text);
      legend.appendChild(item);
    }
    return legend;
  }

  svg(points, tooltip) {
    const { WIDTH, HEIGHT, PADDING } = BarChart;
    const svg = Svg.create("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: "img", "aria-label": this.title });
    const plotWidth = WIDTH - PADDING.left - PADDING.right;
    const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
    const peak = Math.max(this.max ?? 0, ...points.map((p) => Math.max(p.value ?? 0, p.reference ?? 0)), 1);
    const ticks = this.ticks(peak);
    const top = ticks.at(-1);
    const y = (value) => PADDING.top + plotHeight - (value / top) * plotHeight;
    for (const tick of ticks) {
      svg.appendChild(Svg.create("line", { class: "grid", x1: PADDING.left, x2: WIDTH - PADDING.right, y1: y(tick), y2: y(tick) }));
      const label = Svg.create("text", { class: "axis", x: PADDING.left - 8, y: y(tick) + 4, "text-anchor": "end" });
      label.textContent = this.compact(tick);
      svg.appendChild(label);
    }
    const band = plotWidth / Math.max(points.length, 1);
    const width = Math.min(BarChart.MAX_BAR, band * 0.6);
    const labelEvery = Math.ceil(points.length / 8);
    points.forEach((point, index) => {
      const center = PADDING.left + band * index + band / 2;
      if (point.value > 0) {
        svg.appendChild(Svg.create("path", { class: "bar", d: Svg.bar(center - width / 2, y(point.value), width, y(0) - y(point.value), 4) }));
      }
      if (point.reference !== undefined && point.reference !== null) {
        svg.appendChild(Svg.create("line", { class: "reference", x1: center - width / 2 - 4, x2: center + width / 2 + 4, y1: y(point.reference), y2: y(point.reference) }));
      }
      if (index % labelEvery === 0 || index === points.length - 1) {
        const label = Svg.create("text", { class: "axis", x: center, y: HEIGHT - 8, "text-anchor": "middle" });
        label.textContent = point.label;
        svg.appendChild(label);
      }
      const hit = Svg.create("rect", { class: "hit", x: center - band / 2, y: PADDING.top, width: band, height: plotHeight });
      const reveal = (event) => tooltip.show(this.describe(point), event.clientX, event.clientY);
      hit.addEventListener("pointerenter", reveal);
      hit.addEventListener("pointermove", reveal);
      hit.addEventListener("pointerleave", () => tooltip.hide());
      svg.appendChild(hit);
    });
    svg.appendChild(Svg.create("line", { class: "baseline", x1: PADDING.left, x2: WIDTH - PADDING.right, y1: y(0), y2: y(0) }));
    return svg;
  }

  describe(point) {
    const lines = [point.title ?? point.label, `${this.valueLabel}: ${point.value === null ? "не в клане" : this.format(point.value)}`];
    if (this.referenceLabel && point.reference !== undefined && point.reference !== null) {
      lines.push(`${this.referenceLabel}: ${this.format(point.reference)}`);
    }
    return lines;
  }

  table(points) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Таблица";
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const text of ["Неделя", this.valueLabel, this.referenceLabel].filter(Boolean)) {
      const cell = document.createElement("th");
      cell.textContent = text;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const point of points) {
      const row = body.insertRow();
      row.insertCell().textContent = point.title ?? point.label;
      row.insertCell().textContent = point.value === null ? "—" : this.format(point.value);
      if (this.referenceLabel) {
        row.insertCell().textContent = point.reference === null || point.reference === undefined ? "—" : this.format(point.reference);
      }
    }
    details.append(summary, table);
    return details;
  }

  ticks(peak) {
    const step = this.step ?? this.niceStep(peak / 3);
    const count = Math.max(1, Math.ceil(peak / step));
    return Array.from({ length: count + 1 }, (_, index) => index * step);
  }

  niceStep(rough) {
    const power = 10 ** Math.floor(Math.log10(rough));
    return [1, 2, 2.5, 5, 10].map((multiplier) => multiplier * power).find((candidate) => candidate >= rough);
  }

  compact(value) {
    return value >= 10000 ? `${value / 1000}k` : value.toLocaleString("ru-RU");
  }
}
