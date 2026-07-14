import { Brain, Check, ChevronDown, LoaderCircle, RefreshCw, Send, Square, TerminalSquare, X } from "lucide-react";
import { ChangeEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ManagedProcessView } from "./ToolCallGroup";

type ThinkingMode = "fast" | "balanced" | "deep";
type PermissionMode = "default" | "plan" | "workspace_write" | "full_access" | "custom";

interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
}

interface ChatComposerProps {
  prompt: string;
  modelName: string;
  modelOptions: string[];
  modelMenuOpen: boolean;
  thinkingMode: ThinkingMode;
  permissionMode: PermissionMode;
  permissionOptions: PermissionOption[];
  selectedPermission: PermissionOption;
  permissionMenuOpen: boolean;
  queueLength: number;
  isRunning: boolean;
  projectName?: string;
  projectPath?: string;
  managedProcesses: ManagedProcessView[];
  managedProcessPanelOpen: boolean;
  managedProcessLoadError?: string;
  onPromptChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onToggleModelMenu: () => void;
  onSelectModel: (model: string) => void;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  onTogglePermissionMenu: () => void;
  onSelectPermission: (mode: PermissionMode) => void;
  onSend: () => void;
  onToggleManagedProcessPanel: () => void;
  onRefreshManagedProcesses: () => Promise<void>;
  onStopManagedProcess: (processId: string) => Promise<void>;
}

const thinkingOptions: Array<{ id: ThinkingMode; label: string }> = [
  { id: "fast", label: "快速" },
  { id: "balanced", label: "标准" },
  { id: "deep", label: "深度" }
];

function processStatusLabel(process: ManagedProcessView) {
  if (process.status === "running") return "运行中";
  if (process.status === "stopped") return "已停止";
  if (process.status === "failed") return "异常退出";
  return process.exitCode === 0 ? "已退出" : `退出码 ${process.exitCode ?? "未知"}`;
}

