import assert from "node:assert/strict";
import test from "node:test";
import { getExecutionLabel } from "../src/agent/executionPresentation.ts";
import type { AgentExecutionBlock } from "../src/agent/surfaceModel.ts";

function block(
  status: AgentExecutionBlock["status"],
  commands = ["uptime"]
): AgentExecutionBlock {
  return {
    id: "execution-1",
    kind: "agent-execution",
    createdAt: 1,
    commands,
    output: "",
    exitCode: null,
    status,
    collapsed: true,
  };
}

test("execution labels distinguish rejected, stopped and failed actions", () => {
  assert.equal(getExecutionLabel(block("rejected")), "已拒绝");
  assert.equal(getExecutionLabel(block("cancelled")), "已停止");
  assert.equal(getExecutionLabel(block("error")), "执行失败");
});

test("execution labels retain counts for running and completed batches", () => {
  const commands = ["uptime", "df -h"];
  assert.equal(getExecutionLabel(block("running", commands)), "正在执行 2 条");
  assert.equal(getExecutionLabel(block("success", commands)), "已执行 2 条");
  assert.equal(getExecutionLabel(block("warning", commands)), "已执行 2 条");
});
