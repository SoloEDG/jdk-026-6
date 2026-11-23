import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { puzzles } from "../src/features/catalog/model/puzzles";
import { newDocument, newSession } from "../src/shared/document";
import { transition } from "../src/app/reducer";
import {
  SNAPSHOT_EVERY,
  MAX_EVENTS,
  stampEvent,
  trimTimeline,
  validateStoredTimeline,
} from "../src/features/replay/model/timeline";
import {
  projectToSeq,
  projectToEnd,
  eventsAt,
  playbackOffsets,
} from "../src/features/replay/model/projection";
import {
  captureBundle,
  validateBundle,
  parseReplayText,
  standaloneHtml,
  IMPORT_ERROR_TEXT,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
} from "../src/features/replay/model/bundle";
import { loadDocument, saveDocument } from "../src/features/journal/lib/storage";
import type { ReplayEvent, Session } from "../src/shared/types";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
let stored: string | null = null;
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => stored,
    setItem: (_: string, value: string) => {
      stored = value;
    },
  },
  configurable: true,
});

const p = puzzles[1]; // 5x5 heart

function play(
  actions: Parameters<typeof transition>[1][],
  puzzle = p,
): ReturnType<typeof newDocument> {
  let d = newDocument(puzzle);
  for (const a of actions) d = transition(d, a, puzzles);
  return d;
}

test("每次填涂与撤销都产生严格递增事件，且事件可完整还原棋盘", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "mark", index: 2, mark: "cross" }, puzzles);
  d = transition(d, { type: "undo" }, puzzles);
  const session = d.sessions[p.id];
  assert.equal(session.timeline.length, 3);
  assert.deepEqual(
    session.timeline.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    session.timeline.map((e) => e.type),
    ["mark", "mark", "undo"],
  );
  // 任意位置投影 = 顺序执行到该位置
  const at2 = projectToSeq(p, session.timeline, session.snapshots, 2);
  assert.equal(at2.marks[1], "filled");
  assert.equal(at2.marks[2], "cross");
  const at3 = projectToSeq(p, session.timeline, session.snapshots, 3);
  assert.equal(at3.marks[2], "unknown");
  assert.deepEqual(at3.marks, session.marks);
});

test("撤销不会退回或重复计算提示消耗，投影计数只由 hint 事件决定", () => {
  let d = newDocument(p);
  const before = d.sessions[p.id].hints;
  d = transition(d, { type: "hint", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "undo" }, puzzles);
  d = transition(d, { type: "hint", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "undo" }, puzzles);
  const session = d.sessions[p.id];
  assert.equal(session.hints, 2);
  const end = projectToEnd(p, session.timeline, session.snapshots);
  assert.equal(end.hints, 2, "重放撤销后提示数仍然是 2");
  assert.equal(end.marks[1], "unknown", "棋盘格被撤销回未知");
  // 跳到第一次提示之后
  const hintSeq = session.timeline.find((e) => e.type === "hint")!.seq;
  const mid = projectToSeq(p, session.timeline, session.snapshots, hintSeq);
  assert.equal(mid.hints, 1);
  assert.equal(mid.marks[1], "filled");
  assert.equal(before, 0);
});

test("检查事件记录累计次数，停顿与继续事件不改变棋盘", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "check" }, puzzles);
  d = transition(d, { type: "pause" }, puzzles);
  d = transition(d, { type: "pause" }, puzzles); // 连续停顿不重复记录
  d = transition(d, { type: "resume" }, puzzles);
  const session = d.sessions[p.id];
  assert.deepEqual(
    session.timeline.map((e) => e.type),
    ["mark", "check", "pause", "resume"],
  );
  const end = projectToEnd(p, session.timeline, session.snapshots);
  assert.equal(end.checks, 1);
  assert.equal(end.marks[1], "filled");
});

