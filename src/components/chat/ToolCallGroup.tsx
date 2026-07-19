import {
  Braces,
  Check,
  ChevronDown,
  FilePenLine,
  FileText,
  LoaderCircle,
  Puzzle,
  Search,
  Square,
  TerminalSquare,
  X
} from "lucide-react";
import { useEffect, useState } from "react";

type ToolCategory = "command" | "edit" | "read" | "lookup" | "other";
type ToolStatus = "running" | "ok" | "fail";

export interface ManagedProcessView {
  id: string;
  command: string;
  label?: string;
  cwd: string;
  projectPath?: string;
  pid?: number;
  status: "running" | "exited" | "stopped" | "failed";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  output: string;
  outputVersion: number;
}

export interface ToolCallItemView {
  id: string;
  name: string;
  target?: string;
  status: ToolStatus;
  args?: string;
  result?: string;
  process?: ManagedProcessView;
  addedLines: number;
  removedLines: number;
  isEstimate: boolean;
}

export interface ToolActivityGroupView {
  category: ToolCategory;
  title: string;
  items: ToolCallItemView[];
}

interface ToolCallGroupProps {
  groupId: string;
  label: string;
  detail?: string;
  isRunning: boolean;
  isEditGroup: boolean;
  defaultOpen: boolean;
  failedCount: number;
  addedLines: number;
  removedLines: number;
  isDiffEstimate: boolean;
  activeSkills: Array<{ name: string; label: string }>;
  activityGroups: ToolActivityGroupView[];
  onClosed: (groupId: string) => void;
  onStopProcess?: (processId: string) => Promise<void>;
}

const toolNames: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  apply_patch: "编辑文本",
  run_shell: "执行命令",
  start_process: "启动长期进程",
  read_process: "读取进程",
  write_process: "发送进程输入",
  stop_process: "停止进程",
  list_processes: "查看进程",
  search_text: "搜索代码",
  project_diagnostics: "项目诊断",
  list_files: "浏览目录",
  inspect_tree: "检查目录",
  web_fetch: "获取网页",
  docker_compose: "Docker Compose",
  sqlite_query: "SQLite 查询",
  git_push: "推送代码",
  git_status: "检查状态",
  git_diff: "查看差异"
};

function CategoryIcon({ category, size = 15 }: { category: ToolCategory; size?: number }) {
  if (category === "command") return <TerminalSquare size={size} />;
  if (category === "edit") return <FilePenLine size={size} />;
  if (category === "read") return <FileText size={size} />;
  if (category === "lookup") return <Search size={size} />;
  return <Braces size={size} />;
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <LoaderCircle size={13} className="toolStatusSpinner" />;
  if (status === "fail") return <X size={13} />;
  return <Check size={13} />;
}

function processStatusLabel(process: ManagedProcessView) {
  if (process.status === "running") return "运行中";
  if (process.status === "stopped") return "已停止";
  if (process.status === "failed") return "异常退出";
  return process.exitCode === 0 ? "已退出" : `退出 ${process.exitCode ?? ""}`.trim();
}

function ToolCallItem({ item, onStopProcess }: { item: ToolCallItemView; onStopProcess?: (processId: string) => Promise<void> }) {
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const hasDetails = Boolean(item.args || item.result || item.process);

  async function stopProcess() {
    if (!item.process || !onStopProcess || isStopping) return;
    setIsStopping(true);
    setStopError("");
    try {
      await onStopProcess(item.process.id);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "停止进程失败");
    } finally {
      setIsStopping(false);
    }
  }

  return (
    <details className={`toolCallItem ${item.status}`} open={item.status === "running"}>
      <summary className="toolCallItemSummary">
        <span className={`toolCallRailDot ${item.status}`}><StatusIcon status={item.status} /></span>
        <span className="toolCallIdentity">
          <strong>{toolNames[item.name] ?? "调用工具"}</strong>
          <code>{item.name}</code>
        </span>
        {item.target && <span className="toolCallTarget" title={item.target}>{item.target}</span>}
        {(item.addedLines > 0 || item.removedLines > 0) && (
          <span
            className={`toolDiffInline compact ${item.isEstimate ? "isEstimating" : ""}`}
            aria-live="polite"
            title={item.isEstimate ? "实时预估，编辑完成后校准" : "实际代码变更"}
          >
            {item.addedLines > 0 && <span className="toolDiffAdd" key={`add-${item.addedLines}`}>+{item.addedLines}</span>}
            {item.removedLines > 0 && <span className="toolDiffRemove" key={`remove-${item.removedLines}`}>-{item.removedLines}</span>}
          </span>
        )}
        <span className={`toolCallState ${item.status}`}>{item.status === "running" ? "运行中" : item.status === "ok" ? "完成" : "失败"}</span>
        {hasDetails && <ChevronDown className="toolCallItemArrow" size={15} />}
      </summary>
      {hasDetails && (
        <div className="toolCallDetails">
          {item.process && (
            <section className="managedProcessDetails">
              <span>进程会话</span>
              <div className="managedProcessPanel">
                <div className="managedProcessMeta">
                  <span className={`managedProcessStatus ${item.process.status}`}>{processStatusLabel(item.process)}</span>
                  {item.process.pid && <code>PID {item.process.pid}</code>}
                  <code title={item.process.id}>{item.process.id.slice(0, 18)}…</code>
                  {item.process.status === "running" && onStopProcess && (
                    <button type="button" onClick={() => void stopProcess()} disabled={isStopping}>
                      {isStopping ? <LoaderCircle size={12} className="toolStatusSpinner" /> : <Square size={11} fill="currentColor" />}
                      {isStopping ? "停止中" : "停止"}
                    </button>
                  )}
                </div>
                <pre className="managedProcessOutput">{item.process.output || "进程正在运行，暂时没有输出。"}</pre>
                {stopError && <div className="managedProcessError">{stopError}</div>}
              </div>
            </section>
          )}
          {item.args && <section><span>输入参数</span><pre>{item.args}</pre></section>}
          {item.result && !item.process && <section><span>执行结果</span><pre>{item.result}</pre></section>}
        </div>
      )}
    </details>
  );
}

