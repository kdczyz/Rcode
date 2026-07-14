import { ArrowRight, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { createContext, FormEvent, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AuthSession, AuthUser, RegistrationDetails, restoreAuthSession, signIn, signOut, signUp } from "./authClient";

interface AuthContextValue {
  user: AuthUser;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthGate");
  return context;
}

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<AuthSession>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void restoreAuthSession().then((restored) => {
      if (active) setSession(restored);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const context = useMemo<AuthContextValue | undefined>(() => session ? ({
    user: session.user,
    logout: async () => {
      await signOut();
      setSession(undefined);
    }
  }) : undefined, [session]);

  if (loading) {
    return (
      <main className="authScreen authLoadingScreen" aria-label="正在验证登录状态">
        <div className="authLoadingMark">RC</div>
        <LoaderCircle className="authSpinner" size={19} />
      </main>
    );
  }

  if (!session || !context) return <AuthEntry onAuthenticated={setSession} />;
  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}

function AuthEntry({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [registration, setRegistration] = useState<RegistrationDetails>({ email: "", username: "", displayName: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = mode === "login"
        ? await signIn({ identifier: identifier.trim(), password })
        : await signUp({ ...registration, email: registration.email.trim(), username: registration.username.trim(), displayName: registration.displayName.trim() });
      onAuthenticated(session);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className="authScreen">
      <section className="authIntro" aria-label="Rcode 账号登录">
        <div className="authBrand"><span>RC</span><strong>Rcode</strong></div>
        <div className="authIntroCopy">
          <p className="authEyebrow">本机工作区 · Cloudflare 账号</p>
          <h1>安全进入你的<br />Agent 工作区。</h1>
          <p>账号与会话由 Cloudflare 边缘服务验证，本机代码和项目文件不会上传。</p>
        </div>
        <div className="authTrustLine"><ShieldCheck size={17} /><span>密码加盐哈希 · 可撤销会话 · 本机安全存储</span></div>
      </section>

      <section className="authFormColumn">
        <form className="authForm" onSubmit={submit}>
          <div className="authFormHeading">
            <LockKeyhole size={19} />
            <div><h2>{mode === "login" ? "登录 Rcode" : "创建账号"}</h2><p>{mode === "login" ? "继续上次的工作" : "建立你的云端身份"}</p></div>
          </div>

          {mode === "login" ? (
            <>
              <label><span>邮箱或用户名</span><input autoFocus autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required /></label>
              <label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            </>
          ) : (
            <div className="authRegisterFields">
              <label><span>显示名称</span><input autoFocus autoComplete="name" value={registration.displayName} onChange={(event) => setRegistration((current) => ({ ...current, displayName: event.target.value }))} required minLength={2} maxLength={50} /></label>
              <label><span>用户名</span><input autoComplete="username" value={registration.username} onChange={(event) => setRegistration((current) => ({ ...current, username: event.target.value }))} required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]+" /></label>
              <label><span>邮箱</span><input type="email" autoComplete="email" value={registration.email} onChange={(event) => setRegistration((current) => ({ ...current, email: event.target.value }))} required /></label>
              <label><span>密码</span><input type="password" autoComplete="new-password" value={registration.password} onChange={(event) => setRegistration((current) => ({ ...current, password: event.target.value }))} required minLength={6} maxLength={128} /><small>至少 6 位，同时包含字母和数字</small></label>
            </div>
          )}

          {error && <div className="authError" role="alert">{error}</div>}
          <button className="authSubmit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="authSpinner" size={17} /> : <ArrowRight size={17} />}
            <span>{busy ? "正在验证" : mode === "login" ? "进入工作区" : "创建并登录"}</span>
          </button>
          <button className="authModeSwitch" type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "还没有账号？创建账号" : "已有账号？返回登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
