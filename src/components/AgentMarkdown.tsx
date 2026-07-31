import type { ReactNode } from "react";

type Props = {
  content: string;
  codeClassName?: string;
  onInsertCommand?: (command: string) => void;
  hideCodeBlocks?: boolean;
};

function splitBlocks(text: string): { code: boolean; content: string }[] {
  const parts: { code: boolean; content: string }[] = [];
  const pattern = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      parts.push({ code: false, content: text.slice(last, match.index) });
    }
    parts.push({ code: true, content: match[1].replace(/\n$/, "") });
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    parts.push({ code: false, content: text.slice(last) });
  }
  return parts;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`}>{match[2]}</strong>
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c${index}`} className="inline-code">
          {match[3]}
        </code>
      );
    }
    last = pattern.lastIndex;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells.length > 1 ? cells : null;
}

function parseAlignments(
  cells: string[]
): Array<"left" | "center" | "right"> | null {
  if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function renderProse(text: string, keyPrefix: string): ReactNode {
  const lines = text.split("\n");
  const output: ReactNode[] = [];
  let list: ReactNode[] = [];
  let pendingGap = false;
  let listGap = false;
  const flushList = () => {
    if (list.length === 0) return;
    output.push(
      <ul
        key={`${keyPrefix}-ul${output.length}`}
        className={`ai-list${listGap ? " para-gap" : ""}`}
      >
        {list}
      </ul>
    );
    list = [];
    listGap = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headers = parseTableRow(line);
    const divider =
      index + 1 < lines.length ? parseTableRow(lines[index + 1]) : null;
    const alignments = divider ? parseAlignments(divider) : null;
    if (headers && alignments && headers.length === alignments.length) {
      flushList();
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = parseTableRow(lines[index]);
        if (!row) break;
        rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ""));
        index += 1;
      }
      index -= 1;
      output.push(
        <div
          key={`${keyPrefix}-table${output.length}`}
          className={`ai-table-wrap${pendingGap ? " para-gap" : ""}`}
        >
          <table className="ai-table">
            <thead>
              <tr>
                {headers.map((header, cellIndex) => (
                  <th
                    key={`${keyPrefix}-th${cellIndex}`}
                    style={{ textAlign: alignments[cellIndex] }}
                  >
                    {renderInline(header, `${keyPrefix}-th${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${keyPrefix}-tr${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${keyPrefix}-td${rowIndex}-${cellIndex}`}
                      style={{ textAlign: alignments[cellIndex] }}
                    >
                      {renderInline(
                        cell,
                        `${keyPrefix}-td${rowIndex}-${cellIndex}`
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      pendingGap = false;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      if (list.length === 0 && pendingGap) listGap = true;
      list.push(
        <li key={`${keyPrefix}-li${index}`}>
          {renderInline(
            (bullet ?? numbered)![1],
            `${keyPrefix}-li${index}`
          )}
        </li>
      );
      pendingGap = false;
    } else if (line.trim() === "") {
      flushList();
      pendingGap = true;
    } else {
      flushList();
      output.push(
        <div
          key={`${keyPrefix}-p${index}`}
          className={`ai-line${pendingGap ? " para-gap" : ""}`}
        >
          {renderInline(line, `${keyPrefix}-p${index}`)}
        </div>
      );
      pendingGap = false;
    }
  }
  flushList();
  return output;
}

export default function AgentMarkdown({
  content,
  codeClassName,
  onInsertCommand,
  hideCodeBlocks = false,
}: Props) {
  return splitBlocks(content).map((block, index) =>
    block.code && hideCodeBlocks ? null : block.code ? (
      <div
        key={index}
        className={`code-block${codeClassName ? ` ${codeClassName}` : ""}`}
      >
        <pre>{block.content}</pre>
        {onInsertCommand && (
          <button
            className="btn mini"
            onClick={() => onInsertCommand(block.content)}
            title="插入到当前终端（需自行按回车执行）"
          >
            插入
          </button>
        )}
      </div>
    ) : (
      <div key={index} className="ai-prose">
        {renderProse(block.content, `markdown-${index}`)}
      </div>
    )
  );
}
