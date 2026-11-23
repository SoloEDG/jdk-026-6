import type { ReplayEvent, ReplayEventType, ReplaySnapshot, Session } from "../../../shared/types";

/** 每累计多少次棋盘变更拍摄一次整盘快照 */
export const SNAPSHOT_EVERY = 50;
/** 单题事件流长度上限，防止本地存档无限膨胀 */
export const MAX_EVENTS = 6000;
/** 超过上限时从头部裁掉的事件数（保留一个快照节拍对齐量） */
const TRIM_STEP = 1000;

const MUTATING_TYPES: ReadonlySet<ReplayEventType> = new Set([
  "mark",
  "undo",
  "hint",
]);

export interface NewEvent {
  type: ReplayEventType;
  at?: number;
  index?: number;
  before?: ReplayEvent["before"];
  after?: ReplayEvent["after"];
  hints?: number;
  checks?: number;
}

/**
 * 向追加式事件流写入一个事件，并按节拍拍摄棋盘快照。
 * 快照只引用当前 marks 数组的副本，事件本身只存单格差异，
 * 因此长记录的体积随事件数线性增长，而不是每次落笔复制整盘。
 */
export function stampEvent(session: Session, event: NewEvent): Session {
  const seq = session.seq + 1;
  const full: ReplayEvent = {
    seq,
    type: event.type,
    at: event.at ?? Date.now(),
    seconds: session.seconds,
  };
  if (event.index !== undefined) full.index = event.index;
  if (event.before !== undefined) full.before = event.before;
  if (event.after !== undefined) full.after = event.after;
  if (event.hints !== undefined) full.hints = event.hints;
  if (event.checks !== undefined) full.checks = event.checks;

  let timeline = [...session.timeline, full];
  let snapshots = session.snapshots;
  let mutationCount = session.mutationCount;
  if (MUTATING_TYPES.has(event.type)) mutationCount += 1;

  if (mutationCount > 0 && mutationCount % SNAPSHOT_EVERY === 0) {
    const snapshot: ReplaySnapshot = {
      seq,
      marks: [...session.marks],
    };
    snapshots = [...snapshots, snapshot];
  }

  if (timeline.length > MAX_EVENTS) {
    const trimmed = trimTimeline(timeline, snapshots, TRIM_STEP);
    timeline = trimmed.timeline;
    snapshots = trimmed.snapshots;
  }

  return { ...session, timeline, snapshots, seq, mutationCount };
}

/** 丢弃最早的一段事件，同时删掉落在被丢弃区间内的快照，seq 不回收。 */
export function trimTimeline(
  timeline: ReplayEvent[],
  snapshots: ReplaySnapshot[],
  count: number,
): { timeline: ReplayEvent[]; snapshots: ReplaySnapshot[] } {
  const dropBeforeSeq = timeline[Math.min(count, timeline.length) - 1].seq;
  return {
    timeline: timeline.filter((e) => e.seq > dropBeforeSeq),
    snapshots: snapshots.filter((s) => s.seq > dropBeforeSeq),
  };
}

/**
 * 校验从本地存档读出的事件流：结构、序号连续性以及与棋盘快照的一致性。
 * 损坏时返回明确原因，由存储层决定丢弃并提示，绝不展示错位的回放。
 */
export function validateStoredTimeline(
  timeline: unknown,
  snapshots: unknown,
  marksLength: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(timeline)) return { ok: false, reason: "事件流不是数组" };
  const known = new Set<ReplayEventType>([
    "mark",
    "undo",
    "hint",
    "check",
    "pause",
    "resume",
    "solve",
  ]);
  let lastSeq = 0;
  for (const raw of timeline as unknown[]) {
    const e = raw as ReplayEvent;
    if (!e || typeof e !== "object")
      return { ok: false, reason: "存在无法解析的事件" };
    if (typeof e.seq !== "number" || e.seq !== Math.trunc(e.seq) || e.seq <= 0)
      return { ok: false, reason: "事件序号非法" };
    if (e.seq <= lastSeq) return { ok: false, reason: "事件序号不连续" };
    lastSeq = e.seq;
    if (!known.has(e.type))
      return { ok: false, reason: `未知事件类型 ${String(e.type)}` };
    if (typeof e.at !== "number" || !Number.isFinite(e.at))
      return { ok: false, reason: "事件时间戳缺失" };
    if (
      typeof e.seconds !== "number" ||
      e.seconds < 0 ||
      e.seconds !== Math.trunc(e.seconds)
    )
      return { ok: false, reason: "事件计时非法" };
    if (e.type === "mark" || e.type === "hint" || e.type === "undo") {
      if (
        typeof e.index !== "number" ||
        e.index < 0 ||
        e.index >= marksLength
      )
        return { ok: false, reason: "事件指向了不存在的棋盘格" };
      if (e.type !== "undo" && !e.after)
        return { ok: false, reason: "填涂事件缺少目标标记" };
    }
    if (e.type === "hint" && typeof e.hints !== "number")
      return { ok: false, reason: "提示事件缺少消耗记录" };
    if (e.type === "check" && typeof e.checks !== "number")
      return { ok: false, reason: "检查事件缺少次数记录" };
  }
  if (!Array.isArray(snapshots))
    return { ok: false, reason: "快照集合不是数组" };
  let lastSnapshotSeq = 0;
  for (const raw of snapshots as unknown[]) {
    const s = raw as ReplaySnapshot;
    if (!s || typeof s !== "object")
      return { ok: false, reason: "存在无法解析的快照" };
    if (typeof s.seq !== "number" || s.seq <= lastSnapshotSeq)
      return { ok: false, reason: "快照序号非法" };
    if (!Array.isArray(s.marks) || s.marks.length !== marksLength)
      return { ok: false, reason: "快照棋盘尺寸不匹配" };
    if (!s.marks.every((m) => ["unknown", "filled", "cross"].includes(m)))
      return { ok: false, reason: "快照包含非法标记" };
    if (!timeline.some((e) => (e as ReplayEvent).seq === s.seq))
      return { ok: false, reason: "快照找不到对应事件" };
    lastSnapshotSeq = s.seq;
  }
  return { ok: true };
}
