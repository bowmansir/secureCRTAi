export type IconName =
  | "activity"
  | "ai"
  | "arrowDown"
  | "arrowUp"
  | "broadcast"
  | "chevronDown"
  | "chevronRight"
  | "clone"
  | "close"
  | "command"
  | "connect"
  | "edit"
  | "file"
  | "folder"
  | "folderSync"
  | "local"
  | "plus"
  | "settings"
  | "split"
  | "tools"
  | "trash"
  | "transfer"
  | "window";

interface IconProps {
  name: IconName;
  size?: number;
}

const PATHS: Record<IconName, string> = {
  activity: "M3 12h4l2-6 4 12 2-6h6",
  ai: "M12 3l1.6 4.2L18 9l-4.4 1.8L12 15l-1.6-4.2L6 9l4.4-1.8L12 3zM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15zM19 14l1 2.6 2.6 1-2.6 1L19 21l-1-2.4-2.6-1 2.6-1L19 14z",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  broadcast: "M4 10v4l5 3V7l-5 3zM14 8a5 5 0 0 1 0 8M16.5 5.5a8.5 8.5 0 0 1 0 13",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  clone: "M8 8h10v10H8zM5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1",
  close: "M6 6l12 12M18 6L6 18",
  command: "M7 7a2 2 0 1 1 2-2v14a2 2 0 1 1-2-2h10a2 2 0 1 1-2 2V5a2 2 0 1 1 2 2H7z",
  connect: "M7 7h10v10H7zM12 2v5M12 17v5M2 12h5M17 12h5",
  edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 8.5l3 3",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3z",
  folderSync: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3M7 17H3v-6a2 2 0 0 1 2-2h15M16 14h5v5M21 14l-6 6M8 21H3v-5M3 21l6-6",
  local: "M4 5h16v10H4zM8 19h8M12 15v4",
  plus: "M12 5v14M5 12h14",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4",
  split: "M4 5h16v14H4zM12 5v14M4 12h16",
  tools: "M14.5 5.5a3.5 3.5 0 0 1 4.6 4.6l-9 9-4.6-4.6 9-9zM4 20l2-2M14 6l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3",
  transfer: "M7 7h13M17 4l3 3-3 3M17 17H4M7 14l-3 3 3 3",
  window: "M4 5h16v14H4zM4 9h16",
};

export default function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