function formatStartedAt(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

export function ChatComposer(props: ChatComposerProps) {
  const models = props.modelOptions.length > 0 ? props.modelOptions : [props.modelName];
  const isPlanMode = props.permissionMode === "plan";
  const processPickerRef = useRef<HTMLDivElement>(null);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(() => new Set());
  const [processActionError, setProcessActionError] = useState("");
  const [isRefreshingProcesses, setIsRefreshingProcesses] = useState(false);
  const runningProcessCount = props.managedProcesses.filter((process) => process.status === "running").length;

  useEffect(() => {
    if (!props.managedProcessPanelOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (processPickerRef.current?.contains(event.target as Node)) return;
      props.onToggleManagedProcessPanel();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") props.onToggleManagedProcessPanel();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.managedProcessPanelOpen, props.onToggleManagedProcessPanel]);

  async function refreshProcesses() {
    if (isRefreshingProcesses) return;
    setIsRefreshingProcesses(true);
    setProcessActionError("");
    try {
      await props.onRefreshManagedProcesses();
    } catch (error) {
      setProcessActionError(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setIsRefreshingProcesses(false);
    }
  }

  async function stopProcess(processId: string) {
    setStoppingProcessIds((current) => new Set(current).add(processId));
    setProcessActionError("");
    try {
      await props.onStopManagedProcess(processId);
    } catch (error) {
      setProcessActionError(error instanceof Error ? error.message : "停止进程失败");
    } finally {
      setStoppingProcessIds((current) => {
        const next = new Set(current);
        next.delete(processId);
        return next;
      });
    }
  }

  return (
    <div className={`chatComposer ${isPlanMode ? "planMode" : ""}`}>
      {isPlanMode && (
        <div className="composerModeContext" aria-live="polite">
          <span>计划模式</span>
          <small>仅分析与只读检查，生成计划后由你确认执行</small>
        </div>
      )}
      <div className="composerPromptRow">
        <textarea
          aria-label="聊天输入框"
          value={props.prompt}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => props.onPromptChange(event.target.value)}
          onKeyDown={props.onKeyDown}
          placeholder={isPlanMode ? "描述目标，我会先检查上下文并给出可执行计划" : "描述任务，或输入 / 查看可用命令"}
          rows={1}
        />
        <button className={`sendButton ${props.isRunning ? "stopping" : ""}`} type="button" onClick={props.onSend} disabled={!props.isRunning && !props.prompt.trim()} aria-label={props.isRunning ? "停止回复" : "发送"}>
          {props.isRunning ? <Square size={15} /> : <Send size={17} />}
        </button>
      </div>
      <div className="composerFooter">
        <div className="composerControls">
          <div className="modelPicker">
            <button className="modelPickerButton" type="button" onClick={props.onToggleModelMenu}><span>{props.modelName}</span><ChevronDown size={14} /></button>
            {props.modelMenuOpen && (
              <div className="modelMenu">
                {models.map((model) => <button className={model === props.modelName ? "active" : ""} key={model} type="button" onClick={() => props.onSelectModel(model)}>{model}</button>)}
              </div>
            )}
          </div>
          <label className="thinkingMode">
            <Brain size={14} />
            <select value={props.thinkingMode} onChange={(event) => props.onThinkingModeChange(event.target.value as ThinkingMode)}>
              {thinkingOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <div className="managedProcessPicker" ref={processPickerRef}>
            <button
              className={`managedProcessButton ${props.managedProcessPanelOpen ? "active" : ""}`}
              type="button"
              aria-expanded={props.managedProcessPanelOpen}
              aria-haspopup="dialog"
              title="查看当前项目的长期进程与终端会话"
              onClick={props.onToggleManagedProcessPanel}
            >
              <TerminalSquare size={14} />
              <span>终端</span>
              <small className={runningProcessCount > 0 ? "running" : ""}>{runningProcessCount}</small>
            </button>
            {props.managedProcessPanelOpen && (
              <section className="managedProcessPopover" role="dialog" aria-label="当前项目的长期进程与终端会话">
                <header className="managedProcessPopoverHeader">
                  <div>
                    <strong>长期进程</strong>
                    <span>{props.projectName ?? "未选择项目"}{runningProcessCount > 0 ? ` · ${runningProcessCount} 个运行中` : ""}</span>
                  </div>
                  <div>
                    <button type="button" aria-label="刷新长期进程" title="刷新" onClick={() => void refreshProcesses()} disabled={isRefreshingProcesses}>
                      <RefreshCw size={14} className={isRefreshingProcesses ? "toolStatusSpinner" : ""} />
                    </button>
                    <button type="button" aria-label="关闭长期进程面板" title="关闭" onClick={props.onToggleManagedProcessPanel}><X size={15} /></button>
                  </div>
                </header>
                <div className="managedProcessPopoverBody">
                  {!props.projectPath ? (
                    <div className="managedProcessEmpty">
                      <TerminalSquare size={20} />
                      <strong>当前没有关联项目</strong>
                      <span>选择一个项目后，可在这里查看它的长期进程。</span>
                    </div>
                  ) : props.managedProcesses.length === 0 ? (
                    <div className="managedProcessEmpty">
                      <TerminalSquare size={20} />
                      <strong>没有长期进程</strong>
                      <span>启动开发服务器或监听任务后会显示在这里。</span>
                    </div>
                  ) : (
                    <div className="managedProcessSessionList">
                      {props.managedProcesses.map((process) => {
                        const isStopping = stoppingProcessIds.has(process.id);
                        return (
                          <article className="managedProcessSession" key={process.id}>
                            <div className="managedProcessSessionHead">
                              <span className={`managedProcessLiveDot ${process.status}`} aria-hidden="true" />
                              <div>
                                <strong>{process.label ?? process.command}</strong>
                                <code title={process.command}>{process.command}</code>
                              </div>
                              <span className={`managedProcessSessionStatus ${process.status}`}>{processStatusLabel(process)}</span>
                            </div>
                            <div className="managedProcessSessionMeta">
                              {process.pid && <span>PID {process.pid}</span>}
                              <span>{formatStartedAt(process.startedAt)}</span>
                              {process.exitCode !== undefined && <span>退出码 {process.exitCode}</span>}
                            </div>
                            <div className="managedProcessSessionActions">
                              <details>
                                <summary>查看输出</summary>
                                <pre>{process.output || "进程暂时没有输出。"}</pre>
                              </details>
                              {process.status === "running" && (
                                <button type="button" onClick={() => void stopProcess(process.id)} disabled={isStopping}>
                                  {isStopping ? <LoaderCircle size={12} className="toolStatusSpinner" /> : <Square size={10} fill="currentColor" />}
                                  {isStopping ? "停止中" : "停止"}
                                </button>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>
                <footer className="managedProcessPopoverFooter">
                  <span>关闭 Rcode 会停止所有会话；重启后不会自动拉起。</span>
                  {(processActionError || props.managedProcessLoadError) && <strong>{processActionError || props.managedProcessLoadError}</strong>}
                </footer>
              </section>
            )}
          </div>
          {props.queueLength > 0 && <span className="queueBadge">队列 {props.queueLength}</span>}
        </div>
        <div className="composerActions">
          <span className="composerHint">Enter 发送 · Shift + Enter 换行</span>
          <div className="permissionPicker">
            <button className="permissionModeButton" type="button" title={props.selectedPermission.description} onClick={props.onTogglePermissionMenu}>
              <span>{props.selectedPermission.label}</span><ChevronDown size={14} />
            </button>
            {props.permissionMenuOpen && (
              <div className="permissionMenu">
                {props.permissionOptions.map((item) => (
                  <button className={item.id === props.permissionMode ? "active" : ""} key={item.id} type="button" onClick={() => props.onSelectPermission(item.id)}>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    {item.id === props.permissionMode && <Check size={16} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
