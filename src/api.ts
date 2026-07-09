import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AiConfigView,
  AiEvent,
  ChatMessage,
  CliResult,
  FileEntry,
  ForwardTestResult,
  ForwardView,
  GeneratedKey,
  HostHealthResult,
  ProviderInput,
  PubKeyEntry,
  SessionInput,
  SessionProfile,
  SftpOpenResult,
  Snippet,
  TermEvent,
  TransferEvent,
} from "./types";

// ---------- 终端 ----------

export function openLocalTerminal(
  cols: number,
  rows: number,
  onEvent: (e: TermEvent) => void
): Promise<string> {
  const ch = new Channel<TermEvent>();
  ch.onmessage = onEvent;
  return invoke<string>("term_open_local", { shell: null, cols, rows, onEvent: ch });
}

export function openSshBySession(
  sessionId: string,
  cols: number,
  rows: number,
  onEvent: (e: TermEvent) => void
): Promise<string> {
  const ch = new Channel<TermEvent>();
  ch.onmessage = onEvent;
  return invoke<string>("term_open_session", { sessionId, cols, rows, onEvent: ch });
}

/** 采集会话服务器环境信息（发行版/内核），供 AI 上下文；失败返回空串 */
export function sshProbeEnv(sessionId: string): Promise<string> {
  return invoke<string>("ssh_probe_env", { sessionId });
}

// ---------- Agent A+ ----------

export function agentOpen(sessionId: string): Promise<string> {
  return invoke<string>("agent_open", { sessionId });
}

export function agentRun(
  id: string,
  command: string
): Promise<{ output: string; exitCode: number | null }> {
  return invoke("agent_run", { id, command });
}

export function agentClose(id: string): Promise<void> {
  return invoke("agent_close", { id });
}

const encoder = new TextEncoder();

export function termWrite(id: string, data: string): Promise<void> {
  return invoke("term_write", { id, data: Array.from(encoder.encode(data)) });
}

export function termResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("term_resize", { id, cols, rows });
}

export function termClose(id: string): Promise<void> {
  return invoke("term_close", { id });
}

// ---------- SFTP ----------

export function sftpOpen(sessionId: string): Promise<SftpOpenResult> {
  return invoke("sftp_open", { sessionId });
}

export function sftpList(id: string, path: string): Promise<FileEntry[]> {
  return invoke("sftp_list", { id, path });
}

export function sftpDownload(id: string, remote: string, local: string): Promise<void> {
  return invoke("sftp_download", { id, remote, local });
}

export function sftpUpload(id: string, local: string, remote: string): Promise<void> {
  return invoke("sftp_upload", { id, local, remote });
}

export function sftpMkdir(id: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { id, path });
}

export function sftpDelete(id: string, path: string, isDir: boolean): Promise<void> {
  return invoke("sftp_delete", { id, path, isDir });
}

export function sftpRename(id: string, from: string, to: string): Promise<void> {
  return invoke("sftp_rename", { id, from, to });
}

export function sftpClose(id: string): Promise<void> {
  return invoke("sftp_close", { id });
}

// ---------- 传输引擎 ----------

export function transferStart(
  sftpId: string,
  kind: "upload" | "download",
  local: string,
  remote: string,
  onEvent: (e: TransferEvent) => void
): Promise<string> {
  const ch = new Channel<TransferEvent>();
  ch.onmessage = onEvent;
  return invoke<string>("transfer_start", { sftpId, kind, local, remote, onEvent: ch });
}

export function transferCancel(id: string): Promise<void> {
  return invoke("transfer_cancel", { id });
}

/** 服务器间传输 A→B（本地不落盘的流式转发） */
export function transferRemote(
  srcSftpId: string,
  srcPath: string,
  dstSessionId: string,
  dstPath: string,
  onEvent: (e: TransferEvent) => void
): Promise<string> {
  const ch = new Channel<TransferEvent>();
  ch.onmessage = onEvent;
  return invoke<string>("transfer_remote", {
    srcSftpId,
    srcPath,
    dstSessionId,
    dstPath,
    onEvent: ch,
  });
}

export function listSshKeys(): Promise<string[]> {
  return invoke("list_ssh_keys");
}

// ---------- 端口转发（本地 -L） ----------

export function forwardStart(input: {
  sessionId: string;
  localBind?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}): Promise<ForwardView> {
  return invoke("forward_start", {
    sessionId: input.sessionId,
    localBind: input.localBind ?? null,
    localPort: input.localPort,
    remoteHost: input.remoteHost,
    remotePort: input.remotePort,
  });
}

export function forwardStartDynamic(input: {
  sessionId: string;
  localBind?: string;
  localPort: number;
}): Promise<ForwardView> {
  return invoke("forward_start_dynamic", {
    sessionId: input.sessionId,
    localBind: input.localBind ?? null,
    localPort: input.localPort,
  });
}

