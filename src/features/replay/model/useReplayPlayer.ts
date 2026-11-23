import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Puzzle, ReplayEvent, ReplaySnapshot } from "../../../shared/types";
import { playbackOffsets, projectToSeq, type ReplayState } from "./projection";

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type PlaySpeed = (typeof SPEEDS)[number];

/**
 * 回放播放器：播放位置永远由“事件投影”决定，不维护任何可写棋盘。
 * 拖动进度条、点击事件跳转、倍速切换都走同一个 projectToSeq，
 * 因此跳转后的棋盘与顺序播放到该位置严格一致。
 */
export function useReplayPlayer(
  puzzle: Pick<Puzzle, "size">,
  timeline: ReplayEvent[],
  snapshots: ReplaySnapshot[],
) {
  const lastSeq = timeline.at(-1)?.seq ?? 0;
  const [targetSeq, setTargetSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaySpeed>(1);
  const [elapsed, setElapsed] = useState(0);
  const offsets = useMemo(() => playbackOffsets(timeline), [timeline]);
  const raf = useRef<number | null>(null);
  const lastWall = useRef(0);

  // 数据源身份：真实解题时 timeline 引用会随每次落笔变化，但身份不变，
  // 不能因此把正在查看的位置反复拉回起点；只有换题/导入才重置。
  const sourceKey = `${timeline.length}:${lastSeq}:${puzzle.size}`;
  const firstKey = useRef(sourceKey);
  useEffect(() => {
    if (firstKey.current === sourceKey) return;
    firstKey.current = sourceKey;
    setPlaying(false);
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    lastWall.current = 0;
    setTargetSeq(0);
    setElapsed(0);
  }, [sourceKey]);

  const state: ReplayState = useMemo(
    () => projectToSeq(puzzle, timeline, snapshots, targetSeq),
    [puzzle, timeline, snapshots, targetSeq],
  );

  const stop = useCallback(() => {
    setPlaying(false);
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    lastWall.current = 0;
  }, []);

  /** 跳转到指定事件下标，播放偏移与该事件对齐。 */
  const seekToEventIndex = useCallback(
    (index: number) => {
      if (!timeline.length) return;
      const clamped = Math.max(0, Math.min(index, timeline.length - 1));
      stop();
      setTargetSeq(timeline[clamped].seq);
      setElapsed(offsets[clamped] ?? 0);
    },
    [timeline, offsets, stop],
  );

  const seekToSeq = useCallback(
    (seq: number) => {
      const idx = timeline.findIndex((e) => e.seq >= seq);
      seekToEventIndex(idx < 0 ? timeline.length - 1 : idx);
    },
    [timeline, seekToEventIndex],
  );

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && targetSeq >= lastSeq) {
        setTargetSeq(timeline[0]?.seq ?? 0);
        setElapsed(0);
      }
      return !p;
    });
  }, [targetSeq, lastSeq, timeline]);

  useEffect(() => {
    if (!playing || timeline.length === 0) return;
    const tick = (now: number) => {
      if (!lastWall.current) lastWall.current = now;
      const deltaMs = (now - lastWall.current) * speed;
      lastWall.current = now;
      let finished = false;
      setElapsed((prev) => {
        const next = prev + deltaMs;
        let idx = 0;
        while (idx < offsets.length && offsets[idx] <= next) idx++;
        if (idx >= timeline.length) {
          setTargetSeq(timeline[timeline.length - 1].seq);
          finished = true;
          return offsets[offsets.length - 1] ?? 0;
        }
        setTargetSeq(timeline[idx - 1 >= 0 ? idx - 1 : 0].seq);
        return next;
      });
      if (finished) {
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        raf.current = null;
        lastWall.current = 0;
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      lastWall.current = 0;
    };
  }, [playing, speed, timeline, offsets]);

  const currentIndex = useMemo(() => {
    if (!timeline.length) return -1;
    let idx = 0;
    while (idx < timeline.length && timeline[idx].seq <= targetSeq) idx++;
    return idx - 1;
  }, [timeline, targetSeq]);

  return {
    state,
    targetSeq,
    lastSeq,
    playing,
    speed,
    elapsed,
    currentIndex,
    duration: offsets.at(-1) ?? 0,
    setSpeed,
    seekToSeq,
    seekToEventIndex,
    toggle,
    stop,
  };
}
