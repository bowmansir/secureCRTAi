// 危险命令识别：AI 生成的命令插入终端前做本地静态检查，命中则要求用户二次确认。
// 只做保守、低误报的匹配——宁可漏一些，也别把普通命令误报成危险。

interface DangerRule {
  test: RegExp;
  reason: string;
}

const RULES: DangerRule[] = [
  { test: /\brm\b[^|;&]*\s-[a-zA-Z]*r[a-zA-Z]*f|\brm\b[^|;&]*\s-[a-zA-Z]*f[a-zA-Z]*r/, reason: "rm 递归强制删除，可能清空目录" },
  { test: /\brm\b[^|;&]*\s-[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|\*|$)/, reason: "rm 递归删除根路径" },
  { test: /\bmkfs(\.\w+)?\b/, reason: "格式化文件系统" },
  { test: /\bdd\b[^|]*\bof=\/dev\//, reason: "dd 直接写入磁盘设备" },
  { test: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "关机/重启主机" },
  { test: /\bchmod\s+-R\s+0?777\b/, reason: "递归 777 权限，安全风险" },
  { test: />\s*\/dev\/(sd[a-z]|nvme\d|vd[a-z])/, reason: "重定向覆盖磁盘设备" },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork 炸弹" },
  { test: /\b(userdel|groupdel)\b/, reason: "删除用户/用户组" },
  { test: /\bdrop\s+(database|table)\b/i, reason: "删除数据库/表" },
  { test: /\btruncate\s+-s\s*0\b/, reason: "清空文件内容" },
  { test: /\b(iptables|nft)\b.*\b(-F|flush)\b/, reason: "清空防火墙规则，可能断开连接" },
  { test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)\b/, reason: "Git 破坏性操作，可能丢失改动" },
  { test: /\b>\s*\/etc\/(passwd|shadow|fstab)\b/, reason: "覆盖关键系统文件" },
];

export interface DangerVerdict {
  danger: boolean;
  reason?: string;
}

export function checkDangerous(cmd: string): DangerVerdict {
  const line = cmd.trim();
  if (!line) return { danger: false };
  for (const rule of RULES) {
    if (rule.test.test(line)) {
      return { danger: true, reason: rule.reason };
    }
  }
  return { danger: false };
}
