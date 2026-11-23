import type {
  GameDocument,
  Mark,
  Puzzle,
  ReplayEvent,
  ReplaySnapshot,
  Session,
} from "../../../shared/types";
import { newDocument, newSession, isSolved } from "../../../shared/document";
import { validateStoredTimeline } from "../../replay/model/timeline";
const KEY = "gejian.document.v1";

function sanitizeSession(
  saved: Partial<Session> | undefined,
  puzzle: Puzzle,
  warnings: string[],
): Session | null {
  const base = newSession(puzzle);
  if (
    !saved ||
    !Array.isArray(saved.marks) ||
    saved.marks.length !== puzzle.size ** 2 ||
    !saved.marks.every((m: Mark) =>
      ["filled", "unknown", "cross"].includes(m),
    )
  )
    return null;
  const session: Session = {
    ...base,
    marks: saved.marks,
    hints: Math.min(3, Math.max(0, Number(saved.hints) || 0)),
    checks: Math.max(0, Number(saved.checks) || 0),
    seconds: Math.max(0, Number(saved.seconds) || 0),
    updatedAt: Date.now(),
  };
  const hasTimeline = "timeline" in saved;
  if (hasTimeline) {
    const result = validateStoredTimeline(
      saved.timeline,
      saved.snapshots,
      puzzle.size ** 2,
    );
    if (result.ok) {
      const timeline = saved.timeline as ReplayEvent[];
      const snapshots = saved.snapshots as ReplaySnapshot[];
      // 事件流末尾的投影必须与存档棋盘一致，否则视为损坏，宁可不播放
      const last = timeline.at(-1);
      if (last) {
        const check = checkTailConsistency(timeline, puzzle, session);
        if (check) {
          warnings.push(
            `「${puzzle.title}」的回放记录与当前棋盘不一致（${check}），已保留进度但关闭该题回放。`,
          );
        } else {
          session.timeline = timeline;
          session.snapshots = snapshots;
          session.seq = last.seq;
          session.mutationCount = timeline.filter(
            (e) => e.type === "mark" || e.type === "undo" || e.type === "hint",
          ).length;
        }
      }
    } else {
      warnings.push(
        `「${puzzle.title}」的回放记录已损坏（${result.reason}），已保留解题进度但关闭该题回放。`,
      );
    }
  }
  return { ...session, solved: isSolved(puzzle, session) };
}

/** 用纯投影重放完整事件流，核对最终棋盘与提示/检查计数。 */
function checkTailConsistency(
  timeline: ReplayEvent[],
  puzzle: Puzzle,
  session: Session,
): string {
  let marks: Mark[] = Array(puzzle.size ** 2).fill("unknown");
  let hints = 0;
  let checks = 0;
  for (const e of timeline) {
    if (e.type === "mark" && e.index !== undefined && e.after)
      marks[e.index] = e.after;
    else if (e.type === "hint" && e.index !== undefined && e.after) {
      marks[e.index] = e.after;
      if (e.hints !== undefined) hints = e.hints;
    } else if (e.type === "undo" && e.index !== undefined && e.before !== undefined)
      marks[e.index] = e.before;
    else if (e.type === "check" && e.checks !== undefined) checks = e.checks;
  }
  if (!marks.every((m, i) => m === session.marks[i]))
    return "棋盘对不上";
  if (hints !== session.hints) return "提示次数对不上";
  if (checks !== session.checks) return "检查次数对不上";
  return "";
}

export function loadDocument(puzzles: Puzzle[]): {
  document: GameDocument;
  warning: string;
} {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { document: newDocument(puzzles[0]), warning: "" };
    const data = JSON.parse(raw) as Partial<GameDocument> & {
      version?: number;
    };
    if (
      data == null ||
      typeof data !== "object" ||
      ![1, 2].includes(data.version ?? 1) ||
      !data.sessions ||
      !Array.isArray(data.records)
    )
      throw Error("unsupported");
    const warnings: string[] = [];
    const version: number = data.version ?? 1;
    const migrated = version === 1;
    if (migrated)
      warnings.push(
        "这是升级前的存档：旧进度已保留，但当时的操作没有逐格记录，无法回放升级前的解题过程。",
      );
    const sessions: GameDocument["sessions"] = {};
    for (const puzzle of puzzles) {
      const session = sanitizeSession(
        data.sessions[puzzle.id] as Partial<Session> | undefined,
        puzzle,
        warnings,
      );
      if (session) sessions[puzzle.id] = session;
    }
    const active = puzzles.find((p) => p.id === data.activeId) ?? puzzles[0];
    sessions[active.id] ??= newSession(active);
    const records = data.records.filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        puzzles.some((p) => p.id === r.puzzleId) &&
        Number.isFinite(r.seconds) &&
        Number.isFinite(r.finishedAt) &&
        Number.isFinite(r.hints) &&
        Number.isFinite(r.checks),
    );
    return {
      document: {
        version: 2,
        activeId: active.id,
        sessions,
        records,
        warnings,
      },
      warning: warnings.join(" "),
    };
  } catch {
    return {
      document: newDocument(puzzles[0]),
      warning:
        "存档无法读取，已打开新的解题页。原存档未覆盖，请手动保存新进度。",
    };
  }
}
export function saveDocument(document: GameDocument): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(document));
    return true;
  } catch {
    return false;
  }
}