test("完成事件与解题记录共享同一时刻，且只生成一次", () => {
  let d = newDocument(p);
  p.solution.forEach((v, index) => {
    if (v) d = transition(d, { type: "mark", index, mark: "filled" }, puzzles);
  });
  const session = d.sessions[p.id];
  const solveEvent = session.timeline.find((e) => e.type === "solve");
  assert.ok(solveEvent, "事件流中必须有完成事件");
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].finishedAt, solveEvent!.at);
  assert.equal(d.records[0].hints, session.hints);
  // 完成后再操作不再产生事件，记录不重复
  const len = session.timeline.length;
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  assert.equal(d.sessions[p.id].timeline.length, len);
  assert.equal(d.records.length, 1);
  const projected = projectToEnd(p, session.timeline, session.snapshots);
  assert.equal(projected.solved, true);
  assert.equal(projected.solveEvent!.at, solveEvent!.at);
});

test("快照按固定节拍生成，长记录只保存周期性整盘而非每步复制", () => {
  let session = newSession(p);
  // 与真实 reducer 一致：事件引用的棋盘与 session.marks 同步推进
  for (let i = 0; i < SNAPSHOT_EVERY * 2 + 3; i++) {
    const index = i % (p.size * p.size);
    const marks = [...session.marks];
    marks[index] = "filled";
    session = { ...session, marks };
    session = stampEvent(session, {
      type: "mark",
      index,
      before: "unknown",
      after: "filled",
    });
  }
  assert.equal(session.snapshots.length, 2);
  assert.equal(session.snapshots[0].seq, SNAPSHOT_EVERY);
  assert.equal(session.snapshots[1].seq, SNAPSHOT_EVERY * 2);
  // 利用快照跳转与从头重放结果一致
  const target = SNAPSHOT_EVERY + 7;
  const viaSnapshot = projectToSeq(p, session.timeline, session.snapshots, target);
  const fromScratch = projectToSeq(p, session.timeline, [], target);
  assert.deepEqual(viaSnapshot.marks, fromScratch.marks);
});

test("事件流超过上限时裁剪旧事件与失效快照，序号不回收且仍可投影", () => {
  const timeline: ReplayEvent[] = [];
  for (let seq = 1; seq <= MAX_EVENTS + 5; seq++) {
    timeline.push({
      seq,
      type: "mark",
      at: seq,
      seconds: seq,
      index: seq % 25,
      after: "filled",
    });
  }
  const snapshots = [
    { seq: 50, marks: Array(25).fill("unknown") },
    { seq: 1500, marks: Array(25).fill("filled") },
  ];
  const result = trimTimeline(timeline, snapshots, 1000);
  assert.equal(result.timeline.length, timeline.length - 1000);
  assert.equal(result.timeline[0].seq, 1001);
  assert.ok(result.snapshots.every((s) => s.seq > 1000));
  assert.equal(result.snapshots.length, 1);
});

test("损坏的时间线与快照被明确拒绝，不会静默播放错位内容", () => {
  const good: ReplayEvent[] = [
    { seq: 1, type: "mark", at: 1, seconds: 0, index: 0, after: "filled" },
  ];
  assert.equal(validateStoredTimeline(good, [], 25).ok, true);
  assert.equal(
    validateStoredTimeline([{ ...good[0], seq: 0 }], [], 25).ok,
    false,
  );
  assert.equal(
    validateStoredTimeline([{ ...good[0], type: "weird" }], [], 25).ok,
    false,
  );
  assert.equal(
    validateStoredTimeline(good, [{ seq: 99, marks: Array(25).fill("unknown") }], 25)
      .ok,
    false,
    "快照找不到对应事件",
  );
  assert.equal(
    validateStoredTimeline(
      [{ ...good[0], index: 16 }],
      [],
      16,
    ).ok,
    false,
    "事件指向越界格子",
  );
  assert.equal(
    validateStoredTimeline(
      [{ seq: 1, type: "mark", at: 1, seconds: 0, index: 0 }],
      [],
      25,
    ).ok,
    false,
    "填涂事件缺少目标标记",
  );
});

test("重新开始清空事件流，新旧两局互不串线", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "reset" }, puzzles);
  const session = d.sessions[p.id];
  assert.equal(session.timeline.length, 0);
  assert.equal(session.snapshots.length, 0);
  assert.equal(session.seq, 0);
  d = transition(d, { type: "mark", index: 2, mark: "cross" }, puzzles);
  assert.equal(d.sessions[p.id].timeline.length, 1);
  assert.equal(d.sessions[p.id].timeline[0].seq, 1);
});