export function ToolCallGroup(props: ToolCallGroupProps) {
  const primaryCategory = props.activityGroups[0]?.category ?? (props.isEditGroup ? "edit" : "other");
  const totalCalls = props.activityGroups.reduce((sum, group) => sum + group.items.length, 0);
  const [isOpen, setIsOpen] = useState(props.defaultOpen);
  const bodyId = `${props.groupId}-details`;

  useEffect(() => {
    // Running read/lookup groups open automatically for live feedback, then
    // collapse back to their compact summary as soon as the group completes.
    // A later manual open is preserved because this effect only runs when the
    // parent's desired default state actually changes.
    setIsOpen(props.defaultOpen);
  }, [props.defaultOpen]);

  function toggleOpen() {
    setIsOpen((current) => {
      const next = !current;
      if (!next) props.onClosed(props.groupId);
      return next;
    });
  }

  return (
    <section className={`toolToggle toolExecutionCard ${props.isRunning ? "running" : ""} ${isOpen ? "isOpen" : ""}`}>
      <button
        className="toolToggleSummary"
        type="button"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggleOpen}
      >
        <span className="toolToggleIcon" aria-hidden="true">
          {props.isRunning ? <LoaderCircle size={16} className="toolStatusSpinner" /> : <CategoryIcon category={primaryCategory} size={16} />}
        </span>
        <span className="toolToggleCopy">
          <span className="toolToggleTitleLine">
            <span className="toolToggleText">{props.label}</span>
            <span className="toolCallCount">{totalCalls} 次调用</span>
            {props.activeSkills.length > 0 && (
              <span className="toolSkillBadges" aria-label={`当前调用 Skill：${props.activeSkills.map((skill) => skill.label).join("、")}`}>
                <span className="toolSkillLead"><Puzzle size={11} />Skill</span>
                {props.activeSkills.map((skill) => (
                  <span className={`toolSkillBadge ${skill.name === "auto-learning" ? "background" : ""}`} key={skill.name} title={`$${skill.name}`}>
                    {skill.label}
                  </span>
                ))}
              </span>
            )}
          </span>
          {props.detail && <span className="toolToggleDetail">{props.detail}</span>}
        </span>
        {(props.addedLines > 0 || props.removedLines > 0) && (
          <span
            className={`toolDiffInline ${props.isDiffEstimate ? "isEstimating" : ""}`}
            aria-live="polite"
            title={props.isDiffEstimate ? "实时预估，编辑完成后校准" : "实际代码变更"}
          >
            <span className="toolDiffAdd" key={`add-${props.addedLines}`}>+{props.addedLines}</span>
            <span className="toolDiffRemove" key={`remove-${props.removedLines}`}>-{props.removedLines}</span>
          </span>
        )}
        {props.failedCount > 0 && <span className="toolToggleFail">{props.failedCount} 失败</span>}
        <span className={`toolGroupState ${props.isRunning ? "running" : props.failedCount > 0 ? "fail" : "ok"}`}>
          {props.isRunning ? "执行中" : props.failedCount > 0 ? "需处理" : "已完成"}
        </span>
        <ChevronDown className="toolToggleArrow" size={17} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="toolToggleBody" id={bodyId}>
          {props.activityGroups.map((group) => (
            <section className="toolActivitySection" key={group.category}>
              <div className="toolActivityHeading"><CategoryIcon category={group.category} /><span>{group.title}</span><small>{group.items.length}</small></div>
              <div className="toolActivityTimeline">{group.items.map((item) => <ToolCallItem item={item} key={item.id} onStopProcess={props.onStopProcess} />)}</div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
