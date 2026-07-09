export interface SessionProfile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  passwordEnc?: string | null;
  keyPath?: string | null;
  keyPassphraseEnc?: string | null;
}

export interface SessionInput {
  id?: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** undefined = 不修改, "" = 清除 */
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
}

export type TermEvent =
  | { type: "data"; bytes: number[] }
  | { type: "connected" }
  | { type: "exit"; message: string | null };

export type AiEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ProviderKind = "anthropic" | "openai" | "deepseek" | "ollama";

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface AiConfigView {
  providers: ProviderView[];
  activeProvider: string | null;
}

export interface ProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** undefined = 不修改, "" = 清除 */
  apiKey?: string;
}

export interface TabInfo {
  tabId: string;
  title: string;
  kind: "local" | "ssh" | "sftp" | "sftp-cli";
  /** ssh / sftp / sftp-cli 时使用 */
  sessionId?: string;
  status: "connecting" | "connected" | "reconnecting" | "closed";
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export interface HostHealthResult {
  sessionId: string;
  host: string;
  port: number;
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

export type HostHealthStatus = "checking" | "online" | "offline";

export interface HostHealthView {
  sessionId: string;
  host: string;
  port: number;
  status: HostHealthStatus;
  latencyMs: number | null;
  message: string;
  checkedAt: number;
}

export interface HostHealthSummary {
  total: number;
  checked: number;
  online: number;
  offline: number;
  checking: boolean;
  checkedAt: number | null;
}

export interface CliResult {
  output: string;
  cwd: string;
  lcwd: string;
  transfer: {
    kind: "upload" | "download";
    local: string;
    remote: string;
    title: string;
  } | null;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
}

export interface SftpOpenResult {
  id: string;
  home: string;
}

export type TransferEvent =
  | { type: "started"; totalBytes: number; totalFiles: number }
  | { type: "file"; name: string }
  | { type: "skipped"; name: string }
  | { type: "progress"; transferred: number; rateBps: number }
  | { type: "done"; transferred: number; files: number }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export interface ForwardView {
  id: string;
  kind: "local" | "dynamic" | "remote";
  sessionId: string;
  sessionName: string;
  localBind: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  active: number;
}

export interface ForwardTestResult {
  id: string;
  ok: boolean;
  latencyMs: number;
  target: string;
  message: string;
}

export interface PubKeyEntry {
  path: string;
  content: string;
}

export interface GeneratedKey {
  privatePath: string;
  publicPath: string;
  publicKey: string;
  fingerprint: string;
}

export interface TransferItem {
  /** 前端本地 id（事件先于后端 id 到达也能定位条目） */
  id: string;
  /** 后端传输 id，用于取消 */
  backendId?: string;
  /** 展示名（文件名或目录名） */
  title: string;
  kind: "upload" | "download";
  status: "running" | "done" | "error" | "cancelled";
  /** 0 表示目录传输、总量未知（不预扫描） */
  totalBytes: number;
  transferred: number;
  /** 已完成文件数 */
  doneFiles: number;
  rateBps: number;
  currentFile: string;
  message?: string;
}
