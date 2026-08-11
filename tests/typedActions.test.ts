import assert from "node:assert/strict";
import test from "node:test";

import {
  assessAgentAction,
  parseAgentActionPlan,
  parseLegacyAgentActions,
  stripTypedActionEnvelopeForDisplay,
} from "../src/agent/typedActions.ts";
import type {
  AgentTypedAction,
  ShellExecuteAction,
} from "../src/agent/typedActions.ts";

function shell(command: string): ShellExecuteAction {
  return {
    type: "shell.execute",
    actionId: "action-1",
    surfaceId: "surface-1",
    sessionId: "session-1",
    command,
    timeoutMs: 35_000,
  };
}

test("legacy markdown commands become bounded typed shell actions", () => {
  const actions = parseLegacyAgentActions(
    [
      "先检查系统。",
      "```bash",
      "uptime",
      "```",
      "```",
      "df -h",
      "```",
      "```bash",
      "free -h",
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/root",
      maxActions: 2,
    }
  );

  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], {
    type: "shell.execute",
    actionId: "legacy-shell-1",
    surfaceId: "surface-1",
    sessionId: "session-1",
    cwd: "/root",
    command: "uptime",
    timeoutMs: 35_000,
  });
  assert.equal(actions[1].command, "df -h");
});

test("agent command cards accept CRLF, tilde fences and shell prompts", () => {
  const actions = parseLegacyAgentActions(
    [
      "先并行采集只读证据。\r",
      "```shell\r",
      "$ uptime\r",
      "```\r",
      "~~~bash\r",
      "df -h\r",
      "~~~\r",
      "```json\r",
      '{"not":"a shell action"}\r',
      "```\r",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
    }
  );

  assert.deepEqual(
    actions.map((action) => action.command),
    ["uptime", "df -h"]
  );
});

test("typed action envelopes are validated and bound to the current surface", () => {
  const plan = parseAgentActionPlan(
    [
      "先读取已有证据，再等待服务稳定。",
      "```termexa-actions",
      JSON.stringify({
        actions: [
          {
            type: "terminal.readBlocks",
            surfaceId: "forged-surface",
            blockIds: ["block-2", "block-2", "block-1"],
          },
          {
            type: "terminal.wait",
            durationMs: 500,
            reason: "等待服务启动",
          },
          {
            type: "shell.execute",
            sessionId: "forged-session",
            command: "systemctl status nginx",
            timeoutMs: 999_999,
          },
        ],
      }),
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/opt/app",
      timeoutMs: 35_000,
    }
  );

  assert.equal(plan.source, "typed");
  assert.equal(plan.displayText, "先读取已有证据，再等待服务稳定。");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.actions, [
    {
      type: "terminal.readBlocks",
      actionId: "typed-action-1",
      surfaceId: "surface-1",
      blockIds: ["block-2", "block-1"],
    },
    {
      type: "terminal.wait",
      actionId: "typed-action-2",
      surfaceId: "surface-1",
      durationMs: 500,
      reason: "等待服务启动",
    },
    {
      type: "shell.execute",
      actionId: "typed-action-3",
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/opt/app",
      command: "systemctl status nginx",
      timeoutMs: 120_000,
    },
  ]);
});

test("legacy TermAI typed action fences remain compatible", () => {
  const plan = parseAgentActionPlan(
    [
      "读取旧协议动作。",
      "```termai-actions",
      '{"actions":[{"type":"shell.execute","command":"uptime"}]}',
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-legacy",
      sessionId: "session-legacy",
    }
  );

  assert.equal(plan.source, "typed");
  assert.equal(plan.actions.length, 1);
  assert.equal(
    plan.actions[0]?.type === "shell.execute"
      ? plan.actions[0].command
      : undefined,
    "uptime"
  );
});

test("typed action plans keep the first safe batch when the model exceeds the limit", () => {
  const plan = parseAgentActionPlan(
    [
      "执行一轮诊断。",
      "```termexa-actions",
      JSON.stringify({
        actions: Array.from({ length: 7 }, (_, index) => ({
          type: "shell.execute",
          command: `echo ${index + 1}`,
        })),
      }),
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-a",
      sessionId: "session-a",
      maxActions: 5,
    }
  );

  assert.equal(plan.actions.length, 5);
  assert.deepEqual(
    plan.actions.map((action) =>
      action.type === "shell.execute" ? action.command : action.type
    ),
    ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5"]
  );
  assert.deepEqual(plan.errors, []);
  assert.match(plan.warnings.join("\n"), /动作数量超过上限 5/);
  assert.equal(plan.displayText, "执行一轮诊断。");
});

