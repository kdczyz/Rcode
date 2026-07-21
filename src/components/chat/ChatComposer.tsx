import { Brain, Check, ChevronDown, CornerDownRight, FileText, Image, LoaderCircle, Paperclip, Plug, Puzzle, RefreshCw, Send, Square, TerminalSquare, X } from "lucide-react";
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

export interface ComposerProviderOption {
  id: string;
  displayName: string;
  defaultModel: string;
  configured: boolean;
  enabled?: boolean;
  models?: string[];
}

export interface ComposerSkillOption {
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  scope: "project" | "user" | "builtin";
}

interface ChatComposerProps {
  prompt: string;
  modelName: string;
  modelOptions: string[];
  modelMenuOpen: boolean;
  providerId: string;
  providerName: string;
  providerOptions: ComposerProviderOption[];
  providerMenuOpen: boolean;
  providerSwitchingId?: string;
  providerModelsLoadingId?: string;
  /** 合并面板内当前高亮（未提交）的接口 id */
  modelPanelProviderId: string;
  skillOptions: ComposerSkillOption[];
  selectedSkillNames: string[];
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
  onToggleProviderMenu: () => void;
  onSelectProvider: (providerId: string) => void;
  /** 在合并面板左列点击接口（只切高亮，不提交） */
  onHighlightProvider: (providerId: string) => void;
  /** 在合并面板右列点击模型（提交：必要时切接口 + 选模型） */
  onSelectProviderModel: (providerId: string, model: string) => void;
  onToggleSkill: (skillName: string) => void;
  onClearSkills: () => void;
  onThinkingModeChange: (mode: ThinkingMode) => void;
  onTogglePermissionMenu: () => void;
  onSelectPermission: (mode: PermissionMode) => void;
  onSend: () => void;
  onGuide: () => void;
  onStop: () => void;
  onToggleManagedProcessPanel: () => void;
  onRefreshManagedProcesses: () => Promise<void>;
  onStopManagedProcess: (processId: string) => Promise<void>;
}

const thinkingOptions: Array<{ id: ThinkingMode; label: string; description: string }> = [
  { id: "fast", label: "快速", description: "关闭或降低模型原生推理，优先响应速度" },
  { id: "balanced", label: "标准", description: "使用中等或模型默认推理，平衡质量与速度" },
  { id: "deep", label: "深度", description: "请求最高可用推理强度，可能增加耗时与 token" }
];

