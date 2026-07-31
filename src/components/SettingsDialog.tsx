import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import { useDialogs } from "./Dialogs";
import Icon from "./Icons";
import type {
  AiConfigView,
  AppTheme,
  ProviderKind,
  ProviderView,
} from "../types";

interface Props {
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => Promise<void>;
  backgroundThemeId: string | null;
  onBackgroundThemeChange: (themeId: string | null) => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
  /** 导入配置后刷新会话列表等 */
  onImported: () => void;
}

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

function LazyThemePreview({
  themeId,
  revision,
}: {
  themeId: string;
  revision: number;
}) {
  const previewRef = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    let cancelled = false;
    let started = false;

    const load = () => {
      if (started) return;
      started = true;
      void api
        .themeLoadAsset(themeId, "preview")
        .then((asset) => {
          if (!cancelled) {
            setSource(`data:${asset.mimeType};base64,${asset.base64}`);
          }
        })
        .catch(() => {});
    };

    if (!("IntersectionObserver" in window)) {
      load();
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          observer.disconnect();
        }
      },
      { rootMargin: "180px" }
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [revision, themeId]);

  return (
    <span
      ref={previewRef}
      className={`custom-theme-preview${source ? " loaded" : ""}`}
      style={source ? { backgroundImage: `url("${source}")` } : undefined}
    />
  );
}

export default function SettingsDialog({
  theme,
  onThemeChange,
  backgroundThemeId,
  onBackgroundThemeChange,
  onClose,
  onChanged,
  onImported,
}: Props) {
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
  const themeLoadSeq = useRef(0);
  const [themeLibrary, setThemeLibrary] = useState<Awaited<ReturnType<typeof api.themeList>> | null>(null);
  const [themePreviewRevision, setThemePreviewRevision] = useState(0);
  const [themeMessage, setThemeMessage] = useState("");
  const [themesLoading, setThemesLoading] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);

  const reload = async () => {
    const cfg = await api.aiGetConfig();
    setConfig(cfg);
    onChanged();
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveColorTheme = async (nextTheme: AppTheme) => {
    setThemeSaving(true);
    setThemeMessage("");
    try {
      await onThemeChange(nextTheme);
    } catch (error) {
      setThemeMessage(`保存主题配置失败: ${String(error)}`);
    } finally {
      setThemeSaving(false);
    }
  };

  const saveBackgroundTheme = async (themeId: string | null) => {
    setThemeSaving(true);
    setThemeMessage("");
    try {
      await onBackgroundThemeChange(themeId);
    } catch (error) {
      setThemeMessage(`保存图片主题配置失败: ${String(error)}`);
    } finally {
      setThemeSaving(false);
    }
  };

  const reloadThemes = async () => {
    const seq = ++themeLoadSeq.current;
    setThemesLoading(true);
    setThemeMessage("");
    try {
      const library = await api.themeList();
      if (seq !== themeLoadSeq.current) return;
      setThemeLibrary(library);
      setThemePreviewRevision((revision) => revision + 1);
    } catch (error) {
      if (seq === themeLoadSeq.current) setThemeMessage(String(error));
    } finally {
      if (seq === themeLoadSeq.current) setThemesLoading(false);
    }
  };

  useEffect(() => {
    void reloadThemes();
    return () => {
      themeLoadSeq.current += 1;
    };
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
                    onClick={() => void saveColorTheme(option.value)}
                    disabled={themeSaving}
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
            <div className="settings-section">
              <div className="custom-theme-head">
                <div>
                  <div className="settings-section-title">图片背景</div>
                  <small>{themeLibrary?.root ?? "~/.codexthemes/themes"}</small>
                </div>
                <div className="custom-theme-actions">
                  <button
                    className="icon-btn"
                    type="button"
                    title="打开主题目录"
                    onClick={() => void api.themeOpenFolder()}
                  >
                    <Icon name="folder" size={15} />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    title="刷新主题"
                    disabled={themesLoading}
                    onClick={() => void reloadThemes()}
                  >
                    <Icon name="refresh" size={15} />
                  </button>
                </div>
              </div>
              <div className="custom-theme-grid" role="radiogroup" aria-label="图片背景">
                <button
                  className={`custom-theme-card${backgroundThemeId === null ? " active" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked={backgroundThemeId === null}
                  disabled={themeSaving}
                  onClick={() => void saveBackgroundTheme(null)}
                >
                  <span className="custom-theme-preview empty" />
                  <span className="custom-theme-copy">
                    <strong>无背景</strong>
                    <small>保持当前纯色主题</small>
                  </span>
                </button>
                {themeLibrary?.themes
                  .filter((item) => item.hasArt)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={`custom-theme-card${
                        backgroundThemeId === item.id ? " active" : ""
                      }`}
                      type="button"
                      role="radio"
                      aria-checked={backgroundThemeId === item.id}
                      disabled={themeSaving}
                      onClick={() => void saveBackgroundTheme(item.id)}
                    >
                      <LazyThemePreview
                        themeId={item.id}
                        revision={themePreviewRevision}
                      />
                      <span className="custom-theme-copy">
                        <strong>{item.displayName}</strong>
                        <small>{item.description || item.mode}</small>
                      </span>
                    </button>
                  ))}
              </div>
              {!themesLoading &&
                !themeMessage &&
                themeLibrary?.themes.every((item) => !item.hasArt) && (
                  <div className="custom-theme-empty">暂无图片主题</div>
                )}
              {themeMessage && <div className="form-error">{themeMessage}</div>}
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
