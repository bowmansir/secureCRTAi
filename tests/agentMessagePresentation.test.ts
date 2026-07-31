import assert from "node:assert/strict";
import test from "node:test";
import { shouldCollapseAgentMessage } from "../src/agent/messagePresentation.ts";

test("keeps concise agent summaries expanded", () => {
  assert.equal(
    shouldCollapseAgentMessage("任务完成。CPU、内存和磁盘状态均正常。"),
    false
  );
});

test("collapses long prose and large markdown tables", () => {
  assert.equal(shouldCollapseAgentMessage("诊断结果".repeat(300)), true);

  const table = [
    "| 状态 | 本地地址 | 端口 |",
    "| --- | --- | --- |",
    ...Array.from(
      { length: 8 },
      (_, index) => `| LISTEN | 127.0.0.1 | ${8000 + index} |`
    ),
  ].join("\n");
  assert.equal(shouldCollapseAgentMessage(table), true);
});
