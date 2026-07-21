import { Archive, ChevronDown, Folder, FolderOpen, HardDrive, MessageSquarePlus, Plus } from "lucide-react";
import { CSSProperties, WheelEvent } from "react";

interface NavigationSession {
  id: string;
  title: string;
  updatedAt: string;
  archivedAt?: string;
}

interface NavigationProject {
  id: string;
  name: string;
  kind: "empty" | "folder" | "temporary";
  path?: string;
  sessions: NavigationSession[];
}

interface ProjectNavigatorProps {
  projects: NavigationProject[];
  activeProjectId?: string;
  activeSessionId?: string;
  collapsedProjects: Record<string, boolean>;
  swipeOffsets: Record<string, number>;
  runningSessionIds: Set<string>;
  archiveThreshold: number;
  onNewSession: () => void;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onTemporarySession: () => void;
  onSelectProject: (projectId: string) => void;
  onToggleProject: (projectId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onArchiveSession: (projectId: string, sessionId: string) => void;
  onResetSwipe: (sessionId: string) => void;
  onSessionWheel: (projectId: string, sessionId: string, event: WheelEvent<HTMLDivElement>) => void;
}

function relativeTime(date: string) {
  const elapsed = Date.now() - new Date(date).getTime();
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))} 分`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 时`;
  if (elapsed < week) return `${Math.floor(elapsed / day)} 天`;
  return `${Math.floor(elapsed / week)} 周`;
}

export function ProjectNavigator(props: ProjectNavigatorProps) {
  return (
    <>
      <div className="projectSidebarHeader">
        <div><span>项目</span><strong>{props.projects.length}</strong></div>
        <button className="iconButton" type="button" onClick={props.onNewSession} aria-label="新会话"><MessageSquarePlus size={16} /></button>
      </div>
      <div className="projectActions" aria-label="项目操作">
        <button type="button" onClick={props.onNewProject}><Plus size={15} />新项目</button>
        <button type="button" onClick={props.onOpenFolder}><FolderOpen size={15} />电脑文件夹</button>
        <button type="button" onClick={props.onTemporarySession}><MessageSquarePlus size={15} />不使用项目</button>
      </div>
      <div className="projectList">
        {props.projects.map((project) => {
          const visibleSessions = project.sessions.filter((session) => !session.archivedAt);
          const isCollapsed = Boolean(props.collapsedProjects[project.id]);
          const listId = `project-session-list-${project.id}`;
          return (
            <section className={`projectGroup ${isCollapsed ? "collapsed" : ""}`} key={project.id}>
              <div className={`projectRow ${project.id === props.activeProjectId ? "active" : ""}`} title={`${project.name}${project.path ? ` · ${project.path}` : project.kind === "temporary" ? " · 临时会话" : " · 空项目"}`}>
                <button className="projectSelectButton" type="button" onClick={() => props.onSelectProject(project.id)}>
                  {project.kind === "folder" ? <Folder size={18} /> : project.kind === "temporary" ? <MessageSquarePlus size={18} /> : <HardDrive size={18} />}
                  <span><strong>{project.name}</strong><small>{project.path ?? (project.kind === "temporary" ? "临时会话" : "空项目")}</small></span>
                </button>
                <button className="projectFoldButton" type="button" aria-label={isCollapsed ? `展开 ${project.name} 的会话` : `收起 ${project.name} 的会话`} aria-controls={listId} aria-expanded={!isCollapsed} onClick={() => props.onToggleProject(project.id)}>
                  <ChevronDown size={15} />
                </button>
              </div>
              <div className="sessionListShell" id={listId} aria-hidden={isCollapsed} inert={isCollapsed ? true : undefined}>
                <div className="sessionList">
                  {visibleSessions.length === 0 && <div className="emptySession">暂无对话</div>}
                  {visibleSessions.map((session) => {
                    const offset = props.swipeOffsets[session.id] ?? 0;
                    const isActive = project.id === props.activeProjectId && session.id === props.activeSessionId;
                    return (
                      <div className={`sessionSwipeRow ${offset > 0 ? "swiping" : ""} ${offset >= props.archiveThreshold ? "ready" : ""}`} key={session.id} onWheel={(event) => props.onSessionWheel(project.id, session.id, event)} style={{ "--session-swipe-offset": `${offset}px` } as CSSProperties}>
                        <button className="sessionArchiveAction" type="button" onClick={() => props.onArchiveSession(project.id, session.id)}><Archive size={14} />归档</button>
                        <button className={`sessionRow ${isActive ? "active" : ""} ${props.runningSessionIds.has(session.id) ? "running" : ""}`} type="button" onClick={() => offset > 0 ? props.onResetSwipe(session.id) : props.onSelectSession(project.id, session.id)} onContextMenu={(event) => { event.preventDefault(); props.onArchiveSession(project.id, session.id); }}>
                          <span className="sessionTitle">{props.runningSessionIds.has(session.id) && <span className="sessionRunningDot" aria-hidden="true" />}<span className="sessionTitleText">{session.title}</span></span>
                          <time>{relativeTime(session.updatedAt)}</time>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
