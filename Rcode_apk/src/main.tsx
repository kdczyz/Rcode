import { Component, ErrorInfo, ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Rcode mobile render failure", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="recoveryScreen">
          <div className="splashMark">RC</div>
          <h1>页面暂时无法显示</h1>
          <p>会话和任务仍安全保留，重新载入即可继续。</p>
          <button onClick={() => window.location.reload()}>重新载入</button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>
);
