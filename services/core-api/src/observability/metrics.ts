/**
 * A small Prometheus registry: counters, gauges and histograms rendered in the
 * text exposition format (version 0.0.4). Written here rather than pulled in
 * as a dependency because core-api needs a dozen metrics, not a client library,
 * and every label set must stay bounded (no tenant, user or invoice ids).
 */

export type Labels = Readonly<Record<string, string>>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Guards against an unbounded label value (a path, an id) slipping into a series key. */
export const MAX_SERIES_PER_METRIC = 500;

export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/** Escape a label value per the exposition format: backslash, quote and newline. */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escape HELP text: backslash and newline only. */
export function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Render a number the way Prometheus parses it. */
export function formatValue(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const pairs = names.map((n, i) => `${n}="${escapeLabelValue(values[i] ?? '')}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

interface MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
}

interface Renderable extends MetricBase {
  readonly type: 'counter' | 'gauge' | 'histogram';
  render(): string[];
}

abstract class Metric<S> implements Renderable {
  protected readonly series = new Map<string, { values: string[]; state: S }>();
  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
    for (const l of labelNames) {
      if (!LABEL_RE.test(l) || l.startsWith('__')) throw new Error(`invalid label name on ${name}: ${l}`);
    }
    if (new Set(labelNames).size !== labelNames.length) throw new Error(`duplicate label name on ${name}`);
  }

  protected abstract initial(): S;

  protected slot(labels: Labels | undefined): S {
    const given = labels ?? {};
    const keys = Object.keys(given);
    if (keys.length !== this.labelNames.length || keys.some((k) => !this.labelNames.includes(k))) {
      throw new Error(`${this.name} takes labels [${this.labelNames.join(', ')}], got [${keys.join(', ')}]`);
    }
    const values = this.labelNames.map((n) => String(given[n]));
    const key = values.join('\u0000');
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) throw new Error(`${this.name} exceeded ${MAX_SERIES_PER_METRIC} series`);
      entry = { values, state: this.initial() };
      this.series.set(key, entry);
    }
    return entry.state;
  }

  /** Number of label combinations seen so far. */
  get size(): number {
    return this.series.size;
  }

  reset(): void {
    this.series.clear();
  }

  header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): string[];
}

export class Counter extends Metric<{ v: number }> {
  readonly type = 'counter';
  protected initial() {
    return { v: 0 };
  }

  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) throw new Error(`${this.name}: counters only go up (got ${by})`);
    this.slot(labels).v += by;
  }

  get(labels?: Labels): number {
    return this.slot(labels).v;
  }

  render(): string[] {
    const lines = this.header();
    for (const { values, state } of this.series.values()) lines.push(`${this.name}${renderLabels(this.labelNames, values)} ${formatValue(state.v)}`);
    return lines;
  }
}

export class Gauge extends Metric<{ v: number }> {
  readonly type = 'gauge';
  protected initial() {
    return { v: 0 };
  }

  set(value: number, labels?: Labels): void {
    this.slot(labels).v = value;
  }

  inc(labels?: Labels, by = 1): void {
    this.slot(labels).v += by;
  }

  get(labels?: Labels): number {
    return this.slot(labels).v;
  }

  render(): string[] {
    const lines = this.header();
    for (const { values, state } of this.series.values()) lines.push(`${this.name}${renderLabels(this.labelNames, values)} ${formatValue(state.v)}`);
    return lines;
  }
}

interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric<HistogramState> {
  readonly type = 'histogram';
  readonly buckets: readonly number[];

  constructor(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = DEFAULT_BUCKETS) {
    super(name, help, labelNames);
    if (labelNames.includes('le')) throw new Error(`${name}: "le" is reserved for histogram buckets`);
    if (buckets.length === 0) throw new Error(`${name}: a histogram needs at least one bucket`);
    for (let i = 1; i < buckets.length; i++) {
      if (!((buckets[i] as number) > (buckets[i - 1] as number))) throw new Error(`${name}: buckets must be strictly increasing`);
    }
    this.buckets = buckets;
  }

  protected initial(): HistogramState {
    return { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  observe(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    const s = this.slot(labels);
    s.sum += value;
    s.count += 1;
    // Cumulative: every bucket whose upper bound is at least the value.
    for (let i = 0; i < this.buckets.length; i++) if (value <= (this.buckets[i] as number)) s.counts[i] = (s.counts[i] as number) + 1;
  }

  /** Time an async function and observe its duration in seconds, whether it resolves or throws. */
  async time<T>(labels: Labels | undefined, fn: () => Promise<T>, now: () => number = defaultClock): Promise<T> {
    const start = now();
    try {
      return await fn();
    } finally {
      this.observe((now() - start) / 1000, labels);
    }
  }

  snapshot(labels?: Labels): { buckets: number[]; sum: number; count: number } {
    const s = this.slot(labels);
    return { buckets: [...s.counts], sum: s.sum, count: s.count };
  }

  render(): string[] {
    const lines = this.header();
    for (const { values, state } of this.series.values()) {
      this.buckets.forEach((b, i) => {
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, values, ['le', formatValue(b)])} ${formatValue(state.counts[i] as number)}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, values, ['le', '+Inf'])} ${formatValue(state.count)}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, values)} ${formatValue(state.sum)}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, values)} ${formatValue(state.count)}`);
    }
    return lines;
  }
}

function defaultClock(): number {
  return performance.now();
}

/** Runs before each scrape to refresh gauges that are cheaper to read than to track. */
export type Collector = () => void | Promise<void>;

export class Registry {
  private readonly metrics = new Map<string, Renderable>();
  private readonly collectors: Collector[] = [];

  register<M extends Renderable>(metric: M): M {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} is already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.register(new Gauge(name, help, labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets?: readonly number[]): Histogram {
    return this.register(new Histogram(name, help, labelNames, buckets));
  }

  addCollector(c: Collector): void {
    this.collectors.push(c);
  }

  names(): string[] {
    return [...this.metrics.keys()].sort();
  }

  get(name: string): Renderable | undefined {
    return this.metrics.get(name);
  }

  /**
   * Run collectors, then render every metric. A failing collector is reported
   * through `onCollectorError` and never fails the scrape: stale gauges beat a
   * missing /metrics.
   */
  async render(onCollectorError?: (err: unknown) => void): Promise<string> {
    for (const c of this.collectors) {
      try {
        await c();
      } catch (err) {
        onCollectorError?.(err);
      }
    }
    const lines: string[] = [];
    for (const name of this.names()) lines.push(...(this.metrics.get(name) as Renderable).render());
    return `${lines.join('\n')}\n`;
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
