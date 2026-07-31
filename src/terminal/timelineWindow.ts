import type { TerminalBlock } from "../agent/surfaceModel";

export const TIMELINE_BLOCK_PAGE_SIZE = 120;

export type TimelineWindow = {
  blocks: TerminalBlock[];
  hiddenCount: number;
};

export function windowTimelineBlocks(
  blocks: TerminalBlock[],
  visibleLimit = TIMELINE_BLOCK_PAGE_SIZE
): TimelineWindow {
  const safeLimit = Math.max(1, Math.floor(visibleLimit));
  const hiddenCount = Math.max(0, blocks.length - safeLimit);
  return {
    blocks: hiddenCount === 0 ? blocks : blocks.slice(hiddenCount),
    hiddenCount,
  };
}
