const LONG_MESSAGE_CHARS = 1000;
const LONG_MESSAGE_LINES = 16;
const LONG_TABLE_ROWS = 10;

export function shouldCollapseAgentMessage(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  const tableRows = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  return (
    text.length > LONG_MESSAGE_CHARS ||
    lines.length > LONG_MESSAGE_LINES ||
    tableRows >= LONG_TABLE_ROWS
  );
}
