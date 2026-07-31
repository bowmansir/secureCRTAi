import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface PromptOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  password?: boolean;
  /** 提示性小字 */
  note?: string;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  danger?: boolean;
  okText?: string;
  hideCancel?: boolean;
}

interface ApprovalOptions {
  title: string;
  command: string;
  reason?: string;
}

export type ApprovalChoice = "execute" | "modify" | "reject";

interface DialogApi {
  prompt: (opts: PromptOptions) => Promise<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  approval: (opts: ApprovalOptions) => Promise<ApprovalChoice>;
}

const Ctx = createContext<DialogApi>({
  prompt: async () => null,
  confirm: async () => false,
  approval: async () => "reject",
});

export function useDialogs() {
  return useContext(Ctx);
}

type Pending =
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | {
      kind: "approval";
      opts: ApprovalOptions;
      resolve: (v: ApprovalChoice) => void;
    };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setValue(opts.defaultValue ?? "");
      setPending({ kind: "prompt", opts, resolve });
    });
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ kind: "confirm", opts, resolve });
    });
  }, []);

  const approval = useCallback((opts: ApprovalOptions) => {
    return new Promise<ApprovalChoice>((resolve) => {
      setPending({ kind: "approval", opts, resolve });
    });
  }, []);

  useEffect(() => {
    if (pending?.kind === "prompt") {
      // 等弹窗渲染后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pending]);

  const close = (result: boolean | ApprovalChoice) => {
    if (!pending) return;
    if (pending.kind === "prompt") {
      pending.resolve(result === true ? value : null);
    } else if (pending.kind === "confirm") {
      pending.resolve(result === true);
    } else {
      pending.resolve(
        typeof result === "string"
          ? result
          : result
            ? "execute"
            : "reject"
      );
    }
    setPending(null);
    setValue("");
  };

  return (
    <Ctx.Provider value={{ prompt, confirm, approval }}>
      {children}
      {pending && (
        <div className="modal-mask dialog-mask" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
          <div
            className="modal dialog"
            onKeyDown={(e) => {
              if (e.key === "Enter") close(true);
              if (e.key === "Escape") close(false);
            }}
          >
            <h3>{pending.opts.title}</h3>
            {pending.kind === "prompt" ? (
              <>
                <input
                  ref={inputRef}
                  className="input dialog-input"
                  type={pending.opts.password ? "password" : "text"}
                  placeholder={pending.opts.placeholder}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                {pending.opts.note && <div className="form-note">{pending.opts.note}</div>}
              </>
            ) : pending.kind === "confirm" ? (
              pending.opts.message && <div className="dialog-message">{pending.opts.message}</div>
            ) : (
              <div className="dialog-message agent-approval-dialog">
                <span>Agent 请求执行高风险命令</span>
                <code>{pending.opts.command}</code>
                {pending.opts.reason && <span>风险：{pending.opts.reason}</span>}
              </div>
            )}
            <div className="modal-footer">
              {pending.kind === "approval" ? (
                <>
                  <button className="btn" onClick={() => close("reject")}>
                    拒绝
                  </button>
                  <button className="btn" onClick={() => close("modify")}>
                    修改
                  </button>
                  <button
                    className="btn danger-btn"
                    onClick={() => close("execute")}
                  >
                    执行
                  </button>
                </>
              ) : (
                <>
                  {!(pending.kind === "confirm" && pending.opts.hideCancel) && (
                    <button className="btn" onClick={() => close(false)}>
                      取消
                    </button>
                  )}
                  <button
                    className={`btn ${
                      pending.kind === "confirm" && pending.opts.danger
                        ? "danger-btn"
                        : "primary"
                    }`}
                    onClick={() => close(true)}
                    autoFocus={pending.kind === "confirm"}
                  >
                    {pending.kind === "confirm"
                      ? pending.opts.okText ?? "确定"
                      : "确定"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