test("导出区间在捕获时冻结，之后继续解题不改变 bundle 内容", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  d = transition(d, { type: "mark", index: 1, mark: "filled" }, puzzles);
  const sessionAtCapture = d.sessions[p.id];
  const bundle = captureBundle(
    p,
    sessionAtCapture.timeline,
    sessionAtCapture.snapshots,
    d.records,
    { fromSeq: 1, toSeq: 2 },
  );
  // 捕获后继续真实解题
  d = transition(d, { type: "mark", index: 2, mark: "cross" }, puzzles);
  d = transition(d, { type: "check" }, puzzles);
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.range.toSeq, 2);
  assert.ok(!bundle.events.some((e) => e.seq >= 3));
  const result = validateBundle(bundle, puzzles);
  assert.equal(result.ok, true);
});

test("部分区间导出同样可通过校验并独立投影", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  d = transition(d, { type: "check" }, puzzles);
  d = transition(d, { type: "mark", index: 1, mark: "cross" }, puzzles);
  const s = d.sessions[p.id];
  const bundle = captureBundle(p, s.timeline, s.snapshots, d.records, {
    fromSeq: 2,
    toSeq: 3,
  });
  assert.deepEqual(bundle.events.map((e) => e.type), ["check", "mark"]);
  assert.equal(validateBundle(bundle, puzzles).ok, true);
});

test("独立 HTML 内嵌完整数据，可被重新解析并通过校验", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  const s = d.sessions[p.id];
  const bundle = captureBundle(p, s.timeline, s.snapshots, d.records, {
    fromSeq: 1,
    toSeq: 1,
  });
  const html = standaloneHtml(bundle);
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("GEJIAN-REPLAY-DATA"));
  const reparsed = parseReplayText(html);
  const result = validateBundle(reparsed, puzzles);
  assert.equal(result.ok, true);
  assert.equal(parseReplayText(JSON.stringify(bundle)).format, BUNDLE_FORMAT);
});

test("导入校验覆盖格式、题目缺失、题目版本不一致与计数错位", () => {
  let d = newDocument(p);
  d = transition(d, { type: "hint", index: 0, mark: "filled" }, puzzles);
  const s = d.sessions[p.id];
  const bundle = captureBundle(p, s.timeline, s.snapshots, d.records, {
    fromSeq: 1,
    toSeq: 1,
  });
  assert.equal(validateBundle(null, puzzles).ok, false);
  assert.equal(validateBundle({}, puzzles).error, "format");
  const missingPuzzle = {
    ...bundle,
    puzzle: { ...bundle.puzzle, id: "ghost-puzzle" },
  };
  assert.equal(validateBundle(missingPuzzle, puzzles).error, "puzzle-missing");
  const otherVersion = {
    ...bundle,
    puzzle: { ...bundle.puzzle, version: "999" },
  };
  assert.equal(
    validateBundle(otherVersion, puzzles).error,
    "puzzle-version",
  );
  const tampered = {
    ...bundle,
    totals: { ...bundle.totals, hints: 99 },
  };
  assert.equal(validateBundle(tampered, puzzles).error, "mismatch");
  const corrupted = {
    ...bundle,
    events: [{ seq: 1, type: "mark", at: 1, seconds: 0, index: 0 }],
  };
  assert.equal(validateBundle(corrupted, puzzles).error, "corrupt");
  assert.equal(BUNDLE_VERSION, 1);
});

test("完成局导出的 bundle 内嵌记录与完成事件的时刻和消耗一致", () => {
  let d = newDocument(p);
  d = transition(d, { type: "hint", index: 1, mark: "filled" }, puzzles);
  d = transition(d, { type: "check" }, puzzles);
  p.solution.forEach((v, index) => {
    if (v) d = transition(d, { type: "mark", index, mark: "filled" }, puzzles);
  });
  const s = d.sessions[p.id];
  const bundle = captureBundle(
    p,
    s.timeline,
    s.snapshots,
    d.records,
    { fromSeq: 1, toSeq: s.timeline.at(-1)!.seq },
  );
  assert.ok(bundle.record);
  assert.equal(bundle.record!.finishedAt, d.records[0].finishedAt);
  assert.equal(bundle.record!.hints, 1);
  assert.equal(bundle.record!.checks, 1);
  assert.equal(validateBundle(bundle, puzzles).ok, true);
});

