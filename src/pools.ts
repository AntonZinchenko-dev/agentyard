// Лёгкий классификатор: какие задачи — «одна и та же правка в разных местах».
// Без модели: по форме путей файлов (один шаблон, разные имена сущностей) и по словам задачи.
//
// Такие задачи объединяются в пул: сначала делается одна — образец, остальные ждут;
// после принятия образца программа повторяет решение в остальных (см. rules.ts),
// а модели достаются только файлы, где повтор не встал, — уже с готовым решением и шагами.

import { plural } from './replicate.ts';
import type { Task } from './types.ts';

/** Части имени: слова в разных написаниях и разделители. AuditLogListPage.tsx → Audit Log List Page . tsx */
export function nameParts(seg: string): string[] {
  return seg.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [seg];
}

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();

/** Слова, которые называют вид файла, а не сущность. */
const KIND = new Set(['list', 'edit', 'view', 'create', 'new', 'detail', 'details', 'form', 'page', 'index', 'show', 'table', 'card', 'item', 'items', 'modal', 'dialog']);

function sameCore(a: [string, string], b: [string, string]): boolean {
  const eq = (x: string, y: string) => x === y || plural(x) === y || plural(y) === x;
  return eq(a[0], b[0]) && eq(a[1], b[1]);
}

/**
 * Общий шаблон двух путей: src/pages/address-list/ui/AddressListPage.tsx и …/user-list/ui/UserListPage.tsx
 * → src/pages/*-list/ui/*ListPage.tsx (core: address/user). Отличие должно быть одним и тем же «именем»
 * во всех отличающихся частях пути — иначе это разные файлы, а не однотипные.
 */
export function fileTemplate(a: string, b: string): { glob: string; core: [string, string] } | null {
  const A = a.replace(/\\/g, '/').split('/');
  const B = b.replace(/\\/g, '/').split('/');
  if (a === b || A.length !== B.length) return null;
  const ext = (s: string) => (s.match(/\.[^./]+$/) ?? [''])[0];
  if (ext(a) !== ext(b)) return null;
  let core: [string, string] | null = null;
  let diffs = 0;
  const out: string[] = [];
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) {
      out.push(A[i]!);
      continue;
    }
    if (++diffs > 3) return null;
    const pa = nameParts(A[i]!);
    const pb = nameParts(B[i]!);
    let p = 0;
    while (p < pa.length && p < pb.length && pa[p] === pb[p]) p++;
    let s = 0;
    while (s < pa.length - p && s < pb.length - p && pa[pa.length - 1 - s] === pb[pb.length - 1 - s]) s++;
    const ca = pa.slice(p, pa.length - s).join('');
    const cb = pb.slice(p, pb.length - s).join('');
    if (!/[A-Za-z]/.test(ca) || !/[A-Za-z]/.test(cb)) return null;
    const k: [string, string] = [kebab(ca), kebab(cb)];
    // address-list против user-edit: отличается и вид страницы — это разные файлы, а не однотипные
    const kindA = k[0].split('-').at(-1)!;
    const kindB = k[1].split('-').at(-1)!;
    if (kindA !== kindB && KIND.has(kindA) && KIND.has(kindB)) return null;
    if (core && !sameCore(core, k)) return null;
    core ??= k;
    out.push(`${pa.slice(0, p).join('')}*${pa.slice(pa.length - s).join('')}`);
  }
  return core ? { glob: out.join('/'), core } : null;
}

const STOP = new Set(['для', 'что', 'это', 'как', 'все', 'всех', 'его', 'или', 'при', 'без', 'над', 'под', 'чтобы', 'the', 'and', 'for', 'with', 'into', 'from', 'файл', 'файле', 'файлах', 'страниц', 'странице', 'страницы', 'page', 'file']);

/** Слова задачи без имён сущностей, путей и чисел; русские слова — по первым шести буквам. */
export function taskWords(t: Pick<Task, 'title' | 'brief'>, cores: string[]): Set<string> {
  let text = `${t.title} ${t.brief.slice(0, 500)}`.toLowerCase().replace(/ё/g, 'е');
  text = text.replace(/\S*[/\\]\S*/g, ' ').replace(/\b[\w-]+\.[a-z]{1,5}\b/g, ' ');
  for (const c of cores) {
    for (const form of new Set([c, plural(c), c.replace(/-/g, ''), plural(c).replace(/-/g, ''), ...c.split('-')])) {
      if (form.length >= 3) text = text.split(form).join(' ');
    }
  }
  const out = new Set<string>();
  for (const w of text.match(/\p{L}{3,}/gu) ?? []) if (!STOP.has(w)) out.add(w.slice(0, 6));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

export interface PoolMatch {
  /** Пары «файл образца → файл задачи» и шаблон каждой пары. */
  files: { example: string; target: string; glob: string }[];
  core: [string, string];
  similarity: number;
}

/** Делают ли две задачи одно и то же в разных однотипных файлах. */
export function sameSolution(leader: Task, other: Task): PoolMatch | null {
  if (leader.type !== other.type || leader.files.length !== other.files.length || leader.files.length === 0) return null;
  if ((leader.install ?? []).join() !== (other.install ?? []).join() && (other.install ?? []).length) return null;
  const used = new Set<string>();
  const files: PoolMatch['files'] = [];
  let core: [string, string] | null = null;
  for (const f of other.files) {
    let found: { example: string; glob: string; core: [string, string] } | null = null;
    for (const g of leader.files) {
      if (used.has(g)) continue;
      const tpl = fileTemplate(g, f);
      if (tpl && (!core || sameCore(core, tpl.core))) {
        found = { example: g, glob: tpl.glob, core: tpl.core };
        break;
      }
    }
    if (!found) return null;
    used.add(found.example);
    core ??= found.core;
    files.push({ example: found.example, target: f, glob: found.glob });
  }
  const sim = jaccard(taskWords(leader, [core![0]]), taskWords(other, [core![1]]));
  if (sim < 0.5) return null;
  return { files, core: core!, similarity: sim };
}

export interface PoolPlan {
  leader: string;
  members: string[];
  glob: string;
}

/** Не начатая обычная правка — кандидат в пул. */
export function poolable(t: Task): boolean {
  // задачи над документами (у каждой свой текст) не повторяют друг друга, даже если похожи по названию
  return t.type === 'edit' && !t.inputs?.length && !t.similar && !t.children?.length && !t.pool && t.attempts === 0 && !t.workdir && (t.status === 'waiting' || t.status === 'ready') && t.files.length > 0 && t.files.length <= 3;
}

/**
 * Группы однотипных задач. Порядок — как в конвейере: первый в группе становится образцом.
 * Задачи, зависящие друг от друга, в одну группу не попадают (это цепочка, а не повтор).
 */
export function classify(tasks: Task[], seqOf: (t: Task) => string = (t) => t.seq ?? t.id): PoolPlan[] {
  const cands = tasks.filter(poolable).sort((a, b) => (seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0));
  const related = (a: Task, b: Task) => a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id);
  const groups: { leader: Task; members: Task[]; glob: string }[] = [];
  for (const t of cands) {
    let placed = false;
    for (const g of groups) {
      if (g.members.some((m) => related(m, t))) continue;
      const m = sameSolution(g.leader, t);
      if (!m) continue;
      g.members.push(t);
      placed = true;
      break;
    }
    if (!placed) groups.push({ leader: t, members: [t], glob: '' });
  }
  return groups
    .filter((g) => g.members.length >= 2)
    .map((g) => ({ leader: g.leader.id, members: g.members.map((m) => m.id), glob: sameSolution(g.leader, g.members[1]!)?.files[0]?.glob ?? '' }));
}
