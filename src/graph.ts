// Граф задач: зависимости, статусы, веса по критическому пути.

import { ROLE_FOR_TYPE } from './config.ts';
import type { PlannedTask, Task, TaskStatus } from './types.ts';

const pad = (n: number, w = 4) => String(n).padStart(w, '0');

export class TaskGraph {
  readonly tasks = new Map<string, Task>();
  /** Вызывается при любом изменении статусов или состава задач (для живой доски). */
  onChange?: () => void;
  /** Следующее место в очереди для задач верхнего уровня (план, доработки приёмки). */
  private nextSeq = 1;

  constructor(planned: PlannedTask[], now = Date.now()) {
    for (const p of planned) this.add(p, now);
    this.freezeUpstreamTests();
    this.recomputeWeights();
    this.refreshReady(now);
  }

  /**
   * Восстановить граф прерванного прогона: сделанное остаётся сделанным, начатое — снова к работе
   * (его рабочие копии потеряны вместе с упавшим процессом), ожидающие человека — у человека.
   */
  static restore(saved: Task[], now = Date.now()): TaskGraph {
    const g = new TaskGraph([], now);
    for (const t of saved) {
      const status = t.status === 'done' || t.status === 'human' || t.status === 'waiting' ? t.status : 'ready';
      g.tasks.set(t.id, { ...t, status, workdir: undefined, branch: undefined, createdHere: undefined, readySince: now });
    }
    // прогон до появления очереди: места по порядку задач
    let n = 0;
    for (const t of g.tasks.values()) {
      if (!t.seq) t.seq = pad(++n + 9000);
      const top = Number(t.seq.split('.')[0]);
      if (top >= g.nextSeq) g.nextSeq = top + 1;
    }
    for (const t of g.tasks.values()) {
      if (t.status === 'ready' && !t.dependsOn.every((d) => g.tasks.get(d)?.status === 'done')) t.status = 'waiting';
      if (t.children?.length && t.status === 'ready') t.status = 'waiting';
    }
    g.recomputeWeights();
    g.refreshReady(now);
    return g;
  }

  /**
   * Добавить задачи по ходу прогона (доработка после проверки цели, файлы пула).
   * after — встать в очередь сразу за этой задачей (части пула идут за образцом, а не в конец).
   */
  addPlanned(planned: PlannedTask[], now = Date.now(), after?: string): Task[] {
    const anchor = after ? this.tasks.get(after) : undefined;
    const taken = new Set(this.all().map((t) => t.seq));
    let k = 0;
    const nextAfter = () => {
      let s: string;
      do s = `${anchor!.seq}.p${pad(++k, 2)}`;
      while (taken.has(s));
      taken.add(s);
      return s;
    };
    const created = planned.map((p) => this.add(anchor?.stage && !p.stage ? { ...p, stage: anchor.stage } : p, now, anchor?.seq ? nextAfter() : undefined));
    this.freezeUpstreamTests();
    this.recomputeWeights();
    this.refreshReady(now);
    this.onChange?.();
    return created;
  }

  /** Тесты, написанные задачей-тестом, замораживаются для задач-правок, которые от неё зависят. */
  private freezeUpstreamTests(): void {
    for (const t of this.tasks.values()) {
      if (t.type !== 'edit') continue;
      for (const d of t.dependsOn) {
        const up = this.tasks.get(d);
        if (up?.type !== 'test') continue;
        const tests = up.files.filter((f) => t.accept.tests.includes(f));
        t.frozenFiles = [...new Set([...t.frozenFiles, ...tests])];
      }
    }
  }

  private add(p: PlannedTask, now: number, seq?: string): Task {
    const t: Task = {
      ...p,
      seq: seq ?? pad(this.nextSeq++),
      role: ROLE_FOR_TYPE[p.type],
      status: 'waiting',
      weight: 1,
      attempts: 0,
      ladderStep: 0,
      failures: [],
      readySince: now,
      // «сначала тест»: тест уже написан отдельной задачей, кодеру его менять нельзя
      frozenFiles: [...new Set([...(p.freeze ?? []), ...(p.type === 'edit' && p.testFirst ? p.accept.tests : [])])],
    };
    this.tasks.set(t.id, t);
    return t;
  }

