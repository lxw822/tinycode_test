/**
 * Minimal line diff for tool output previews.
 *
 * We compute a real LCS diff so `edit`/`write` can show `+a -d` counts and a
 * unified hunk — the model sees exactly what its own edit changed, which is
 * the cheapest self-verification loop.
 */

export interface DiffStats {
  added: number;
  removed: number;
}

export interface UnifiedDiffOptions {
  /** Context lines around each hunk. Default 3. */
  context?: number;
  oldLabel?: string;
  newLabel?: string;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** LCS table; O(n*m) — fine for tool-sized files, callers cap input. */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return table;
}

type Op = { kind: "same" | "add" | "del"; line: string; oldNo: number; newNo: number };

function diffOps(oldText: string, newText: string): Op[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", line: a[i]!, oldNo: i + 1, newNo: 0 });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]!, oldNo: 0, newNo: j + 1 });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "del", line: a[i]!, oldNo: i + 1, newNo: 0 });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "add", line: b[j]!, oldNo: 0, newNo: j + 1 });
    j++;
  }
  return ops;
}

export function diffStats(oldText: string, newText: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of diffOps(oldText, newText)) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

/** `+a -d` one-liner, e.g. `+12 -3`. */
export function diffSummary(oldText: string, newText: string): string {
  const { added, removed } = diffStats(oldText, newText);
  return `+${added} -${removed}`;
}

/** Unified diff text (empty string when there is no change). */
export function unifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  const context = options.context ?? 3;
  const ops = diffOps(oldText, newText);
  if (ops.every((op) => op.kind === "same")) return "";

  const oldLabel = options.oldLabel ?? "a";
  const newLabel = options.newLabel ?? "b";
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  // Group ops into hunks around changed regions.
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx]!.kind === "same") {
      idx++;
      continue;
    }
    // Expand to include surrounding context.
    let start = idx;
    while (start > 0 && ops[start - 1]!.kind === "same" && idx - start < context) start--;
    let end = idx;
    while (
      end < ops.length &&
      (ops[end]!.kind !== "same" || countTrailingSame(ops, idx, end) <= context * 2)
    ) {
      if (ops[end]!.kind !== "same") end++;
      else {
        end++;
        if (countTrailingSame(ops, idx, end) > context * 2) break;
      }
    }
    // Trim trailing context beyond `context`.
    let trailing = 0;
    let stop = end;
    while (stop > start && ops[stop - 1]!.kind === "same" && trailing < context) {
      stop--;
      trailing++;
    }

    const hunk = ops.slice(start, stop);
    const oldStart = hunk.find((op) => op.oldNo > 0)?.oldNo ?? 0;
    const newStart = hunk.find((op) => op.newNo > 0)?.newNo ?? 0;
    const oldCount = hunk.filter((op) => op.kind !== "add").length;
    const newCount = hunk.filter((op) => op.kind !== "del").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) {
      const marker = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
      out.push(`${marker}${op.line}`);
    }
    idx = stop;
  }
  return out.join("\n");
}

function countTrailingSame(ops: Op[], from: number, to: number): number {
  let count = 0;
  for (let k = to - 1; k >= from; k--) {
    if (ops[k]!.kind === "same") count++;
    else break;
  }
  return count;
}

/** First/last line numbers changed (1-based), for compact UI details. */
export function changedRange(
  oldText: string,
  newText: string,
): {
  firstChanged: number;
  lastChangedOld: number;
  lastChangedNew: number;
} {
  const ops = diffOps(oldText, newText);
  let firstChanged = 0;
  let lastChangedOld = 0;
  let lastChangedNew = 0;
  for (const op of ops) {
    if (op.kind === "same") continue;
    if (firstChanged === 0) firstChanged = op.oldNo > 0 ? op.oldNo : op.newNo;
    if (op.oldNo > 0) lastChangedOld = op.oldNo;
    if (op.newNo > 0) lastChangedNew = op.newNo;
  }
  return { firstChanged, lastChangedOld, lastChangedNew };
}
