import type {
  Mark,
  Puzzle,
  ReplayEvent,
  ReplaySnapshot,
} from "../../../shared/types";

export interface ReplayState {
  /** 顺序执行到该位置后的棋盘，任意跳转结果与从头播放完全一致 */
  marks: Mark[];
  /** 由 hint 事件累计得到，撤销回放不会重复或退回计分 */
  hints: number;
  checks: number;
  /** 该位置之后是否已经出现完成事件 */
  solved: boolean;
  /** 完成事件（若已到达） */
  solveEvent: ReplayEvent | null;
}

export function emptyReplayState(size: number): ReplayState {
  return {
    marks: Array<Mark>(size * size).fill("unknown"),
    hints: 0,
    checks: 0,
    solved: false,
    solveEvent: null,
  };
}

function applyEvent(state: ReplayState, event: ReplayEvent): void {
  switch (event.type) {
    case "mark":
      if (event.index !== undefined && event.after)
        state.marks[event.index] = event.after;
      break;
    case "hint":
      // 提示计数只随 hint 事件增长；撤销事件只恢复棋盘，不退也不重复计分
      if (event.index !== undefined && event.after)
        state.marks[event.index] = event.after;
      if (event.hints !== undefined) state.hints = event.hints;
      break;
    case "undo":
      if (event.index !== undefined && event.before !== undefined)
        state.marks[event.index] = event.before;
      break;
    case "check":
      if (event.checks !== undefined) state.checks = event.checks;
      break;
    case "solve":
      state.solved = true;
      state.solveEvent = event;
      break;
    case "pause":
    case "resume":
      break;
  }
}

/** 找到不晚于 seq 的最新快照，作为重放起点。 */
export function nearestSnapshot(
  snapshots: ReplaySnapshot[],
  seq: number,
): ReplaySnapshot | null {
  let lo = 0;
  let hi = snapshots.length - 1;
  let found: ReplaySnapshot | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].seq <= seq) {
      found = snapshots[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 二分定位当前时间点所在的事件区间，返回尚未越过 at 的事件数。 */
export function eventsAt(timeline: ReplayEvent[], at: number): number {
  let lo = 0;
  let hi = timeline.length - 1;
  let cut = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].at <= at) {
      cut = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return cut;
}

/**
 * 从快照（或空盘）出发顺序执行事件，重建到目标 seq。
 * 纯函数、不依赖全局状态，因此任意跳转后的棋盘必然等同于
 * 按顺序执行到该位置的结果。
 */
export function projectToSeq(
  puzzle: Pick<Puzzle, "size">,
  timeline: ReplayEvent[],
  snapshots: ReplaySnapshot[],
  targetSeq: number,
): ReplayState {
  const state = emptyReplayState(puzzle.size);
  const base = nearestSnapshot(snapshots, targetSeq);
  let start = 0;
  if (base) {
    state.marks = [...base.marks];
    start = timeline.findIndex((e) => e.seq > base.seq);
    if (start < 0) start = timeline.length;
  }
  for (let i = start; i < timeline.length; i++) {
    const event = timeline[i];
    if (event.seq > targetSeq) break;
    applyEvent(state, event);
  }
  return state;
}

export function projectToEnd(
  puzzle: Pick<Puzzle, "size">,
  timeline: ReplayEvent[],
  snapshots: ReplaySnapshot[],
): ReplayState {
  const last = timeline.at(-1);
  return projectToSeq(
    puzzle,
    timeline,
    snapshots,
    last ? last.seq : 0,
  );
}

/** 还原真实停顿：返回事件在播放时间轴上的偏移毫秒（长间隔被压缩显示）。 */
export function playbackOffsets(
  timeline: ReplayEvent[],
  maxGapMs = 5000,
): number[] {
  const offsets: number[] = [];
  let offset = 0;
  timeline.forEach((event, i) => {
    if (i === 0) {
      offsets.push(0);
      return;
    }
    const gap = Math.min(
      Math.max(0, event.at - timeline[i - 1].at),
      maxGapMs,
    );
    offset += gap;
    offsets.push(offset);
  });
  return offsets;
}
