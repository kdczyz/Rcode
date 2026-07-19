import { Brain, Check, ChevronDown, FileText, Image, LoaderCircle, Paperclip, RefreshCw, Send, Square, TerminalSquare, X } from "lucide-react";
import { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ManagedProcessView } from "./ToolCallGroup";

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  dataUrl?: string;
  url?: string;
  text?: string;
}

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
  imageMode: boolean;
  imageGenerationAvailable: boolean;
  thinkingMode: ThinkingMode;
  permissionMode: PermissionMode;
  permissionOptions: PermissionOption[];
  selectedPermission: PermissionOption;
  permissionMenuOpen: boolean;
  queueLength: number;
  isRunning: boolean;
  attachments: ComposerAttachment[];
  projectName?: string;
  projectPath?: string;
  managedProcesses: ManagedProcessView[];
  managedProcessPanelOpen: boolean;
  managedProcessLoadError?: string;
  onPromptChange: (value: string) => void;
  onAttachmentsChange: (attachments: ComposerAttachment[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onToggleModelMenu: () => void;
  onSelectModel: (model: string) => void;
  onToggleImageMode: () => void;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  onTogglePermissionMenu: () => void;
  onSelectPermission: (mode: PermissionMode) => void;
  onSend: () => void;
  onToggleManagedProcessPanel: () => void;
  onRefreshManagedProcesses: () => Promise<void>;
  onStopManagedProcess: (processId: string) => Promise<void>;
}

const thinkingOptions: Array<{ id: ThinkingMode; label: string; description: string }> = [
  { id: "fast", label: "快速", description: "关闭或降低模型原生推理，优先响应速度" },
  { id: "balanced", label: "标准", description: "使用中等或模型默认推理，平衡质量与速度" },
  { id: "deep", label: "深度", description: "请求最高可用推理强度，可能增加耗时与 token" }
];

const maxAttachmentCount = 8;
const maxAttachmentBytes = 8 * 1024 * 1024;
const maxTextAttachmentBytes = 1024 * 1024;
const maxTotalAttachmentBytes = 16 * 1024 * 1024;
const textFileExtensions = new Set([
  "txt", "md", "mdx", "json", "jsonl", "yaml", "yml", "toml", "csv", "tsv", "xml", "html", "css", "scss", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "php", "java", "kt", "kts", "go", "rs", "c", "h", "cpp", "hpp",
  "cs", "swift", "scala", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql", "vue", "svelte", "r", "log", "ini", "env"
]);

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isTextFile(file: File) {
  if (file.type.startsWith("text/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return textFileExtensions.has(extension) || /(?:json|xml|yaml|toml|javascript|typescript|csv|sql)/i.test(file.type);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function toComposerAttachment(file: File): Promise<ComposerAttachment> {
  const mimeType = file.type || "application/octet-stream";
  const textFile = isTextFile(file);
  if (textFile && file.size > maxTextAttachmentBytes) {
    throw new Error(`${file.name} 超过文本文件 1 MB 限制`);
  }
  return {
    id: `attachment_${crypto.randomUUID()}`,
    name: file.name || (mimeType.startsWith("image/") ? "粘贴的图片" : "未命名文件"),
    mimeType,
    size: file.size,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    ...(textFile ? { text: await file.text() } : { dataUrl: await readFileAsDataUrl(file) })
  };
}

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
  const thinkingPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(() => new Set());
  const [processActionError, setProcessActionError] = useState("");
  const [isRefreshingProcesses, setIsRefreshingProcesses] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const runningProcessCount = props.managedProcesses.filter((process) => process.status === "running").length;
  const selectedThinkingOption = thinkingOptions.find((option) => option.id === props.thinkingMode) ?? thinkingOptions[1];

  useEffect(() => {
    if (!thinkingMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!thinkingPickerRef.current?.contains(event.target as Node)) setThinkingMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setThinkingMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [thinkingMenuOpen]);

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

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setAttachmentError("");
    const existingBytes = props.attachments.reduce((total, attachment) => total + attachment.size, 0);
    const availableCount = maxAttachmentCount - props.attachments.length;
    if (availableCount <= 0) {
      setAttachmentError(`最多添加 ${maxAttachmentCount} 个附件`);
      return;
    }
    const accepted: File[] = [];
    let totalBytes = existingBytes;
    for (const file of files.slice(0, availableCount)) {
      if (file.size > maxAttachmentBytes) {
        setAttachmentError(`${file.name} 超过单文件 8 MB 限制`);
        continue;
      }
      if (totalBytes + file.size > maxTotalAttachmentBytes) {
        setAttachmentError("附件总大小不能超过 16 MB");
        break;
      }
      const duplicate = props.attachments.some((item) => item.name === file.name && item.size === file.size && item.mimeType === (file.type || "application/octet-stream"));
      if (duplicate) continue;
      accepted.push(file);
      totalBytes += file.size;
    }
    if (accepted.length === 0) return;
    try {
      const next = await Promise.all(accepted.map(toComposerAttachment));
      props.onAttachmentsChange([...props.attachments, ...next]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "读取附件失败");
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) void addFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingFiles(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className={`chatComposer ${isPlanMode ? "planMode" : ""} ${isDraggingFiles ? "draggingFiles" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setIsDraggingFiles(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingFiles(false);
      }}
      onDrop={handleDrop}
    >
      {isPlanMode && (
        <div className="composerModeContext" aria-live="polite">
          <span>计划模式</span>
          <small>仅分析与只读检查，生成计划后由你确认执行</small>
        </div>
      )}
      {props.attachments.length > 0 && (
        <div className="composerAttachmentTray" aria-label="待发送附件">
          {props.attachments.map((attachment) => (
            <article className={`composerAttachment ${attachment.kind}`} key={attachment.id}>
              {attachment.kind === "image" && attachment.dataUrl ? (
                <img src={attachment.dataUrl} alt={attachment.name} />
              ) : (
                <span className="composerFileIcon">{attachment.kind === "image" ? <Image size={18} /> : <FileText size={18} />}</span>
              )}
              <span className="composerAttachmentInfo">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
              <button
                type="button"
                aria-label={`移除 ${attachment.name}`}
                title="移除附件"
                onClick={() => props.onAttachmentsChange(props.attachments.filter((item) => item.id !== attachment.id))}
              >
                <X size={13} />
              </button>
            </article>
          ))}
        </div>
      )}
      <div className="composerPromptRow">
        <textarea
          aria-label="聊天输入框"
          value={props.prompt}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => props.onPromptChange(event.target.value)}
          onKeyDown={props.onKeyDown}
          onPaste={handlePaste}
          placeholder={props.imageMode ? "描述你想生成的画面、风格、构图和文字" : isPlanMode ? "描述目标，我会先检查上下文并给出可执行计划" : "描述任务，或输入 / 查看可用命令"}
          rows={1}
        />
        <button className={`sendButton ${props.isRunning ? "stopping" : ""}`} type="button" onClick={props.onSend} disabled={!props.isRunning && !props.prompt.trim() && props.attachments.length === 0} aria-label={props.isRunning ? "停止回复" : "发送"}>
          {props.isRunning ? <Square size={15} /> : <Send size={17} />}
        </button>
      </div>
      <div className="composerFooter">
        <div className="composerControls">
          <input
            ref={fileInputRef}
            className="composerFileInput"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button className="attachmentPickerButton" type="button" onClick={() => fileInputRef.current?.click()} title="添加图片或文件，也可以直接粘贴">
            <Paperclip size={14} />
            <span>附件</span>
          </button>
          <button
            className={`attachmentPickerButton ${props.imageMode ? "active" : ""}`}
            type="button"
            onClick={props.onToggleImageMode}
            disabled={!props.imageGenerationAvailable || props.isRunning}
            title={props.imageGenerationAvailable ? "切换文本对话与图片生成" : "请先在当前 AI 接口中配置图片模型"}
          >
            <Image size={14} />
            <span>{props.imageMode ? "生图中" : "生图"}</span>
          </button>
          <div className="modelPicker">
            <button className="modelPickerButton" type="button" onClick={props.onToggleModelMenu}><span>{props.modelName}</span><ChevronDown size={14} /></button>
            {props.modelMenuOpen && (
              <div className="modelMenu">
                {models.map((model) => <button className={model === props.modelName ? "active" : ""} key={model} type="button" onClick={() => props.onSelectModel(model)}>{model}</button>)}
              </div>
            )}
          </div>
          <div className="thinkingPicker" ref={thinkingPickerRef}>
            <button
              className={`thinkingMode ${thinkingMenuOpen ? "active" : ""}`}
              type="button"
              aria-expanded={thinkingMenuOpen}
              aria-haspopup="listbox"
              title={selectedThinkingOption.description}
              onClick={() => setThinkingMenuOpen((open) => !open)}
            >
              <Brain size={14} />
              <span>{selectedThinkingOption.label}</span>
              <ChevronDown size={12} />
            </button>
            {thinkingMenuOpen && (
              <div className="thinkingMenu" role="listbox" aria-label="思考模式">
                <header>
                  <strong>思考模式</strong>
                  <span>按当前模型与接口转换为真实推理参数</span>
                </header>
                {thinkingOptions.map((item) => (
                  <button
                    className={item.id === props.thinkingMode ? "active" : ""}
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === props.thinkingMode}
                    onClick={() => {
                      props.onThinkingModeChange(item.id);
                      setThinkingMenuOpen(false);
                    }}
                  >
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    {item.id === props.thinkingMode && <Check size={15} />}
                  </button>
                ))}
                <footer>回复统计会标明原生直连、中转转换或提示兼容。</footer>
              </div>
            )}
          </div>
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
          <span className={`composerHint ${attachmentError ? "error" : ""}`}>{attachmentError || (props.imageMode ? "Enter 生成 · 图片会保存到本机" : "Enter 发送 · 可粘贴图片或文件")}</span>
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
