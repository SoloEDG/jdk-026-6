export type Mark = "unknown" | "filled" | "cross";
export type Tool = "filled" | "cross" | "unknown";
export interface Puzzle {
  id: string;
  version: string;
  title: string;
  collection: string;
  level: "入门" | "进阶" | "挑战";
  size: number;
  solution: number[];
  color: string;
}
export interface Move {
  index: number;
  before: Mark;
  after: Mark;
}
export type ReplayEventType =
  | "mark"
  | "undo"
  | "hint"
  | "check"
  | "pause"
  | "resume"
  | "solve";
export interface ReplayEvent {
  /** 严格递增的事件序号，一次落笔/撤销/提示均占一个序号 */
  seq: number;
  type: ReplayEventType;
  /** 事件发生时的 epoch 毫秒时间戳，用于还原真实停顿 */
  at: number;
  /** 事件发生时解题计时（秒），与存档计时一致 */
  seconds: number;
  /** 棋盘格下标，mark / undo / hint 事件必填 */
  index?: number;
  /** 变更前的标记，撤销回放时恢复为该值 */
  before?: Mark;
  /** 变更后的标记，填涂/提示回放时写入该值 */
  after?: Mark;
  /** hint 事件后的累计提示消耗 */
  hints?: number;
  /** check 事件后的累计检查次数 */
  checks?: number;
}
export interface ReplaySnapshot {
  /** 对应事件 seq，棋盘快照在该事件执行完成后拍摄 */
  seq: number;
  marks: Mark[];
}
export interface Session {
  puzzleId: string;
  marks: Mark[];
  moves: Move[];
  hints: number;
  checks: number;
  seconds: number;
  solved: boolean;
  updatedAt: number;
  /** 追加式事件流，重新开始会清空 */
  timeline: ReplayEvent[];
  /** 周期性棋盘快照，避免每次跳转都从头重放、也避免每步复制整盘 */
  snapshots: ReplaySnapshot[];
  /** 已分配的最大事件 seq */
  seq: number;
  /** 累计棋盘变更次数，用于决定快照节拍 */
  mutationCount: number;
}
export interface SolveRecord {
  id: string;
  puzzleId: string;
  seconds: number;
  hints: number;
  checks: number;
  finishedAt: number;
}
export interface GameDocument {
  version: 2;
  activeId: string;
  sessions: Record<string, Session>;
  records: SolveRecord[];
  /** 加载/迁移过程中产生、需要明确告知用户的提示 */
  warnings: string[];
}
export type GameAction =
  | { type: "open"; id: string }
  | { type: "mark"; index: number; mark: Mark }
  | { type: "undo" }
  | { type: "hint"; index: number; mark: Mark }
  | { type: "check" }
  | { type: "tick" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" };