  get(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Нет задачи ${id}`);
    return t;
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  /** Все задачи, которые зависят от данной (прямо или через других; родитель ждёт своих частей). */
  descendants(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const parent = this.tasks.get(cur)?.parent;
      if (parent && this.tasks.has(parent) && !out.has(parent)) {
        out.add(parent);
        stack.push(parent);
      }
      for (const t of this.tasks.values()) {
        if (t.dependsOn.includes(cur) && !out.has(t.id)) {
          out.add(t.id);
          stack.push(t.id);
        }
      }
    }
    return out;
  }

  /** Части задачи и части частей (вся матрёшка под ней). */
  parts(id: string): Task[] {
    const out: Task[] = [];
    for (const c of this.tasks.get(id)?.children ?? []) {
      const t = this.tasks.get(c);
      if (!t) continue;
      out.push(t, ...this.parts(c));
    }
    return out;
  }

  /** Составные задачи, у которых все части сделаны: их пора собрать. */
  assemblable(): Task[] {
    return this.all().filter((t) => t.children?.length && t.status === 'waiting' && t.children.every((c) => this.tasks.get(c)?.status === 'done'));
  }

  /** Вес задачи = 1 + число всех её потомков: сначала то, что разблокирует другие. */
  recomputeWeights(): void {
    for (const t of this.tasks.values()) t.weight = 1 + this.descendants(t.id).size;
  }

  /** Переводит «ожидающие» задачи в «готовые», если все предшественники сделаны. */
  refreshReady(now = Date.now()): Task[] {
    const became: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'waiting' || t.children?.length) continue;
      const depsDone = t.dependsOn.every((d) => this.tasks.get(d)?.status === 'done');
      if (depsDone) {
        t.status = 'ready';
        t.readySince = now;
        became.push(t);
      }
    }
    return became;
  }

  setStatus(id: string, status: TaskStatus, now = Date.now()): void {
    const t = this.get(id);
    t.status = status;
    if (status === 'ready') t.readySince = now;
    if (status === 'done') this.refreshReady(now);
    this.onChange?.();
  }

  byStatus(status: TaskStatus): Task[] {
    return this.all().filter((t) => t.status === status);
  }

  isFinished(): boolean {
    return this.all().every((t) => t.status === 'done' || t.status === 'human');
  }

  /** Есть ли ещё работа, которую можно сделать без человека. */
  hasActiveWork(): boolean {
    return this.all().some((t) => ['ready', 'running', 'checking', 'review'].includes(t.status));
  }

  /**
   * Матрёшка (ступень 4 и «другой подход»): задача разбивается на части, но не исчезает —
   * она становится составной и ждёт, пока все части будут сделаны; потом её собирают (проверяют её критерий).
   * Части наследуют её зависимости и встают в очередь на её место. Кто ждал задачу — ждёт её сборки.
   */
  split(id: string, parts: PlannedTask[], now = Date.now()): Task[] {
    const parent = this.get(id);
    const created: Task[] = [];
    const have = parent.children?.length ?? 0;
    parts.forEach((p, i) => {
      const t = this.add({ ...p, parent: id, stage: parent.stage, dependsOn: [...new Set([...parent.dependsOn, ...p.dependsOn])] }, now, `${parent.seq ?? pad(this.nextSeq++)}.${pad(have + i + 1, 2)}`);
      t.frozenFiles = [...new Set([...t.frozenFiles, ...parent.frozenFiles])];
      created.push(t);
    });
    parent.children = [...(parent.children ?? []), ...created.map((c) => c.id)];
    parent.status = 'waiting';
    parent.workdir = undefined;
    parent.branch = undefined;
    this.recomputeWeights();
    this.refreshReady(now);
    this.onChange?.();
    return created;
  }

  /** Глубина дробления хранится в id: T3 → T3.1 → T3.1.2. */
  static splitDepth(id: string): number {
    return id.split('.').length - 1;
  }

  /** Глубина в матрёшке: сколько предков у задачи (части пула «по образцу» — не матрёшка). */
  depth(id: string): number {
    let d = 0;
    for (let cur = this.tasks.get(id)?.parent; cur && d < 10; cur = this.tasks.get(cur)?.parent) d++;
    return d;
  }
}
