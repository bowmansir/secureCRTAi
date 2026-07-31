import type { AgentExecutionBlock } from "./surfaceModel";

export function getExecutionLabel(block: AgentExecutionBlock): string {
  if (block.status === "running") return `正在执行 ${block.commands.length} 条`;
  if (block.status === "cancelled") return "已停止";
  if (block.status === "rejected") return "已拒绝";
  if (block.status === "error") return "执行失败";
  return `已执行 ${block.commands.length} 条`;
}
