import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import { useDialogs } from "./Dialogs";
import Icon from "./Icons";
import type { AiConfigView, ProviderKind, ProviderView } from "../types";

interface Props {
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  onClose: () => void;
  onChanged: () => void;
  /** 导入配置后刷新会话列表等 */
  onImported: () => void;
}

type AppTheme = "dark" | "midnight" | "light";

const KIND_PRESETS: Record<ProviderKind, { label: string; baseUrl: string; model: string; needKey: boolean }> = {
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", needKey: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", needKey: true },
  openai: { label: "OpenAI 兼容", baseUrl: "https://api.openai.com", model: "gpt-4o", needKey: true },
  ollama: { label: "Ollama 本地", baseUrl: "http://localhost:11434", model: "qwen3:14b", needKey: false },
};

const THEME_OPTIONS: Array<{ value: AppTheme; label: string; note: string }> = [
  { value: "dark", label: "深色", note: "默认层次，适合多数场景" },
  { value: "midnight", label: "极夜", note: "低亮度，适合长时间运维" },
  { value: "light", label: "浅色", note: "白天环境更清楚" },
];

export default function SettingsDialog({ theme, onThemeChange, onClose, onChanged, onImported }: Props) {
  const { prompt: dialogPrompt } = useDialogs();
  const [ioMessage, setIoMessage] = useState("");
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [editing, setEditing] = useState<ProviderView | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [kind, setKind] = useState<ProviderKind>("anthropic");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(KIND_PRESETS.anthropic.baseUrl);
  const [model, setModel] = useState(KIND_PRESETS.anthropic.model);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyInputKey, setApiKeyInputKey] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const cfg = await api.aiGetConfig();
    setConfig(cfg);
    onChanged();
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCreate = () => {
    setEditing(null);
    setKind("anthropic");
    setName("");
    setBaseUrl(KIND_PRESETS.anthropic.baseUrl);
    setModel(KIND_PRESETS.anthropic.model);
    setShowApiKey(false);
    setApiKeyInputKey((v) => v + 1);
    setError("");
    setSaving(false);
    setShowForm(true);
  };

  const startEdit = (p: ProviderView) => {
    setEditing(p);
    setKind(p.kind);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setShowApiKey(false);
    setApiKeyInputKey((v) => v + 1);
    setError("");
    setSaving(false);
    setShowForm(true);
  };

  const doExport = async () => {
    const path = await saveDialog({
      defaultPath: "termai-config.json",
      title: "导出配置（含会话与 AI 设置）",
    });
    if (!path) return;
    const pass = await dialogPrompt({
      title: "设置导出口令",
      password: true,
      placeholder: "至少 6 位",
      note: "导入时需要输入同一口令，请妥善保管。",
    });
    if (!pass) return;
    try {
      await api.configExport(path, pass);
      setIoMessage(`已导出到 ${path}`);
    } catch (e) {
      setIoMessage(String(e));
    }
  };

  const doImport = async () => {
    const picked = await openDialog({ multiple: false, title: "选择 TermAI 配置文件" });
    if (!picked) return;
    const pass = await dialogPrompt({ title: "输入导出口令", password: true });
    if (!pass) return;
    try {
      const r = await api.configImport(picked as string, pass);
      setIoMessage(`导入成功：${r.sessions} 个会话，${r.providers} 个 AI Provider`);
      await reload();
      onImported();
    } catch (e) {
      setIoMessage(String(e));
    }
  };

  const changeKind = (k: ProviderKind) => {
    setKind(k);
    setBaseUrl(KIND_PRESETS[k].baseUrl);
    setModel(KIND_PRESETS[k].model);
  };

  const submit = async () => {
    if (saving) return;
    if (!model.trim()) {
      setError("模型名称必填");
      return;
    }
    const apiKey = apiKeyRef.current?.value ?? "";
    if (KIND_PRESETS[kind].needKey && !editing && !apiKey.trim()) {
      setError("API Key 必填");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.aiSaveProvider({
        id: editing?.id,
        name: name.trim() || KIND_PRESETS[kind].label,
        kind,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey === "" && editing ? undefined : apiKey,
      });
      setShowForm(false);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>AI Provider 设置</h3>
        {!showForm && (
          <>
            <div className="settings-section">
              <div className="settings-section-title">界面</div>
              <div className="theme-options" role="radiogroup" aria-label="主题">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={`theme-option${theme === option.value ? " active" : ""}`}
                    onClick={() => onThemeChange(option.value)}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.value}
                  >
                    <span className={`theme-preview ${option.value}`}>
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="theme-option-copy">
                      <span>{option.label}</span>
                      <small>{option.note}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section-title">AI Provider</div>
            <div className="provider-list">
              {config?.providers.length === 0 && (
                <div className="empty-hint">尚未配置任何 AI Provider</div>
              )}
              {config?.providers.map((p) => (
                <div key={p.id} className="provider-item">
                  <input
                    type="radio"
                    name="active-provider"
                    checked={config.activeProvider === p.id}
                    onChange={async () => {
                      await api.aiSetActive(p.id);
                      await reload();
                    }}
                    title="设为当前使用"
                  />
                  <div className="session-meta">
                    <div className="session-name">
                      {p.name} <span className="tag">{KIND_PRESETS[p.kind]?.label ?? p.kind}</span>
                      {KIND_PRESETS[p.kind]?.needKey && !p.hasKey && (
                        <span className="tag warn">缺少 Key</span>
                      )}
                    </div>
                    <div className="session-host">
                      {p.model} · {p.baseUrl || "默认地址"}
                    </div>
                  </div>
                  <div className="session-ops">
                    <button className="icon-btn" onClick={() => startEdit(p)} title="编辑">
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="icon-btn danger"
                      onClick={async () => {
                        await api.aiDeleteProvider(p.id);
                        await reload();
                      }}
                      title="删除"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="io-section">
              <div className="io-title">配置迁移（跨设备）</div>
              <div className="io-actions">
                <button className="btn" onClick={doExport}>
                  导出配置...
                </button>
                <button className="btn" onClick={doImport}>
                  导入配置...
                </button>
              </div>
              {ioMessage && <div className="io-message">{ioMessage}</div>}
              <div className="form-note">
                导出文件以口令加密（PBKDF2 + AES-256-GCM），包含会话、密码与 AI 配置，可在其他电脑导入。
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>
                关闭
              </button>
              <button className="btn primary" onClick={startCreate}>
                + 添加 Provider
              </button>
            </div>
          </>
        )}
        {showForm && (
          <>
            <div className="form-grid">
              <label>类型</label>
              <select className="input" value={kind} onChange={(e) => changeKind(e.target.value as ProviderKind)}>
                {Object.entries(KIND_PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
              <label>显示名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_PRESETS[kind].label} />
              <label>Base URL</label>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <label>模型</label>
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
              {KIND_PRESETS[kind].needKey && (
                <>
                  <label>API Key</label>
                  <div className="key-picker">
                    <input
                      key={apiKeyInputKey}
                      ref={apiKeyRef}
                      className={`input api-key-input${showApiKey ? "" : " masked"}`}
                      type="text"
                      placeholder={editing?.hasKey ? "留空则保持不变" : "sk-..."}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-form-type="other"
                    />
                    <button className="btn" type="button" onClick={() => setShowApiKey((v) => !v)}>
                      {showApiKey ? "隐藏" : "显示"}
                    </button>
                  </div>
                </>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowForm(false)} disabled={saving}>
                返回
              </button>
              <button className="btn primary" onClick={submit} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
            <div className="form-note">API Key 加密后存储在本机，不会随配置文件明文泄露。</div>
          </>
        )}
      </div>
    </div>
  );
}
