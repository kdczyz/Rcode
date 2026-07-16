import {
  MessageSquarePlus,
  Moon,
  PanelLeft,
  Settings,
  Sun
} from "lucide-react";
import { MouseEventHandler } from "react";

interface AppTopBarProps {
  isSettings: boolean;
  title: string;
  modelName: string;
  projectTokenTotal?: number;
  sidebarCollapsed: boolean;
  theme: "light" | "dark";
  onToggleSidebar: () => void;
  onToggleTheme: MouseEventHandler<HTMLButtonElement>;
  onOpenSettings: () => void;
}

export function AppTopBar({
  isSettings,
  title,
  modelName,
  projectTokenTotal,
  sidebarCollapsed,
  theme,
  onToggleSidebar,
  onToggleTheme,
  onOpenSettings
}: AppTopBarProps) {
  return (
    <div className="appTopBar">
      <div className="topBarSidebarZone">
        <div className="appTopBarTrafficSpace" />
        <div className="topBarSidebarActions" aria-label="窗口操作">
          <button className="topBarIconButton" type="button" title={sidebarCollapsed ? "展开项目栏" : "折叠项目栏"} aria-label={sidebarCollapsed ? "展开项目栏" : "折叠项目栏"} aria-pressed={sidebarCollapsed} onClick={onToggleSidebar}>
            <PanelLeft size={16} />
          </button>
          <button className="topBarIconButton themeToggleBtn" type="button" title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} onClick={onToggleTheme}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="topBarIconButton" type="button" title="打开设置" aria-label="打开设置" aria-pressed={isSettings} onClick={onOpenSettings}>
            <Settings size={16} />
          </button>
        </div>
      </div>
      <div className="topBarMainZone">
        <div className="topBarTitle">
          {isSettings ? <Settings size={17} /> : <MessageSquarePlus size={17} />}
          <span>{title}</span>
        </div>
        <div className="topBarSpacer" />
        {projectTokenTotal !== undefined && (
          <div
            className="topBarProjectUsage"
            title={`当前项目历史使用总计 ${projectTokenTotal.toLocaleString("zh-CN")} tokens`}
            aria-label={`当前项目历史使用总计 ${projectTokenTotal.toLocaleString("zh-CN")} tokens`}
          >
            <span>项目累计</span>
            <strong>{projectTokenTotal.toLocaleString("zh-CN")}</strong>
            <span>tokens</span>
          </div>
        )}
        <div className="topBarModelStatus" title={modelName || "未选择模型"}>
          <span className="topBarModelDot" aria-hidden="true" />
          <span>{modelName || "未选择模型"}</span>
        </div>
      </div>
    </div>
  );
}
