import type { ITheme } from "@xterm/xterm";

export type AppTheme = "dark" | "midnight" | "light";

const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
  midnight: {
    background: "#060a10",
    foreground: "#dbe7f7",
    cursor: "#7aa7ff",
    selectionBackground: "#20365a",
    black: "#303846",
    red: "#ff8b84",
    green: "#4bd06a",
    yellow: "#d8a84c",
    blue: "#7aa7ff",
    magenta: "#b996ff",
    cyan: "#55d5e0",
    white: "#c8d4e6",
    brightBlack: "#5c6878",
    brightRed: "#ffaea9",
    brightGreen: "#74e38c",
    brightYellow: "#efc36c",
    brightBlue: "#9fc0ff",
    brightMagenta: "#d5c2ff",
    brightCyan: "#8ee8ef",
    brightWhite: "#f4f8ff",
  },
  light: {
    background: "#fbfdff",
    foreground: "#172033",
    cursor: "#245dce",
    selectionBackground: "#c8dcff",
    black: "#172033",
    red: "#c3312a",
    green: "#1c7d3d",
    yellow: "#9a6700",
    blue: "#245dce",
    magenta: "#7a4acb",
    cyan: "#157f8f",
    white: "#d6deea",
    brightBlack: "#65758b",
    brightRed: "#e04a43",
    brightGreen: "#269b4d",
    brightYellow: "#b98210",
    brightBlue: "#3578f6",
    brightMagenta: "#9462e8",
    brightCyan: "#209aaa",
    brightWhite: "#ffffff",
  },
};

const BACKGROUND_OVERLAYS: Record<AppTheme, string> = {
  dark: "rgba(8, 12, 18, 0.78)",
  midnight: "rgba(3, 7, 12, 0.82)",
  light: "rgba(248, 251, 255, 0.84)",
};

export function getTerminalTheme(theme: AppTheme, backgroundActive: boolean): ITheme {
  const base = TERMINAL_THEMES[theme];
  return {
    ...base,
    background: backgroundActive ? BACKGROUND_OVERLAYS[theme] : base.background,
  };
}
