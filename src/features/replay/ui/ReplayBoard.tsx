import type { Mark, Puzzle } from "../../../shared/types";

/** 纯展示棋盘：只接收投影结果，不绑定任何写操作，预览不会触碰原存档。 */
export function ReplayBoard({
  puzzle,
  marks,
  highlight,
}: {
  puzzle: Pick<Puzzle, "size">;
  marks: Mark[];
  highlight?: number | null;
}) {
  return (
    <div
      className="replay-grid"
      style={{
        gridTemplateColumns: `repeat(${puzzle.size}, var(--cell))`,
      }}
      role="img"
      aria-label="回放棋盘"
    >
      {marks.map((mark, i) => {
        const row = Math.floor(i / puzzle.size);
        const col = i % puzzle.size;
        return (
          <span
            key={i}
            className={`replay-cell ${mark} ${highlight === i ? "flash" : ""} ${(col + 1) % 5 === 0 ? "major-right" : ""} ${(row + 1) % 5 === 0 ? "major-bottom" : ""}`}
          >
            {mark === "cross" ? "×" : ""}
          </span>
        );
      })}
    </div>
  );
}
