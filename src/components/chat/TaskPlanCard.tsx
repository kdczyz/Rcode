import { CheckCircle2, Circle, ListChecks, Play } from "lucide-react";

export interface TaskPlanView {
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

interface TaskPlanCardProps {
  plan: TaskPlanView;
  disabled?: boolean;
  onStart: () => void;
}

export function TaskPlanCard({ plan, disabled, onStart }: TaskPlanCardProps) {
  return (
    <section className="taskPlanCard" aria-label="任务执行计划">
      <header className="taskPlanHeader">
        <span className="taskPlanIcon"><ListChecks size={17} /></span>
        <div>
          <strong>执行计划</strong>
          <small>{plan.steps.length} 个步骤 · 确认后切换到工作区模式</small>
        </div>
        <button type="button" onClick={onStart} disabled={disabled}>
          <Play size={14} fill="currentColor" />
          开始执行
        </button>
      </header>
      {plan.summary && <p className="taskPlanSummary">{plan.summary}</p>}
      <ol className="taskPlanSteps">
        {plan.steps.map((step, index) => (
          <li key={step.id} data-status={step.status}>
            {step.status === "completed" ? <CheckCircle2 size={16} /> : <Circle size={16} />}
            <span><b>{String(index + 1).padStart(2, "0")}</b>{step.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