test("malformed typed envelopes fail closed instead of executing markdown guesses", () => {
  const text = [
    "准备执行。",
    "```termexa-actions",
    '{"actions":[{"type":"shell.execute","command":42}]}',
    "```",
    "```sh",
    "rm -rf /tmp/should-not-run",
    "```",
  ].join("\n");
  const plan = parseAgentActionPlan(text, {
    surfaceId: "surface-1",
    sessionId: "session-1",
  });

  assert.equal(plan.source, "typed");
  assert.deepEqual(plan.actions, []);
  assert.match(plan.errors.join("\n"), /shell\.execute/);
  assert.doesNotMatch(plan.displayText, /termexa-actions/);
});

test("typed action metadata is hidden while the assistant response streams", () => {
  const visible = stripTypedActionEnvelopeForDisplay(
    [
      "正在检查服务状态。",
      "```termexa-actions",
      '{"actions":[{"type":"shell.execute","command":"systemctl status nginx"}',
    ].join("\n"),
    true
  );

  assert.equal(visible, "正在检查服务状态。");
});

test("read-only diagnostics remain safe for automatic execution", () => {
  const commands = [
    "uptime",
    "df -h",
    "free -h",
    "ss -tulpn",
    "journalctl -u nginx -n 100 --no-pager",
    "systemctl status nginx",
    "iostat -x 1 1 2>&1 || vmstat 1 2 2>&1 || cat /proc/diskstats | head -20",
    "command 2>/dev/null",
    "command 1>&2",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("filesystem, service, package, permission and port changes require approval", () => {
  const commands = [
    "rm /tmp/file.txt",
    "cp app.conf /etc/app.conf",
    "systemctl restart nginx",
    "apt install nginx",
    "chmod 600 /etc/app.conf",
    "ufw allow 8080/tcp",
    "docker run -p 8080:80 nginx",
    "echo value > /etc/app.conf",
    "echo error 2> errors.log",
    "echo error >&/tmp/errors.log",
  ];

  for (const command of commands) {
    const risk = assessAgentAction(shell(command));
    assert.equal(risk.level, "approval-required", command);
    assert.ok(risk.reason, command);
  }
});

test("approval requirement is separate from the command's actual risk level", () => {
  const unknown = assessAgentAction(shell("internal-tool target"));
  assert.equal(unknown.level, "approval-required");
  assert.equal(unknown.riskLevel, "unknown");

  const stateChange = assessAgentAction(shell("cp source.conf target.conf"));
  assert.equal(stateChange.level, "approval-required");
  assert.equal(stateChange.riskLevel, "moderate");

  const dangerous = assessAgentAction(shell("systemctl restart nginx"));
  assert.equal(dangerous.level, "approval-required");
  assert.equal(dangerous.riskLevel, "high");
});

test("unknown query-shaped commands are inferred as read-only", () => {
  const commands = [
    "virt-host-validate",
    "qemu-img info /var/lib/libvirt/images/demo.qcow2",
    "virsh list --all",
    "kubectl get pods --all-namespaces",
    "customctl status --json",
    "customctl list widgets",
    "customctl inspect widget-1",
    "customctl --version",
    "customctl --help",
    "health-check --summary",
    "aws ec2 describe-instances --region cn-hangzhou",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("unknown mutating or ambiguous commands are not inferred as read-only", () => {
  const commands = [
    "customctl target",
    "customctl create widget",
    "customctl delete widget-1",
    "customctl apply config.yaml",
    "customctl status --exec 'touch /tmp/owned'",
    "customctl inspect widget-1 --write report.json",
    "customctl list widgets --save report.json",
    "customctl status; customctl delete widget-1",
    "customctl list widgets && touch /tmp/owned",
    "customctl --help delete widget-1",
    "customctl status | tee /tmp/status.txt",
    "virt-host-validate --fix",
    "qemu-img create /tmp/demo.qcow2 10G",
    "kubectl get pods > /tmp/pods.txt",
    "aws s3api get-object bucket key /tmp/object.bin",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("shell wrappers and lesser-known write primitives cannot bypass safe-auto", () => {
  const commands = [
    "bash -c 'rm -rf /tmp/example'",
    "find /tmp -type f -delete",
    "find /tmp -type f -exec rm {} \\;",
    "sed -i 's/old/new/' /etc/app.conf",
    "python -c \"open('/tmp/example', 'w').write('x')\"",
    "sh -c 'systemctl restart nginx'",
    "docker exec app touch /tmp/example",
    "ip link set eth0 down",
    "sysctl -w net.ipv4.ip_forward=1",
    "echo $(rm -rf /tmp/example)",
    "sort -o /tmp/result input.txt",
    "dmesg -c",
    "journalctl --vacuum-time=1s",
    "ip netns exec ns rm /tmp/probe",
    "ss -K dst 192.0.2.1",
    "date --set='2030-01-01'",
    "hostname new-hostname",
    "mount /dev/sdb1 /mnt",
    "uptime & touch /tmp/termexa-owned",
    "uptime & sh -c 'touch /tmp/termexa-owned'",
    "uptime & nc -l 4444",
    "sort -o/tmp/termexa-owned /etc/hosts",
    "sar -o /tmp/termexa-sar 1 1",
    "sar -o/tmp/termexa-sar 1 1",
    "env --split-string='touch /tmp/termexa-owned'",
    "(rm -rf /tmp/termexa-owned)",
    "{ systemctl restart nginx; }",
  ];

  for (const command of commands) {
    const risk = assessAgentAction(shell(command));
    assert.equal(risk.level, "approval-required", command);
    assert.ok(risk.reason, command);
  }
});

test("compound read-only diagnostics remain eligible for safe-auto", () => {
  const commands = [
    "if command -v iostat >/dev/null 2>&1; then iostat -x 1 1; else vmstat 1 2; fi",
    "echo '=== IO ==='; if command -v iostat &>/dev/null; then iostat -x 1 1; else echo 'iostat not installed'; fi; echo '=== MEMORY ==='; free -h",
    "test -d /var/log && echo EXISTS || echo MISSING",
    "ps aux --sort=-%cpu | head -20",
    "ss -tuan | column -t",
    "uptime; echo '---MEM---'; free -m; echo '---TOP---'; top -b -n1 -o %CPU | head -30; echo '---DISK---'; df -h; echo '---IO---'; iostat -x 1 2 2>/dev/null || (echo 'iostat not found, using /proc/diskstats'; cat /proc/diskstats | head -20)",
    "timeout 8s tail -f /var/log/messages",
    "systemctl show nginx --property=ActiveState",
    "docker ps --format '{{.Names}}'",
    "ip addr show",
    "find /var/log -maxdepth 1 -type f",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("nginx certificate and proxy diagnostics remain safe without approval", () => {
  const commands = [
    [
      "ss -lntp | grep -E ':443|:8088'",
      "echo '---FRPS---'",
      "ps aux | grep -E '[f]rps|[f]rpc'",
      "echo '---FRP-CONF---'",
      "grep -rniE '443|cert|tls' /etc/frp/ /etc/systemd/system/frp*.service 2>/dev/null | head -40",
      "echo '---NGINX-T---'",
      "nginx -T 2>/dev/null | head -80",
    ].join("; "),
    [
      "getent ahostsv4 app.example.com | head -5",
      "echo '---PUBIP---'",
      "timeout 5 curl -s https://api.ipify.org 2>/dev/null || true",
      "echo",
      "echo '---NGINXMASTER---'",
      "ps -o pid,lstart,cmd -p $(pgrep -d, nginx | head -3) 2>/dev/null",
    ].join("; "),
    "echo | timeout 8 openssl s_client -connect app.example.com:443 -servername app.example.com 2>&1 | grep -E 'subject=|issuer=|notBefore=|notAfter=|Verify return code|Protocol|Cipher|CONNECTED|connect:'",
    [
      "echo '---OLDDATES---'",
      "openssl x509 -in /etc/nginx/cert/example.pem -noout -subject -dates 2>&1",
      "echo '---NEWDATES---'",
      "openssl x509 -in /etc/nginx/cert/example.new.pem -noout -subject -dates 2>&1",
      "echo '---NGINXPROC---'",
      "ls -l /proc/$(pgrep -o nginx)/exe",
    ].join("; "),
    "nginx -t 2>&1",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("nginx and openssl mutations remain behind explicit approval", () => {
  const commands = [
    "nginx -s reload",
    "openssl genpkey -algorithm RSA -out /tmp/server.key",
    "openssl req -new -key /tmp/server.key -out /tmp/server.csr",
    "openssl x509 -in /tmp/server.pem -out /tmp/copied.pem",
    "openssl x509 -in /tmp/server.pem -noout -subject -out /tmp/copied.pem",
    "timeout 8 openssl s_client -connect app.example.com:443 -keylogfile /tmp/tls.keys",
    "openssl s_client -connect app.example.com:443",
    "openssl x509 $(echo -out /tmp/copied.pem) -in /tmp/server.pem",
    "echo $(touch /tmp/termexa-owned)",
    "ps -p $(sh -c 'touch /tmp/termexa-owned')",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("temporary diagnostic writes can run without approval", () => {
  const commands = [
    "probe=$(mktemp /tmp/termexa-probe.XXXXXX) && rm -f -- \"$probe\"",
    "probe=$(mktemp /var/tmp/termexa-probe.XXXXXX) && printf 'probe' > \"$probe\" && cat \"$probe\" && rm -f -- \"$probe\"",
    "probe_dir=$(mktemp -d /tmp/termexa-probe-dir.XXXXXX) && rmdir -- \"$probe_dir\"",
    "probe=$(mktemp /etc/nginx/cert/.termexa_write_test.XXXXXX) && ls -la \"$probe\" && rm -f -- \"$probe\"",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("temporary write allowance cannot escape or alter persistent state", () => {
  const commands = [
    "rm -rf /tmp/termexa-probe",
    "touch /tmp/../etc/termexa-owned",
    "ln -s /etc/passwd /tmp/termexa-probe && printf owned > /tmp/termexa-probe",
    "cp /tmp/termexa-probe /etc/termexa-owned",
    "touch /etc/nginx/cert/.termexa_write_test",
    "probe=$(mktemp /tmp/termexa-probe.XXXXXX) && sh \"$probe\" && rm -f -- \"$probe\"",
    "probe=$(mktemp /tmp/termexa-probe.XXXXXX) && printf '#!/bin/sh' > \"$probe\" && bash \"$probe\" && rm -f -- \"$probe\"",
    "probe=$(mktemp /tmp/termexa-probe.XXXXXX) && printf \"$(touch /tmp/termexa-owned)\" > \"$probe\" && rm -f -- \"$probe\"",
    "probe=$(mktemp /tmp/termexa-probe.XXXXXX) && rm -f -- /tmp/unrelated",
    "openssl s_client -connect app.example.com:443 -keylogfile /tmp/termexa.keys",
    "curl -s https://example.com -o /tmp/termexa-download",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("common bounded operations diagnostics run without approval", () => {
  const commands = [
    "dig +short app.example.com",
    "nslookup app.example.com",
    "host app.example.com",
    "ping -c 3 -W 2 app.example.com",
    "timeout 5 nc -zv app.example.com 443",
    "sed -n '1,20p' /etc/nginx/nginx.conf",
    "jq -r '.status' /tmp/termexa-status.json",
    "sha256sum /etc/nginx/nginx.conf",
    "md5sum /etc/nginx/nginx.conf",
    "file /etc/nginx/nginx.conf",
    "printenv PATH",
    "crontab -l",
    "rpm -q nginx",
    "dpkg -l nginx",
    "lsmod",
    "systemctl list-dependencies nginx",
    "systemctl is-system-running",
    "nginx -t -c /etc/nginx/nginx.conf",
    "openssl x509 -in /etc/nginx/cert/example.pem -noout -ext subjectAltName",
    "curl -s -o /dev/null -w '%{http_code}' https://example.com",
    "wget --spider --timeout=5 https://example.com",
    "sshd -T",
    "apachectl -t",
    "certbot certificates",
    "docker compose ps",
    "docker compose logs --tail 100 api",
    "docker network inspect bridge",
    "docker volume inspect app-data",
    "docker stats --no-stream",
    "kubectl get pods --all-namespaces",
    "kubectl describe pod api-0",
    "kubectl logs --tail=100 deployment/api",
    "kubectl top pods",
    "kubectl cluster-info",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("bounded diagnostic handlers keep their mutating and persistent modes blocked", () => {
  const commands = [
    "ping app.example.com",
    "nc -l 443",
    "timeout 5 nc -zle /tmp/run-me app.example.com 443",
    "sed -i 's/old/new/' /etc/nginx/nginx.conf",
    "jq -f /tmp/filter.jq /etc/nginx/nginx.conf",
    "yq -i '.enabled = true' /etc/app.yml",
    "crontab /tmp/new-crontab",
    "rpm -U package.rpm",
    "rpm -q -U package.rpm",
    "dpkg -i package.deb",
    "dpkg -l -i package.deb",
    "nginx -s reload",
    "sshd -f /tmp/sshd.conf",
    "certbot renew",
    "wget --spider --execute=output_document=/tmp/result https://example.com",
    "customctl status --script /tmp/run-me",
    "customctl list --plugin /tmp/plugin.so",
    "docker stats",
    "docker compose logs --follow api",
    "docker compose up -d",
    "docker compose exec api sh",
    "docker network create public",
    "kubectl logs --follow deployment/api",
    "kubectl exec deployment/api -- sh",
    "kubectl apply -f deployment.yml",
    "kubectl delete pod api-0",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("read-only commands reject execution-changing environment injection", () => {
  const commands = [
    "PATH=/tmp:$PATH ls -la",
    "LD_PRELOAD=/tmp/inject.so ls -la",
    "SYSTEMD_PAGER=/tmp/run-me systemctl status nginx",
    "env BASH_ENV=/tmp/run-me bash -c 'uptime'",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }

  for (const command of [
    "LC_ALL=C ls -la",
    "TZ=UTC date",
    "SYSTEMD_PAGER=cat systemctl status nginx",
  ]) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("read-only command discovery loops run without approval", () => {
  const commands = [
    'for c in virt-customize guestfish virt-resize virt-filesystems; do command -v $c >/dev/null 2>&1 && echo "FOUND:$c" || echo "MISSING:$c"; done',
    [
      "for candidate in qemu-img virsh virt-host-validate; do",
      "  if command -v $candidate >/dev/null 2>&1; then",
      '    printf "FOUND:%s\\n" "$candidate";',
      "  else",
      '    printf "MISSING:%s\\n" "$candidate";',
      "  fi;",
      "done",
    ].join("\n"),
    'for path in /dev/kvm /proc/cpuinfo; do test -e "$path" && printf "EXISTS:%s\\n" "$path" || printf "MISSING:%s\\n" "$path"; done',
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("for loops with writes or dynamic execution still require approval", () => {
  const commands = [
    "for c in alpha beta; do touch /tmp/$c; done",
    "for c in uptime whoami; do $c; done",
    "for c in alpha beta; do echo $c > /tmp/result; done",
    "for c in $(cat /tmp/commands); do command -v $c; done",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("temporary PATH setup and firewall status queries remain safe", () => {
  const command =
    "export PATH=$PATH:/usr/sbin:/sbin; echo '--- iptables ---'; iptables -L -n 2>/dev/null | head -80; echo '--- nft ---'; nft list ruleset 2>/dev/null | head -80; echo '--- ufw ---'; ufw status 2>/dev/null; echo '--- firewalld ---'; firewall-cmd --list-all 2>/dev/null";

  assert.equal(assessAgentAction(shell(command)).level, "safe");
});

test("PM2 status queries and bounded log snapshots remain safe", () => {
  const commands = [
    "if command -v pm2 >/dev/null 2>&1; then pm2 list 2>&1; else echo 'pm2: command not found'; fi",
    "pm2 status",
    "pm2 show api",
    "pm2 describe api",
    "pm2 logs 0 --lines 100 --nostream",
    "timeout 5s pm2 logs 0",
    "timeout 5s pm2 logs 0 || [ $? -eq 124 ]",
    "timeout 5s sleep 10 || [ $? -eq 124 ]",
    "timeout 5s sh -c 'if command -v pm2; then pm2 logs 0; fi' || [ $? -eq 124 ]",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("HTTP probes and Redis scans remain safe", () => {
  const commands = [
    "timeout 8s curl -sI -m 6 http://es-cn-4591gc2fx0001549q.elasticsearch.aliyuncs.com:9200 2>&1 | head -10",
    "curl --silent --show-error --head --max-time 5 https://example.com",
    "curl -s -m 8 'http://127.0.0.1:8200/plume_log_run_2021110515/_search?size=5&pretty' -H 'Content-Type: application/json' -d '{\"query\":{\"term\":{\"appName\":\"work\"}},\"sort\":[{\"dtTime\":{\"order\":\"desc\"}}],\"_source\":[]}'",
    "curl --silent --request POST https://search.example.com/logs-*/_count --header 'Content-Type: application/json' --data-raw '{\"query\":{\"match_all\":{}}}'",
    "curl -X GET -H 'Content-Type: application/json' -d '{\"query\":{\"match_all\":{}}}' https://search.example.com/logs/_search",
    "which redis-cli && redis-cli -h 172.19.12.36 -p 6379 --scan --pattern 'plumelog*' 2>/dev/null | head -40 || echo 'redis-cli not available or no auth'",
    "redis-cli -h 127.0.0.1 -p 6379 INFO memory",
    "redis-cli --tls -h redis.example.com GET health",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("HTTP mutations and Redis writes still require approval", () => {
  const commands = [
    "curl -X POST https://example.com/jobs",
    "curl --data 'enabled=true' https://example.com/config",
    "curl -H 'Content-Type: application/json' -d '{\"doc\":{\"enabled\":true}}' http://127.0.0.1:9200/app/_update/1",
    "curl -H 'Content-Type: application/x-ndjson' --data-binary '{}\n{}' http://127.0.0.1:9200/_bulk",
    "curl -H 'X-HTTP-Method-Override: DELETE' -d '{\"query\":{\"match_all\":{}}}' http://127.0.0.1:9200/logs/_search",
    "curl -H 'Content-Type: application/json' --data-binary @query.json http://127.0.0.1:9200/logs/_search",
    "curl -H 'Content-Type: application/json' -d 'query=all' http://127.0.0.1:9200/logs/_search",
    "curl -T artifact.tar https://example.com/upload",
    "curl -o /tmp/result https://example.com",
    "redis-cli SET feature enabled",
    "redis-cli DEL production:key",
    "redis-cli FLUSHALL",
    "redis-cli CONFIG SET maxmemory 1gb",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("query fragments without an executable are invalid, not dangerous", () => {
  const commands = [
    [
      "appName=private-adm-pro&env=default&className=&logLevel=ERROR&time=1785460141211",
      "appName=IAA-VNovel-App&env=Prod&logLevel=ERROR&time=1785449120711",
    ].join("\n"),
    "appName=<业务线>&env=<环境>&className=<类名>&logLevel=<级别>&time=<毫秒时间戳>",
  ];

  for (const command of commands) {
    const risk = assessAgentAction(shell(command));
    assert.equal(risk.level, "invalid");
    assert.match(risk.reason ?? "", /缺少可执行命令/);
  }
  assert.equal(assessAgentAction(shell("FOO=bar env")).level, "safe");
});

test("timestamped log output is rejected instead of executed as a shell command", () => {
  const transcripts = [
    [
      '17:19:05.551  手机200048从task表原子取到任务： {"type":5,"slave":1,"subject":""}',
      "17:19:05.683  编号200048接收到确认的消息",
      "17:19:28.675  接收的消息 {slave=1, subject=, err_msg=企微开启失败}",
    ].join("\n"),
    "2026-07-31T17:19:05.551+08:00 ERROR request failed",
    "[2026-07-31 17:19:05.551] ERROR request failed\n    at worker.js:42:11",
    "Jul 31 17:19:05 host sshd[123]: connection closed",
    [
      "\x1b[90m17:41:52.603\x1b[0m  手机200048从task表原子取到任务：",
      '{"type":5,"slave":1,"subject":""}',
      "17:41:52.724  编号200048接收到确认的消息",
      "← 客户端已确认收到",
      "17:43:24.785  手机200048无任务，已触发异步请求新任务",
    ].join("\n"),
  ];

  for (const transcript of transcripts) {
    const risk = assessAgentAction(shell(transcript));
    assert.equal(risk.level, "invalid", transcript);
    assert.match(
      risk.reason ?? "",
      /日志|终端输出|缺少可执行命令/,
      transcript
    );
  }

  const transcript = transcripts[0]!;

  const plan = parseAgentActionPlan(
    [
      "```termexa-actions",
      JSON.stringify({
        actions: [{ type: "shell.execute", command: transcript }],
      }),
      "```",
    ].join("\n"),
    { surfaceId: "surface-1", sessionId: "session-1" }
  );
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.errors, []);

  assert.equal(
    assessAgentAction(
      shell("grep -n '17:19:05.551' /var/log/app.log | head -20")
    ).level,
    "safe"
  );
});

test("read-only awk log filtering is safe without allowing awk execution escapes", () => {
  const query =
    "echo '=== 200048 17:41:50 之后所有日志 ==='; awk '$0 >= \"2026-07-31 17:41:50\"' /opt/weworkmedia/logs/wework-media.log | grep -E '200048|type=5' | tail -80";

  assert.equal(assessAgentAction(shell(query)).level, "safe");

  const unsafeCommands = [
    "awk 'BEGIN { system(\"rm -rf /tmp/example\") }' /var/log/app.log",
    "awk -f /tmp/untrusted.awk /var/log/app.log",
    "awk '{ print $0 > \"/tmp/copied.log\" }' /var/log/app.log",
    "awk '{ \"touch /tmp/example\" | getline result }' /var/log/app.log",
  ];
  for (const command of unsafeCommands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("read-only ss state aggregation with awk remains safe", () => {
  const command =
    "ss -s && echo '---TCP-STATE---' && ss -ant | awk 'NR>1{print $1}' | sort | uniq -c";

  assert.deepEqual(assessAgentAction(shell(command)), { level: "safe" });
});

test("PM2 mutations and unbounded log streams are not auto-executed", () => {
  const commands = [
    "pm2 restart all",
    "pm2 delete api",
    "pm2 flush",
    "pm2 logs 0",
    "pm2 log 0 --lines 100",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("timeout shell wrappers do not hide mutations", () => {
  const commands = [
    "timeout 5s sh -c 'rm -rf /tmp/example'",
    "timeout 5s bash -c 'systemctl restart nginx'",
    "timeout 5s sh -c 'echo changed > /etc/example'",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("firewall mutations and unsafe PATH overrides still require approval", () => {
  const commands = [
    "export PATH=/tmp:$PATH; iptables -L -n",
    "iptables -F",
    "iptables -A INPUT -p tcp --dport 8080 -j ACCEPT",
    "iptables -L -AINPUT -p tcp --dport 8080 -j ACCEPT",
    "nft flush ruleset",
    "nft add rule inet filter input tcp dport 8080 accept",
    "ufw allow 8080/tcp",
    "ufw disable",
    "firewall-cmd --add-port=8080/tcp",
    "firewall-cmd --reload",
    "firewall-cmd --list-all --new-zone=owned",
  ];

  for (const command of commands) {
    assert.equal(
      assessAgentAction(shell(command)).level,
      "approval-required",
      command
    );
  }
});

test("empty and malformed shell actions are rejected", () => {
  assert.equal(assessAgentAction(shell("   ")).level, "invalid");
  assert.equal(assessAgentAction(shell("echo ok\0rm file")).level, "invalid");
});

test("non-shell typed actions are safe control and context operations", () => {
  const actions: AgentTypedAction[] = [
    {
      type: "terminal.readBlocks",
      actionId: "read-1",
      surfaceId: "surface-1",
      blockIds: ["block-1"],
    },
    {
      type: "terminal.wait",
      actionId: "wait-1",
      surfaceId: "surface-1",
      durationMs: 1000,
      reason: "等待服务启动",
    },
    {
      type: "terminal.interrupt",
      actionId: "interrupt-1",
      surfaceId: "surface-1",
      runtimeId: "runtime-1",
    },
  ];

  for (const action of actions) {
    assert.equal(assessAgentAction(action).level, "safe");
  }
});
