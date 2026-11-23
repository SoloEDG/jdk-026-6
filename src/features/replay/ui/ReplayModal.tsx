import { useMemo, useState } from "react";
import { X, Film } from "lucide-react";
import type { GameDocument, Puzzle } from "../../../shared/types";
import { useReplayImport, type ImportedReplay } from "../model/useReplayImport";
import { ReplayPlayer } from "./ReplayPlayer";

/**
 * 回放弹层：内部只有“投影棋盘”，不持有任何 dispatch/save 入口，
 * 因此任何跳转、播放、导入、导出都不会改写原存档或发放收藏。
 */
export function ReplayModal({
  document,
  puzzles,
  puzzle,
  onClose,
}: {
  document: GameDocument;
  puzzles: Puzzle[];
  puzzle: Puzzle;
  onClose: () => void;
}) {
  const session = document.sessions[puzzle.id];
  const [imported, setImported] = useState<ImportedReplay | null>(null);
  const importer = useReplayImport(puzzles);

  const source = useMemo(() => {
    if (imported) {
      return {
        puzzle: imported.puzzle,
        timeline: imported.bundle.events,
        snapshots: imported.bundle.snapshots,
        live: false,
        title: imported.puzzle.title,
        note: "正在查看导入的回放文件 · 仅预览，不会写入存档",
      };
    }
    return {
      puzzle,
      timeline: session?.timeline ?? [],
      snapshots: session?.snapshots ?? [],
      live: true,
      title: puzzle.title,
      note: "本题真实解题过程的回放 · 与解题页面互不干扰",
    };
  }, [imported, puzzle, session]);

  return (
    <div className="modal-backdrop replay-backdrop" onMouseDown={onClose}>
      <section
        className="modal replay-modal"
        role="dialog"
        aria-modal="true"
        aria-label="解题回放"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="modal-close" aria-label="关闭回放" onClick={onClose}>
          <X size={19} />
        </button>
        <div className="replay-heading">
          <span className="eyebrow">
            <Film size={13} /> REPLAY · 解题回放
          </span>
          <h2>{source.title}</h2>
          <p className="muted">{source.note}</p>
        </div>
        {imported && (
          <button className="replay-exit-import" onClick={() => setImported(null)}>
            ← 返回本题的真实解题回放
          </button>
        )}
        <ReplayPlayer
          puzzle={source.puzzle}
          timeline={source.timeline}
          snapshots={source.snapshots}
          records={document.records}
          live={source.live}
          onImport={async () => {
            const result = await importer.pickFile();
            if (result) setImported(result);
          }}
          importError={importer.errorText}
          onClearImportError={importer.clearError}
        />
      </section>
    </div>
  );
}
