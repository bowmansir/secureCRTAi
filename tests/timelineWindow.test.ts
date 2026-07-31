import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBlock } from "../src/agent/surfaceModel.ts";
import {
  TIMELINE_BLOCK_PAGE_SIZE,
  windowTimelineBlocks,
} from "../src/terminal/timelineWindow.ts";

function makeBlocks(count: number): TerminalBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shell-${index}`,
    kind: "shell" as const,
    command: `echo ${index}`,
    output: `${index}`,
    exitCode: 0,
    status: "success" as const,
    collapsed: false,
    createdAt: index,
  }));
}

test("renders only the newest page from a 500 block timeline", () => {
  const result = windowTimelineBlocks(makeBlocks(500));

  assert.equal(result.blocks.length, TIMELINE_BLOCK_PAGE_SIZE);
  assert.equal(result.hiddenCount, 380);
  assert.equal(result.blocks[0]?.id, "shell-380");
  assert.equal(result.blocks.at(-1)?.id, "shell-499");
});

test("expands timeline history in bounded pages", () => {
  const result = windowTimelineBlocks(
    makeBlocks(500),
    TIMELINE_BLOCK_PAGE_SIZE * 2
  );

  assert.equal(result.blocks.length, 240);
  assert.equal(result.hiddenCount, 260);
  assert.equal(result.blocks[0]?.id, "shell-260");
});

test("returns the original array when all blocks fit", () => {
  const blocks = makeBlocks(10);
  const result = windowTimelineBlocks(blocks);

  assert.equal(result.blocks, blocks);
  assert.equal(result.hiddenCount, 0);
});
