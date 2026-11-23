import { useMemo, useState } from "react";
import {
  ChevronFirst,
  ChevronLast,
  Download,
  FileDown,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Upload,
} from "lucide-react";
import type {
  Puzzle,
  ReplayEvent,
  ReplaySnapshot,
  SolveRecord,
} from "../../../shared/types";
import { useReplayPlayer, SPEEDS } from "../model/useReplayPlayer";
import {
  captureBundle,
  downloadReplayFile,
  type ReplayBundle,
} from "../model/bundle";
import { ReplayBoard } from "./ReplayBoard";

const EVENT_LABEL: Record<ReplayEvent["type"], string> = {
  mark: "填涂",
  undo: "撤销",
  hint: "提示",
  check: "检查",
  pause: "停顿",
  resume: "继续",
  solve: "完成",
};

function eventText(event: ReplayEvent, size: number): string {
  const row = event.index !== undefined ? Math.floor(event.index / size) + 1 : 0;
  const col = event.index !== undefined ? (event.index % size) + 1 : 0;
  switch (event.type) {
    case "mark":
      return `第 ${row} 行第 ${col} 列 → ${event.after === "filled" ? "填涂" : event.after === "cross" ? "标空" : "擦除"}`;
    case "hint":
      return `系统提示第 ${row} 行第 ${col} 列（累计 ${event.hints} 次）`;
    case "undo":
      return `撤销第 ${row} 行第 ${col} 列，恢复为${event.before === "unknown" ? "未知" : event.before === "filled" ? "填涂" : "标空"}`;
    case "check":
      return `检查当前标记（累计 ${event.checks} 次）`;
    case "pause":
      return "离开页面，计时暂停";
    case "resume":
      return "回到页面，继续解题";
    case "solve":
      return "图案揭晓，本题完成";
  }
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function ReplayPlayer({
  puzzle,
  timeline,
  snapshots,
  records,
  live,
  onImport,
  importError,
  onClearImportError,
}: {
  puzzle: Puzzle;
  timeline: ReplayEvent[];
  snapshots: ReplaySnapshot[];
  records: SolveRecord[];
  live: boolean;
  onImport: () => void;
  importError: string;
  onClearImportError: () => void;
}) {
  const player = useReplayPlayer(puzzle, timeline, snapshots);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "working" | "done">(
    "idle",
  );
  const [fromIndex, setFromIndex] = useState(0);
  const [toIndex, setToIndex] = useState(Math.max(0, timeline.length - 1));
  const currentEvent = timeline[player.currentIndex];

  const counts = useMemo(() => {
    let hints = 0;
    let checks = 0;
    let pauses = 0;
    let undos = 0;
    for (const e of timeline) {
      if (e.type === "hint") hints = e.hints ?? hints;
      if (e.type === "check") checks = e.checks ?? checks;
      if (e.type === "pause") pauses += 1;
      if (e.type === "undo") undos += 1;
    }
    return { hints, checks, pauses, undos };
  }, [timeline]);

  if (!timeline.length) {
    return (
      <div className="replay-empty">
        <p>{live ? "本题还没有可回放的操作。" : "这份回放不包含任何事件。"}</p>
        <div className="replay-import-row">
          <button onClick={onImport}>
            <Upload size={15} /> 导入回放文件
          </button>
          {importError && (
            <p className="replay-error" role="alert">
              {importError}
            </p>
          )}
        </div>
      </div>
    );
  }

  const startExport = (kind: "html" | "json") => {
    onClearImportError();
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    const range = {
      fromSeq: timeline[lo].seq,
      toSeq: timeline[hi].seq,
    };
    setExportState("working");
    // 先在当前时刻冻结完整区间，后续异步打包读取的都是这份快照
    const bundle: ReplayBundle = captureBundle(
      puzzle,
      timeline,
      snapshots,
      records,
      range,
    );
    // 模拟打包耗时：期间用户继续解题也不会改变 bundle 内容
    window.setTimeout(() => {
      downloadReplayFile(bundle, kind);
      setExportState("done");
      window.setTimeout(() => setExportState("idle"), 2200);
    }, 120);
  };

  return (
    <div className="replay-player">
      <div className="replay-main">
        <ReplayBoard
          puzzle={puzzle}
          marks={player.state.marks}
          highlight={currentEvent?.index ?? null}
        />
        <div className="replay-side">
          <div className="replay-stats">
            <div>
              <strong>{player.state.hints}</strong>
              <span>提示消耗</span>
            </div>
            <div>
              <strong>{player.state.checks}</strong>
              <span>检查次数</span>
            </div>
            <div>
              <strong>{clock(currentEvent?.seconds ?? 0)}</strong>
              <span>解题计时</span>
            </div>
            <div>
              <strong>{player.currentIndex + 1}/{timeline.length}</strong>
              <span>事件位置</span>
            </div>
          </div>
          <div className="replay-event-card" aria-live="polite">
            {currentEvent ? (
              <>
                <span className={`event-badge ${currentEvent.type}`}>
                  {EVENT_LABEL[currentEvent.type]}
                </span>
                <p>{eventText(currentEvent, puzzle.size)}</p>
                <small>
                  {new Date(currentEvent.at).toLocaleTimeString()} · 停顿已计入时间轴
                </small>
              </>
            ) : (
              <p className="muted">尚未开始播放，棋盘为初始空盘。</p>
            )}
            {player.state.solved && (
              <p className="replay-solved">图案已揭晓 · 完成时刻与原记录一致</p>
            )}
          </div>
          <div className="replay-summary muted">
            全程：提示 {counts.hints} 次 · 检查 {counts.checks} 次 · 撤销{" "}
            {counts.undos} 次 · 停顿 {counts.pauses} 次
          </div>
        </div>
      </div>

      <div className="replay-controls">
        <button
          aria-label="回到开头"
          onClick={() => player.seekToEventIndex(0)}
          disabled={player.currentIndex <= 0}
        >
          <ChevronFirst size={17} />
        </button>
        <button
          aria-label="上一事件"
          onClick={() => player.seekToEventIndex(player.currentIndex - 1)}
          disabled={player.currentIndex < 0}
        >
          <SkipBack size={17} />
        </button>
        <button className="primary replay-play" onClick={player.toggle}>
          {player.playing ? <Pause size={17} /> : <Play size={17} />}
          {player.playing ? "暂停" : "播放"}
        </button>
        <button
          aria-label="下一事件"
          onClick={() => player.seekToEventIndex(player.currentIndex + 1)}
          disabled={player.currentIndex >= timeline.length - 1}
        >
          <SkipForward size={17} />
        </button>
        <button
          aria-label="跳到结尾"
          onClick={() => player.seekToEventIndex(timeline.length - 1)}
          disabled={player.currentIndex >= timeline.length - 1}
        >
          <ChevronLast size={17} />
        </button>
        <label className="speed-select">
          倍速
          <select
            value={player.speed}
            onChange={(e) => player.setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>

      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={Math.max(0, timeline.length - 1)}
        value={Math.max(0, player.currentIndex)}
        onChange={(e) => player.seekToEventIndex(Number(e.target.value))}
        aria-label="回放进度"
      />

      <div className="replay-actions">
        <button onClick={() => setExportOpen((v) => !v)}>
          <Download size={15} /> 导出回放区间
        </button>
        <button onClick={onImport}>
          <Upload size={15} /> 导入回放
        </button>
        {importError && (
          <p className="replay-error" role="alert">
            {importError}
          </p>
        )}
      </div>

      {exportOpen && (
        <div className="export-panel">
          <h3>选择要导出的完整区间</h3>
          <p className="muted">
            从开始导出这一刻冻结所选区间；导出期间继续解题不会改变文件内容。
          </p>
          <div className="export-range">
            <label>
              起点事件
              <select
                value={Math.min(fromIndex, toIndex)}
                onChange={(e) => setFromIndex(Number(e.target.value))}
              >
                {timeline.map((e, i) => (
                  <option key={e.seq} value={i}>
                    #{i + 1} {EVENT_LABEL[e.type]}
                  </option>
                ))}
              </select>
            </label>
            <span>至</span>
            <label>
              终点事件
              <select
                value={Math.max(fromIndex, toIndex)}
                onChange={(e) => setToIndex(Number(e.target.value))}
              >
                {timeline.map((e, i) => (
                  <option key={e.seq} value={i}>
                    #{i + 1} {EVENT_LABEL[e.type]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="export-buttons">
            <button onClick={() => startExport("html")} disabled={exportState === "working"}>
              <FileDown size={15} /> 独立播放网页（HTML）
            </button>
            <button onClick={() => startExport("json")} disabled={exportState === "working"}>
              <Download size={15} /> 回放数据包（JSON）
            </button>
          </div>
          {exportState === "working" && (
            <p className="muted">正在冻结区间并打包…</p>
          )}
          {exportState === "done" && (
            <p className="replay-done">已导出，文件可独立播放，不会影响你的存档与收藏。</p>
          )}
        </div>
      )}

      <div className="replay-journal">
        <h3>事件流水（点击任意事件跳转）</h3>
        <div className="event-list">
          {timeline.map((event, i) => (
            <button
              key={event.seq}
              className={`event-row ${i === player.currentIndex ? "active" : ""} ${event.type}`}
              onClick={() => player.seekToEventIndex(i)}
            >
              <span className="event-no">{i + 1}</span>
              <span className={`event-badge ${event.type}`}>
                {EVENT_LABEL[event.type]}
              </span>
              <span className="event-desc">{eventText(event, puzzle.size)}</span>
              <span className="event-time">{clock(event.seconds)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
