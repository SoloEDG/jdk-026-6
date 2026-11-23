import type { GameAction, GameDocument, Puzzle } from "../shared/types";
import { isSolved, newSession } from "../shared/document";
import { applyMark, undoMark } from "../features/board";
import { HINT_LIMIT } from "../features/assist";
import { registerSolve } from "../features/journal";
import { stampEvent } from "../features/replay/model/timeline";

export function transition(
  document: GameDocument,
  action: GameAction,
  puzzles: Puzzle[],
): GameDocument {
  const puzzle = puzzles.find((p) => p.id === document.activeId)!;
  const current = document.sessions[puzzle.id];
  if (action.type === "open") {
    const target = puzzles.find((p) => p.id === action.id);
    return target
      ? {
          ...document,
          activeId: target.id,
          sessions: {
            ...document.sessions,
            [target.id]: document.sessions[target.id] ?? newSession(target),
          },
        }
      : document;
  }
  let next = current;
  if (action.type === "mark") {
    const marked = applyMark(current, action.index, action.mark);
    if (marked !== current) {
      const move = marked.moves.at(-1)!;
      next = stampEvent(marked, {
        type: "mark",
        index: move.index,
        before: move.before,
        after: move.after,
      });
    }
  }
  if (action.type === "undo") {
    const move = current.moves.at(-1);
    const undone = undoMark(current);
    // 撤销同样进入事件流：回放按顺序恢复棋盘，但提示计数不退回
    if (undone !== current && move) {
      next = stampEvent(undone, {
        type: "undo",
        index: move.index,
        before: move.before,
        after: move.after,
      });
    }
  }
  if (action.type === "hint" && current.hints < HINT_LIMIT && !current.solved) {
    const marked = applyMark(current, action.index, action.mark);
    if (marked !== current) {
      const move = marked.moves.at(-1)!;
      next = stampEvent(
        { ...marked, hints: current.hints + 1 },
        {
          type: "hint",
          index: move.index,
          before: move.before,
          after: move.after,
          hints: current.hints + 1,
        },
      );
    }
  }
  if (action.type === "check" && !current.solved) {
    next = stampEvent(
      { ...current, checks: current.checks + 1, updatedAt: Date.now() },
      { type: "check", checks: current.checks + 1 },
    );
  }
  if (action.type === "tick" && !current.solved)
    next = { ...current, seconds: current.seconds + 1 };
  if ((action.type === "pause" || action.type === "resume") && !current.solved) {
    const last = current.timeline.at(-1);
    if (!last || last.type !== action.type)
      next = stampEvent({ ...current, updatedAt: Date.now() }, {
        type: action.type,
      });
  }
  if (action.type === "reset") next = newSession(puzzle);
  if (next === current) return document;
  const wasSolved = current.solved;
  next = { ...next, solved: isSolved(puzzle, next) };
  // 完成时刻只记录一次，且作为独立事件与解题记录使用同一时间基准
  let solvedAt: number | undefined;
  if (next.solved && !wasSolved) {
    solvedAt = Date.now();
    next = stampEvent(next, { type: "solve", at: solvedAt });
  }
  const withRecord = registerSolve(document, puzzle, next, solvedAt);
  return {
    ...withRecord,
    sessions: { ...withRecord.sessions, [puzzle.id]: next },
  };
}
