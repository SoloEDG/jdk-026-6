import { BookOpen, Clock3, Award, ArrowRight, Save, Film } from "lucide-react";
import type { GameDocument, Puzzle } from "../../../shared/types";
import { recordSummary, formatTime } from "../lib/summary";
export function JournalPanel({
  document,
  puzzles,
  saveState,
  onSave,
  onOpen,
  onReplay,
}: {
  document: GameDocument;
  puzzles: Puzzle[];
  saveState: string;
  onSave: () => void;
  onOpen: (id: string) => void;
  onReplay: (id: string) => void;
}) {
  const stats = recordSummary(document.records);
  return (
    <section className="journal panel">
      <div className="journal-heading">
        <div>
          <span className="eyebrow">YOUR QUIET ACHIEVEMENTS</span>
          <h2>
            <BookOpen size={18} />
            解题手记
          </h2>
        </div>
        <button className="save-button" onClick={onSave}>
          <Save size={14} />
          {saveState}
        </button>
      </div>
      <div className="record-stats">
        <span>
          <Award size={17} />
          <strong>{stats.solves}</strong> 幅已完成
        </span>
        <span>
          <Clock3 size={16} />
          <strong>{stats.minutes}</strong> 分钟专注
        </span>
        <span>
          <strong>{stats.unassisted}</strong> 次独立解答
        </span>
      </div>
      {document.records.length ? (
        <div className="records">
          {document.records.slice(0, 5).map((r) => (
            <div className="record-row" key={r.id}>
              <button className="record-main" onClick={() => onOpen(r.puzzleId)}>
                <span>{puzzles.find((p) => p.id === r.puzzleId)?.title}</span>
                <small>
                  {formatTime(r.seconds)} · 提示 {r.hints} 次
                </small>
                <ArrowRight size={15} />
              </button>
              <button
                className="record-replay"
                title="回看这局的解题过程"
                aria-label="回看这局的解题过程"
                onClick={() => onReplay(r.puzzleId)}
              >
                <Film size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-record">
          <span>还没有完成记录</span>
          <p>每一次揭晓，都值得记上一笔。</p>
          <span className="empty-line" />
        </div>
      )}
    </section>
  );
}