const skillScopeLabels: Record<ComposerSkillOption["scope"], string> = {
  project: "项目",
  user: "用户",
  builtin: "内置"
};

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
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(() => new Set());
  const [processActionError, setProcessActionError] = useState("");
  const [isRefreshingProcesses, setIsRefreshingProcesses] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  // 模型切换面板内的二级 Tab："provider"=接口列表 / "model"=当前接口模型列表
  const [modelPanelTab, setModelPanelTab] = useState<"provider" | "model">("model");
  // 面板每次打开时回到「模型」页
  useEffect(() => {
    if (props.modelMenuOpen) setModelPanelTab("model");
  }, [props.modelMenuOpen]);
  const runningProcessCount = props.managedProcesses.filter((process) => process.status === "running").length;
  const selectedThinkingOption = thinkingOptions.find((option) => option.id === props.thinkingMode) ?? thinkingOptions[1];
  const hasDraft = Boolean(props.prompt.trim() || props.attachments.length > 0);

  useEffect(() => {
    if (!skillMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!skillPickerRef.current?.contains(event.target as Node)) setSkillMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSkillMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [skillMenuOpen]);

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
          placeholder={props.isRunning ? "补充方向或约束，按 Enter 立即打断并引导" : isPlanMode ? "描述目标，我会先检查上下文并给出可执行计划" : "描述任务，或输入 / 查看可用命令"}
          rows={1}
        />
        {props.isRunning ? (
          <div className="composerRunActions" aria-label="当前任务控制">
            <button className="stopResponseButton" type="button" onClick={props.onStop} aria-label="停止当前任务" title="停止当前任务">
              <Square size={13} fill="currentColor" />
            </button>
            <button className="sendButton guidanceButton" type="button" onClick={props.onGuide} disabled={!hasDraft} aria-label="立即引导当前任务" title="中止当前一轮，并按新方向继续">
              <CornerDownRight size={15} />
              <span>引导</span>
            </button>
          </div>
        ) : (
          <button className="sendButton" type="button" onClick={props.onSend} disabled={!hasDraft} aria-label="发送">
            <Send size={17} />
          </button>
        )}
      </div>
      {props.isRunning && (
        <div className="composerGuidanceHint" role="status">
          <span className="guidancePulse" aria-hidden="true" />
          新引导会立即终止当前一轮，已完成的操作会保留
        </div>
      )}
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
          <div className="skillPicker" ref={skillPickerRef}>
            <button
              className={`skillPickerButton ${skillMenuOpen || props.selectedSkillNames.length > 0 ? "active" : ""}`}
              type="button"
              aria-expanded={skillMenuOpen}
              aria-haspopup="listbox"
              aria-label={`选择 Skill${props.selectedSkillNames.length > 0 ? `，已选 ${props.selectedSkillNames.length} 个` : ""}`}
              title="选择下一次请求使用的 Skill"
              onClick={() => {
                setThinkingMenuOpen(false);
                if (props.modelMenuOpen) props.onToggleModelMenu();
                setSkillMenuOpen((open) => !open);
              }}
            >
              <Puzzle size={14} />
              <span>Skill</span>
              {props.selectedSkillNames.length > 0 && <small>{props.selectedSkillNames.length}</small>}
              <ChevronDown size={12} />
            </button>
            {skillMenuOpen && (
              <div className="skillMenu" role="listbox" aria-label="选择使用的 Skill" aria-multiselectable="true">
                <header>
                  <span>
                    <strong>使用 Skill</strong>
                    <small>最多选择 3 个，应用于当前会话的下一次请求</small>
                  </span>
                  {props.selectedSkillNames.length > 0 && (
                    <button type="button" onClick={props.onClearSkills}>清空</button>
                  )}
                </header>
                <div className="skillMenuList">
                  {props.skillOptions.map((skill) => {
                    const selected = props.selectedSkillNames.includes(skill.name);
                    const selectionLimitReached = !selected && props.selectedSkillNames.length >= 3;
                    return (
                      <button
                        className={selected ? "active" : ""}
                        key={skill.name}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={selectionLimitReached}
                        onClick={() => props.onToggleSkill(skill.name)}
                      >
                        <span className="skillMenuMark"><Puzzle size={14} /></span>
                        <span className="skillMenuCopy">
                          <strong>{skill.displayName || skill.name}</strong>
                          <small>{skill.shortDescription || skill.description}</small>
                        </span>
                        <span className="skillMenuScope">{skillScopeLabels[skill.scope]}</span>
                        <span className="skillMenuCheck">{selected && <Check size={14} />}</span>
                      </button>
                    );
                  })}
                  {props.skillOptions.length === 0 && <p>当前项目没有可用 Skill。</p>}
                </div>
                <footer>未手动选择时，仍会根据任务内容自动匹配 Skill。</footer>
              </div>
            )}
          </div>
          <div className="modelPicker">
            <button
              className={`modelPickerButton ${props.modelMenuOpen ? "active" : ""}`}
              type="button"
              aria-expanded={props.modelMenuOpen}
              aria-haspopup="dialog"
              title={`当前接口：${props.providerName || "未选择"} · 模型：${props.modelName}`}
              onClick={() => {
                setSkillMenuOpen(false);
                setThinkingMenuOpen(false);
                props.onToggleModelMenu();
              }}
            >
              <Plug size={13} />
              <span>{props.modelName}</span>
              <ChevronDown size={14} />
            </button>
            {props.modelMenuOpen && (
              <div className="modelSwitchPanel modelSwitchPanelTabbed" role="dialog" aria-label="选择接口与模型">
                <header className="modelSwitchTabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modelPanelTab === "provider"}
                    className={modelPanelTab === "provider" ? "active" : ""}
                    onClick={() => setModelPanelTab("provider")}
                  >
                    接口
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modelPanelTab === "model"}
                    className={modelPanelTab === "model" ? "active" : ""}
                    onClick={() => setModelPanelTab("model")}
                  >
                    模型
                  </button>
                </header>

                {modelPanelTab === "provider" && (
                  <div className="modelSwitchTabBody" role="tabpanel" aria-label="接口列表">
                    {props.providerOptions.length === 0 && <p className="modelSwitchEmpty">请先在设置中添加 AI 接口。</p>}
                    {props.providerOptions.map((provider) => {
                      const isActive = provider.id === props.providerId;
                      const isSwitching = provider.id === props.providerSwitchingId;
                      const unavailable = provider.enabled === false || !provider.configured;
                      return (
                        <button
                          className={isActive ? "active" : ""}
                          key={provider.id}
                          type="button"
                          disabled={unavailable}
                          onClick={() => {
                            // 接口只在点击时生效；如果想换模型，跳到模型 Tab
                            props.onHighlightProvider(provider.id);
                            setModelPanelTab("model");
                          }}
                        >
                          <span className="providerMenuCopy">
                            <strong>{provider.displayName}</strong>
                            <small>{provider.defaultModel || "未设置默认模型"}</small>
                          </span>
                          <span className="providerMenuState">
                            {isSwitching ? <LoaderCircle size={14} className="toolStatusSpinner" /> : isActive ? <Check size={14} /> : unavailable ? "未配置" : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {modelPanelTab === "model" && (
                  <div className="modelSwitchTabBody" role="tabpanel" aria-label="模型列表">
                    {(() => {
                      const highlightedId = props.modelPanelProviderId || props.providerId;
                      const highlightedProvider = props.providerOptions.find((p) => p.id === highlightedId);
                      const isCurrentProvider = highlightedId === props.providerId;
                      const isLoadingModels = highlightedId === props.providerModelsLoadingId;
                      const modelsToShow: string[] = isCurrentProvider
                        ? models
                        : (highlightedProvider?.models && highlightedProvider.models.length > 0
                            ? highlightedProvider.models
                            : (highlightedProvider?.defaultModel ? [highlightedProvider.defaultModel] : []));
                      if (!highlightedProvider) {
                        return <p className="modelSwitchEmpty">请先在「接口」页选择一个接口。</p>;
                      }
                      return (
                        <>
                          <header className="modelSwitchTabContext">
                            <span>{highlightedProvider.displayName}</span>
                            {isLoadingModels && <LoaderCircle size={13} className="toolStatusSpinner" aria-label="正在刷新模型" />}
                          </header>
                          {modelsToShow.length === 0 ? (
                            <p className="modelSwitchEmpty">该接口暂无可用模型。</p>
                          ) : (
                            modelsToShow.map((model: string) => {
                              const isCurrentModel = isCurrentProvider && model === props.modelName;
                              return (
                                <button
                                  className={isCurrentModel ? "active" : ""}
                                  key={model}
                                  type="button"
                                  onClick={() => props.onSelectProviderModel(highlightedId, model)}
                                >
                                  <span>{model}</span>
                                  {isCurrentModel && <Check size={14} />}
                                </button>
                              );
                            })
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="thinkingPicker" ref={thinkingPickerRef}>
            <button
              className={`thinkingMode ${thinkingMenuOpen ? "active" : ""}`}
              type="button"
              aria-expanded={thinkingMenuOpen}
              aria-haspopup="listbox"
              aria-label={`思考模式：${selectedThinkingOption.label}，用于下一次请求`}
              title={`下次请求：${selectedThinkingOption.label}。${selectedThinkingOption.description}`}
              onClick={() => {
                setSkillMenuOpen(false);
                if (props.modelMenuOpen) props.onToggleModelMenu();
                setThinkingMenuOpen((open) => !open);
              }}
            >
              <Brain size={14} />
              <span>{selectedThinkingOption.label}</span>
              <ChevronDown size={12} />
            </button>
            {thinkingMenuOpen && (
              <div className="thinkingMenu" role="listbox" aria-label="思考模式">
                <header>
                  <strong>思考模式</strong>
                  <span>用于下一次请求，并按当前模型与接口转换为真实推理参数</span>
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
                <footer>历史回复保留当时模式；回复统计展示该次实际使用的配置。</footer>
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
          <span className={`composerHint ${attachmentError ? "error" : ""}`}>{attachmentError || "Enter 发送 · 可粘贴图片或文件"}</span>
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