export function forwardStartRemote(input: {
  sessionId: string;
  remoteBind?: string;
  remotePort: number;
  targetHost: string;
  targetPort: number;
}): Promise<ForwardView> {
  return invoke("forward_start_remote", {
    sessionId: input.sessionId,
    remoteBind: input.remoteBind ?? null,
    remotePort: input.remotePort,
    targetHost: input.targetHost,
    targetPort: input.targetPort,
  });
}

export function forwardList(): Promise<ForwardView[]> {
  return invoke("forward_list");
}

export function forwardTest(input: {
  id: string;
  targetHost?: string;
  targetPort?: number;
}): Promise<ForwardTestResult> {
  return invoke("forward_test", {
    id: input.id,
    targetHost: input.targetHost ?? null,
    targetPort: input.targetPort ?? null,
  });
}

export function forwardStop(id: string): Promise<void> {
  return invoke("forward_stop", { id });
}

// ---------- SSH 密钥生成 / 部署 ----------

export function listSshPubkeys(): Promise<PubKeyEntry[]> {
  return invoke("list_ssh_pubkeys");
}

export function sshGenerateKey(name: string, comment: string): Promise<GeneratedKey> {
  return invoke("ssh_generate_key", { name, comment });
}

export function sshImportOpenSshKey(
  name: string,
  pem: string,
  passphrase: string
): Promise<GeneratedKey> {
  return invoke("ssh_import_openssh_key", {
    name,
    pem,
    passphrase: passphrase || null,
  });
}

export function sshDeployKey(sessionId: string, publicKey: string): Promise<string> {
  return invoke("ssh_deploy_key", { sessionId, publicKey });
}

// ---------- 本地文件系统 ----------

export function localHome(): Promise<string> {
  return invoke("local_home");
}

export function localDrives(): Promise<string[]> {
  return invoke("local_drives");
}

export function localList(path: string): Promise<FileEntry[]> {
  return invoke("local_list", { path });
}

export function localMkdir(path: string): Promise<void> {
  return invoke("local_mkdir", { path });
}

export function localDelete(path: string): Promise<void> {
  return invoke("local_delete", { path });
}

export function localReveal(path: string): Promise<void> {
  return invoke("local_reveal", { path });
}

// ---------- 配置导入导出 ----------

export function configExport(path: string, passphrase: string): Promise<void> {
  return invoke("config_export", { path, passphrase });
}

export function configImport(
  path: string,
  passphrase: string
): Promise<{ sessions: number; providers: number }> {
  return invoke("config_import", { path, passphrase });
}

// ---------- 窗口 ----------

export function openNewWindow(): Promise<void> {
  return invoke("open_new_window");
}

// ---------- 会话 ----------

export function sessionsList(): Promise<SessionProfile[]> {
  return invoke("sessions_list");
}

export function healthCheckSessions(
  sessionIds: string[],
  timeoutMs = 2500
): Promise<HostHealthResult[]> {
  return invoke("health_check_sessions", { sessionIds, timeoutMs });
}

export function sessionSave(input: SessionInput): Promise<SessionProfile> {
  return invoke("session_save", { input });
}

export function sessionDelete(id: string): Promise<void> {
  return invoke("session_delete", { id });
}

// ---------- 命令片段 ----------

export function snippetsList(): Promise<Snippet[]> {
  return invoke("snippets_list");
}

export function snippetSave(snippet: { id?: string; name: string; command: string }): Promise<Snippet> {
  return invoke("snippet_save", { snippet: { id: snippet.id ?? "", name: snippet.name, command: snippet.command } });
}

export function snippetDelete(id: string): Promise<void> {
  return invoke("snippet_delete", { id });
}

// ---------- 分组 ----------

export function groupsList(): Promise<string[]> {
  return invoke("groups_list");
}

export function groupAdd(name: string): Promise<void> {
  return invoke("group_add", { name });
}

export function groupRename(from: string, to: string): Promise<void> {
  return invoke("group_rename", { from, to });
}

export function groupDelete(name: string): Promise<void> {
  return invoke("group_delete", { name });
}

export function sessionSetGroup(id: string, group: string): Promise<void> {
  return invoke("session_set_group", { id, group });
}

// ---------- SFTP 命令行 ----------

export function sftpCliExec(
  id: string,
  line: string,
  cwd: string,
  lcwd: string
): Promise<CliResult> {
  return invoke("sftp_cli_exec", { id, line, cwd, lcwd });
}

// ---------- AI ----------

export function aiGetConfig(): Promise<AiConfigView> {
  return invoke("ai_get_config");
}

export function aiSaveProvider(input: ProviderInput): Promise<void> {
  return invoke("ai_save_provider", { input });
}

export function aiDeleteProvider(id: string): Promise<void> {
  return invoke("ai_delete_provider", { id });
}

export function aiSetActive(id: string): Promise<void> {
  return invoke("ai_set_active", { id });
}

export function aiChat(
  system: string | null,
  messages: ChatMessage[],
  onEvent: (e: AiEvent) => void
): Promise<void> {
  const ch = new Channel<AiEvent>();
  ch.onmessage = onEvent;
  return invoke("ai_chat", { system, messages, onEvent: ch });
}