test("v1 存档迁移保留进度但明确提示无法回放升级前过程", () => {
  const legacy = {
    version: 1,
    activeId: p.id,
    sessions: {
      [p.id]: {
        puzzleId: p.id,
        marks: Array(p.size ** 2).fill("unknown"),
        moves: [],
        hints: 1,
        checks: 0,
        seconds: 12,
        solved: false,
        updatedAt: 0,
      },
    },
    records: [],
  };
  stored = JSON.stringify(legacy);
  const loaded = loadDocument(puzzles);
  assert.equal(loaded.document.version, 2);
  assert.equal(loaded.document.sessions[p.id].hints, 1);
  assert.equal(loaded.document.sessions[p.id].timeline.length, 0);
  assert.ok(loaded.warning.includes("升级前"));
  assert.equal(loaded.document.warnings.length, 1);
});

test("损坏回放的存档保留解题进度、关闭该题回放并给出原因", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 1, mark: "filled" }, puzzles);
  const raw = JSON.parse(JSON.stringify(d)) as typeof d;
  raw.version = 2;
  // 故意让事件投影与棋盘不一致
  raw.sessions[p.id].timeline[0].after = "cross";
  stored = JSON.stringify(raw);
  const loaded = loadDocument(puzzles);
  assert.equal(loaded.document.sessions[p.id].marks[1], "filled", "进度保留");
  assert.equal(
    loaded.document.sessions[p.id].timeline.length,
    0,
    "损坏回放被关闭",
  );
  assert.ok(loaded.warning.includes("不一致"));
});

test("保存再读取后事件流、快照与投影棋盘完整保留", () => {
  stored = null;
  // 15x15 灯塔有足够格子，保证 55 次落笔互不重复，必然产生一个快照
  const big = puzzles.find((x) => x.id === "lighthouse")!;
  let d = newDocument(big);
  for (let i = 0; i < SNAPSHOT_EVERY + 5; i++) {
    d = transition(
      d,
      { type: "mark", index: i, mark: "filled" },
      puzzles,
    );
  }
  assert.ok(saveDocument(d));
  const restored = loadDocument(puzzles);
  const session = restored.document.sessions[big.id];
  assert.equal(session.timeline.length, d.sessions[big.id].timeline.length);
  assert.equal(session.snapshots.length, 1);
  const end = projectToEnd(big, session.timeline, session.snapshots);
  assert.deepEqual(end.marks, session.marks);
});

test("时间轴工具：二分定位与停顿压缩", () => {
  const timeline: ReplayEvent[] = [
    { seq: 1, type: "mark", at: 100, seconds: 0, index: 0, after: "filled" },
    { seq: 2, type: "pause", at: 500, seconds: 1 },
    { seq: 3, type: "resume", at: 60000, seconds: 1 },
    { seq: 4, type: "mark", at: 60200, seconds: 2, index: 1, after: "cross" },
  ];
  assert.equal(eventsAt(timeline, 499), 1);
  assert.equal(eventsAt(timeline, 500), 2);
  assert.equal(eventsAt(timeline, 70000), 4);
  const offsets = playbackOffsets(timeline, 5000);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 400);
  // 59.5 秒的长停顿被压缩到 5 秒
  assert.equal(offsets[2], 5400);
  assert.equal(offsets[3], 5600);
});

test("回放全程为纯投影：反复跳转任一事件棋盘始终一致", () => {
  let d = newDocument(p);
  const actions: Parameters<typeof transition>[1][] = [];
  p.solution.forEach((v, index) => {
    if (v) actions.push({ type: "mark", index, mark: "filled" });
  });
  actions.push({ type: "undo" });
  actions.push({ type: "check" });
  actions.push({ type: "mark", index: 6, mark: "cross" });
  d = play(actions);
  const s = d.sessions[p.id];
  for (const event of s.timeline) {
    const a = projectToSeq(p, s.timeline, s.snapshots, event.seq);
    const b = projectToSeq(p, s.timeline, [], event.seq);
    assert.deepEqual(a.marks, b.marks, `seq ${event.seq} 两条路径投影一致`);
    assert.equal(a.hints, b.hints);
    assert.equal(a.checks, b.checks);
  }
  const end = projectToEnd(p, s.timeline, s.snapshots);
  assert.deepEqual(end.marks, s.marks);
});

