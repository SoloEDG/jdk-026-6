import type {
  Puzzle,
  ReplayEvent,
  ReplaySnapshot,
  SolveRecord,
} from "../../../shared/types";
import { validateStoredTimeline } from "./timeline";
import { projectToEnd, projectToSeq } from "./projection";

export const BUNDLE_FORMAT = "gejian.replay";
export const BUNDLE_VERSION = 1;

export interface ReplayBundle {
  format: typeof BUNDLE_FORMAT;
  bundleVersion: number;
  exportedAt: number;
  /** 导出时选定的完整区间（按事件 seq 描述，含两端） */
  range: { fromSeq: number; toSeq: number };
  puzzle: {
    id: string;
    version: string;
    title: string;
    collection: string;
    level: Puzzle["level"];
    size: number;
    solution: number[];
    color: string;
  };
  events: ReplayEvent[];
  snapshots: ReplaySnapshot[];
  /** 区间结束时刻的提示消耗 / 检查次数 / 计时，与原记录核对用 */
  totals: { hints: number; checks: number; seconds: number };
  /** 若区间包含完成事件，则快照对应解题记录的关键数字 */
  record:
    | { seconds: number; hints: number; checks: number; finishedAt: number }
    | null;
}

export type ReplayImportError =
  | "cancelled"
  | "unreadable"
  | "format"
  | "puzzle-missing"
  | "puzzle-version"
  | "corrupt"
  | "mismatch";

export const IMPORT_ERROR_TEXT: Record<ReplayImportError, string> = {
  cancelled: "未选择文件，已取消导入。",
  unreadable: "文件无法读取，请确认它是格间导出的回放文件。",
  format: "文件格式不是格间回放（缺少格式标识或版本不支持）。",
  "puzzle-missing":
    "当前题库中找不到这道题：题目可能已下架，无法还原对应棋盘。",
  "puzzle-version":
    "题目版本与导出时不一致：为避免错位，已拒绝打开该回放。",
  corrupt: "回放记录已损坏，无法保证棋盘与操作一致，已停止打开。",
  mismatch:
    "回放的提示消耗、检查次数或完成时刻与内嵌记录不一致，已停止打开。",
};

/**
 * 捕获导出区间。调用即对当前数据做浅拷贝快照：
 * 导出打包期间继续解题，只会改动新的数组，不会进入这份 bundle。
 */
export function captureBundle(
  puzzle: Puzzle,
  timeline: ReplayEvent[],
  snapshots: ReplaySnapshot[],
  records: SolveRecord[],
  range: { fromSeq: number; toSeq: number },
): ReplayBundle {
  const fromSeq = Math.max(0, Math.floor(range.fromSeq));
  const toSeq = Math.max(fromSeq, Math.floor(range.toSeq));
  const events = timeline
    .filter((e) => e.seq >= fromSeq && e.seq <= toSeq)
    .map((e) => ({ ...e }));
  // 只保留区间内或刚好位于区间起点之前的最近快照，并平移到区间坐标系
  const baseSnapshots = snapshots
    .filter((s) => s.seq <= toSeq)
    .map((s) => ({ seq: s.seq, marks: [...s.marks] }));
  const state = projectToSeq(puzzle, timeline, snapshots, toSeq);
  const solveEvent = events.find((e) => e.type === "solve") ?? null;
  const record = solveEvent
    ? (() => {
        const match = records.find(
          (r) =>
            r.puzzleId === puzzle.id &&
            r.seconds === solveEvent.seconds &&
            r.hints === state.hints &&
            r.checks === state.checks &&
            r.finishedAt === solveEvent.at,
        );
        return match
          ? {
              seconds: match.seconds,
              hints: match.hints,
              checks: match.checks,
              finishedAt: match.finishedAt,
            }
          : {
              seconds: solveEvent.seconds,
              hints: state.hints,
              checks: state.checks,
              finishedAt: solveEvent.at,
            };
      })()
    : null;
  return {
    format: BUNDLE_FORMAT,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: Date.now(),
    range: { fromSeq, toSeq },
    puzzle: {
      id: puzzle.id,
      version: puzzle.version,
      title: puzzle.title,
      collection: puzzle.collection,
      level: puzzle.level,
      size: puzzle.size,
      solution: [...puzzle.solution],
      color: puzzle.color,
    },
    events,
    snapshots: baseSnapshots,
    totals: {
      hints: state.hints,
      checks: state.checks,
      seconds: events.at(-1)?.seconds ?? 0,
    },
    record,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 严格校验导入内容；任何一环失败都返回明确错误码而不是“看起来正常”。 */
export function validateBundle(
  bundle: unknown,
  puzzles: Puzzle[],
):
  | { ok: true; bundle: ReplayBundle; puzzle: Puzzle }
  | { ok: false; error: ReplayImportError; detail?: string } {
  if (!isRecord(bundle)) return { ok: false, error: "format" };
  if (
    bundle.format !== BUNDLE_FORMAT ||
    bundle.bundleVersion !== BUNDLE_VERSION
  )
    return { ok: false, error: "format" };
  const head = bundle.puzzle;
  if (!isRecord(head) || typeof head.id !== "string")
    return { ok: false, error: "format" };
  const puzzle = puzzles.find((p) => p.id === head.id);
  if (!puzzle) return { ok: false, error: "puzzle-missing" };
  if (typeof head.version !== "string" || !head.version)
    return { ok: false, error: "puzzle-version" };
  if (head.version !== puzzle.version)
    return { ok: false, error: "puzzle-version" };
  const sizeOk =
    typeof head.size === "number" &&
    head.size === puzzle.size &&
    Array.isArray(head.solution) &&
    head.solution.length === puzzle.size ** 2 &&
    head.solution.every((v) => v === 0 || v === 1);
  if (!sizeOk) return { ok: false, error: "corrupt", detail: "题目尺寸或答案损坏" };
  const structural = validateStoredTimeline(
    bundle.events,
    bundle.snapshots,
    puzzle.size ** 2,
  );
  if (!structural.ok)
    return { ok: false, error: "corrupt", detail: structural.reason };
  const b = bundle as unknown as ReplayBundle;
  if (
    !b.range ||
    b.events.some((e) => e.seq < b.range.fromSeq || e.seq > b.range.toSeq)
  )
    return { ok: false, error: "corrupt", detail: "事件超出导出区间" };
  // 用纯投影重放整段，核对提示与检查次数。中途填错再改正是合法过程，
  // 因此不拿答案比对棋盘；完整性改由“快照必须与投影逐格一致”来保证。
  const end = projectToEnd(puzzle, b.events, b.snapshots);
  for (const snapshot of b.snapshots) {
    const projected = projectToSeq(
      puzzle,
      b.events,
      [],
      snapshot.seq,
    );
    if (!projected.marks.every((m, i) => m === snapshot.marks[i]))
      return {
        ok: false,
        error: "corrupt",
        detail: "快照与事件投影不一致",
      };
  }
  if (end.hints !== b.totals.hints || end.checks !== b.totals.checks)
    return { ok: false, error: "mismatch", detail: "提示/检查计数与汇总不一致" };
  if (end.solved) {
    if (!b.record || !end.solveEvent)
      return { ok: false, error: "mismatch", detail: "缺少完成记录" };
    if (
      b.record.finishedAt !== end.solveEvent.at ||
      b.record.hints !== end.hints ||
      b.record.checks !== end.checks ||
      b.record.seconds !== end.solveEvent.seconds
    )
      return { ok: false, error: "mismatch", detail: "完成时刻或消耗与事件不一致" };
  }
  return { ok: true, bundle: b, puzzle };
}

/** 从文件文本中解析回放：优先 JSON，其次独立 HTML 内嵌数据。 */
export function parseReplayText(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(text);
  const marker = "<!--GEJIAN-REPLAY-DATA:";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("missing-marker");
  const dataStart = start + marker.length;
  const end = text.indexOf("-->", dataStart);
  if (end < 0) throw new Error("missing-marker-end");
  return JSON.parse(text.slice(dataStart, end));
}

/** 生成可独立打开播放的单文件 HTML，回放数据内嵌其中。 */
export function standaloneHtml(bundle: ReplayBundle): string {
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(bundle.puzzle.title)} · 格间解题回放</title>
<style>
:root{font-family:"Noto Sans SC",system-ui,sans-serif;color:#34435a;background:#edf1f7}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px}
.card{background:#fff;border:1px solid #e6ebf2;border-radius:20px;padding:26px;max-width:760px;width:100%;box-shadow:0 18px 50px #40577f14}
h1{font-size:21px;margin:0 0 4px}
.meta{font-size:12px;color:#929eaf;margin-bottom:18px}
.grid{display:grid;gap:2px;margin:0 auto;width:min(70vh,420px);aspect-ratio:1}
.cell{background:#f2f4f8;border-radius:3px}
.cell.filled{background:${escapeHtml(bundle.puzzle.color)}}
.cell.cross{background:#f7f9fc;position:relative}
.cell.cross::after{content:"×";position:absolute;inset:0;display:grid;place-items:center;color:#aab6c6;font-size:11px}
.controls{display:flex;align-items:center;gap:10px;margin-top:20px;flex-wrap:wrap}
button{border:1px solid #d8e0ec;background:#fff;border-radius:10px;padding:8px 14px;color:#34435a;cursor:pointer;font:inherit}
button.primary{background:#57759f;color:#fff;border-color:#57759f}
input[type=range]{flex:1;min-width:160px;accent-color:#57759f}
.stats{display:flex;gap:18px;font-size:12px;color:#6b7a90;margin-top:14px}
.stats b{display:block;font-size:16px;color:#34435a}
.badge{display:inline-block;font-size:11px;background:#eef2f8;border-radius:999px;padding:3px 10px;margin-left:8px;vertical-align:middle}
.badge.solve{background:#e4f2e8;color:#3f7d52}
.error{color:#b04a4a;font-size:13px;margin-top:12px;white-space:pre-wrap}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(bundle.puzzle.title)}<span class="badge">${escapeHtml(bundle.puzzle.collection)} · ${bundle.puzzle.size}×${bundle.puzzle.size}</span>${bundle.record ? '<span class="badge solve">已完成</span>' : ""}</h1>
<div class="meta">独立回放文件 · 导出于 ${new Date(bundle.exportedAt).toLocaleString()}</div>
<div id="grid" class="grid" role="img" aria-label="解题棋盘回放"></div>
<div class="controls">
<button id="play" class="primary">播放</button>
<button id="prev">上一事件</button>
<button id="next">下一事件</button>
<label style="font-size:12px">倍速
<select id="speed">
<option value="0.5">0.5×</option>
<option value="1" selected>1×</option>
<option value="2">2×</option>
<option value="4">4×</option>
<option value="8">8×</option>
</select></label>
<input id="seek" type="range" min="0" max="0" value="0"/>
<span id="clock" style="font-size:12px;color:#6b7a90"></span>
</div>
<div class="stats">
<div><b id="hints">0</b>提示消耗</div>
<div><b id="checks">0</b>检查次数</div>
<div><b id="eventpos">0 / 0</b>事件进度</div>
<div><b id="timer">00:00</b>解题计时</div>
</div>
<div id="error" class="error"></div>
</div>
<!--GEJIAN-REPLAY-DATA:${json}-->
<script>
(function(){
"use strict";
var bundle;
try{
var raw=document.documentElement.innerHTML;
var marker="<!--GEJIAN-REPLAY-DATA:";
var s=raw.indexOf(marker)+marker.length;
bundle=JSON.parse(raw.slice(s,raw.indexOf("-->",s)));
if(bundle.format!=="gejian.replay")throw new Error("bad-format");
}catch(err){document.getElementById("error").textContent="回放文件损坏，无法播放（"+err.message+"）。";return;}
var events=bundle.events,size=bundle.puzzle.size,n=size*size;
var grid=document.getElementById("grid");
grid.style.gridTemplateColumns="repeat("+size+",1fr)";
var cells=[];
for(var i=0;i<n;i++){var c=document.createElement("div");c.className="cell";grid.appendChild(c);cells.push(c);}
var seek=document.getElementById("seek");seek.max=String(Math.max(0,events.length-1));
var pos=-1,playing=false,raTimer=null,lastWall=0,playedMs=0,speed=1;
function stateAt(target){
var marks=new Array(n).fill("unknown"),hints=0,checks=0,solved=false;
for(var k=0;k<=target&&k<events.length;k++){
var e=events[k];
if(e.type==="mark"&&e.index!=null&&e.after)marks[e.index]=e.after;
else if(e.type==="hint"){if(e.index!=null&&e.after)marks[e.index]=e.after;if(e.hints!=null)hints=e.hints;}
else if(e.type==="undo"&&e.index!=null&&e.before!=null)marks[e.index]=e.before;
else if(e.type==="check"&&e.checks!=null)checks=e.checks;
else if(e.type==="solve")solved=true;
}
return{marks:marks,hints:hints,checks:checks,solved:solved,event:target>=0?events[target]:null};
}
function render(target){
if(target<0){target=-1;}
if(target>=events.length)target=events.length-1;
pos=target;
var st=stateAt(target);
for(var i=0;i<n;i++){cells[i].className="cell "+st.marks[i];}
document.getElementById("hints").textContent=st.hints;
document.getElementById("checks").textContent=st.checks;
document.getElementById("eventpos").textContent=(target+1)+" / "+events.length;
var sec=target>=0?events[target].seconds:0;
document.getElementById("timer").textContent=String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0");
seek.value=String(Math.max(0,target));
document.getElementById("clock").textContent=target>=0?new Date(events[target].at).toLocaleTimeString():"";
document.getElementById("play").textContent=playing?"暂停":"播放";
}
// 播放时间轴：真实停顿超过 5 秒的间隔被压缩，避免长时间黑屏等待
var offsets=[];
(function(){
var acc=0;
for(var k=0;k<events.length;k++){
if(k===0){offsets.push(0);continue;}
var gap=Math.min(Math.max(0,events[k].at-events[k-1].at),5000);
acc+=gap;offsets.push(acc);
}
})();
function stop(){playing=false;if(raTimer){cancelAnimationFrame(raTimer);raTimer=null;}lastWall=0;}
function tick(now){
if(!playing)return;
if(!lastWall)lastWall=now;
playedMs+=(now-lastWall)*speed;lastWall=now;
var idx=0;
while(idx<offsets.length&&offsets[idx]<=playedMs)idx++;
if(idx>=events.length){
render(events.length-1);stop();return;
}
render(idx-1);
raTimer=requestAnimationFrame(tick);
}
document.getElementById("play").onclick=function(){
if(pos>=events.length-1){pos=-1;playedMs=0;}
playing=!playing;lastWall=0;
if(playing)raTimer=requestAnimationFrame(tick);render(pos);
};
document.getElementById("next").onclick=function(){stop();render(Math.min(events.length-1,pos+1));playedMs=pos>=0?offsets[pos]:0;};
document.getElementById("prev").onclick=function(){stop();render(Math.max(-1,pos-1));playedMs=pos>=0?offsets[pos]:0;};
document.getElementById("speed").onchange=function(e){speed=Number(e.target.value);};
seek.oninput=function(e){stop();var t=Number(e.target.value);render(t);playedMs=offsets[t]||0;};
render(-1);
})();
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function downloadReplayFile(
  bundle: ReplayBundle,
  kind: "html" | "json",
): void {
  const content = kind === "html" ? standaloneHtml(bundle) : JSON.stringify(bundle, null, 2);
  const mime = kind === "html" ? "text/html" : "application/json";
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `gejian-replay-${bundle.puzzle.id}-${bundle.range.fromSeq}-${bundle.range.toSeq}.${kind}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