test("空事件流也能安全投影为空盘", () => {
  const session = newSession(p);
  const state = projectToEnd(p, session.timeline, session.snapshots);
  assert.equal(state.marks.length, p.size ** 2);
  assert.ok(state.marks.every((m) => m === "unknown"));
  assert.equal(state.hints, 0);
  assert.equal(state.checks, 0);
  assert.equal(state.solved, false);
});

test("导出打包期间继续解题，文件仍只包含开始导出时选定的完整区间", () => {
  let d = newDocument(p);
  for (const index of [0, 1, 2]) {
    d = transition(d, { type: "mark", index, mark: "filled" }, puzzles);
  }
  const capturedAt = d.sessions[p.id];
  // 模拟用户点击导出：先捕获区间（captureBundle 内部复制事件与快照）
  const bundle = captureBundle(
    p,
    capturedAt.timeline,
    capturedAt.snapshots,
    d.records,
    { fromSeq: capturedAt.timeline[0].seq, toSeq: capturedAt.timeline.at(-1)!.seq },
  );
  // 打包尚未结束，用户继续真实解题：撤销、提示、检查、再落笔
  d = transition(d, { type: "undo" }, puzzles);
  d = transition(d, { type: "hint", index: 3, mark: "cross" }, puzzles);
  d = transition(d, { type: "check" }, puzzles);
  d = transition(d, { type: "mark", index: 4, mark: "filled" }, puzzles);
  // bundle 内的数组引用与内容都不受后续操作影响
  assert.equal(bundle.events.length, 3);
  assert.deepEqual(
    bundle.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(bundle.totals.hints, 0);
  assert.equal(bundle.totals.checks, 0);
  // 而真实存档已经走远
  assert.ok(d.sessions[p.id].timeline.length > 3);
  assert.equal(validateBundle(bundle, puzzles).ok, true);
  // 真实存档与导出文件互不污染
  const html = standaloneHtml(bundle);
  const reparsed = parseReplayText(html) as typeof bundle;
  assert.equal(reparsed.events.length, 3);
});

test("损坏文件与缺少标识的内容给出明确错误，而不是展示错位回放", () => {
  assert.throws(() => parseReplayText("<html>没有任何回放数据</html>"));
  assert.throws(() => parseReplayText("{broken json"));
  const wrongMarker = standaloneHtml(
    captureBundle(
      p,
      [],
      [],
      [],
      { fromSeq: 0, toSeq: 0 },
    ),
  ).replace("GEJIAN-REPLAY-DATA", "TAMPERED");
  assert.throws(() => parseReplayText(wrongMarker));
  const foreign = validateBundle(
    { format: "something-else", bundleVersion: 1 },
    puzzles,
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.error, "format");
});

test("缺失题目版本与未知题目都被拒绝并返回可展示的中文提示", () => {
  let d = newDocument(p);
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  const s = d.sessions[p.id];
  const bundle = captureBundle(p, s.timeline, s.snapshots, d.records, {
    fromSeq: 1,
    toSeq: 1,
  });
  const noVersion = { ...bundle, puzzle: { ...bundle.puzzle, version: "" } };
  assert.equal(validateBundle(noVersion, puzzles).error, "puzzle-version");
  const unknownId = {
    ...bundle,
    puzzle: { ...bundle.puzzle, id: "removed", version: "1" },
  };
  assert.equal(validateBundle(unknownId, puzzles).error, "puzzle-missing");
  for (const code of [
    "cancelled",
    "unreadable",
    "format",
    "puzzle-missing",
    "puzzle-version",
    "corrupt",
    "mismatch",
  ] as const) {
    assert.ok(IMPORT_ERROR_TEXT[code].length > 0);
  }
});
