import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Logo } from "../components/Icon.tsx";
import { navigate, useRoute } from "../store/route.ts";
import { loadSession, useSession } from "../store/session.ts";

function Frame({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={28} />
          <span>Slipstream</span>
        </div>
        <h1>{title}</h1>
        {lead && <p className="auth-lead">{lead}</p>}
        {children}
      </div>
    </main>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

const enter = async () => {
  await loadSession();
  navigate("/", { replace: true });
};

export function AuthView() {
  const status = useSession((s) => s.status);
  const route = useRoute();
  if (route.name === "join") return <JoinForm invite={route.invite} />;
  return status === "setup" ? <SetupForm /> : <LoginForm />;
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await api.login(email.trim(), password);
    await enter();
  });
  return (
    <Frame title="Sign in" lead="Welcome back.">
      <form className="auth-form" onSubmit={submit}>
        <label className="form-row">
          <span>Email</span>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="form-row">
          <span>Password</span>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-wide" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Frame>
  );
}

function SetupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await api.signup({ name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim() || undefined });
    await enter();
  });
  return (
    <Frame title="Set up your team" lead="Create the owner account for this server.">
      <form className="auth-form" onSubmit={submit}>
        <label className="form-row">
          <span>Your name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
        </label>
        <label className="form-row">
          <span>Email</span>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="form-row">
          <span>Team name</span>
          <input className="field" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Fernpoint" />
        </label>
        <label className="form-row">
          <span>Password</span>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
          <small className="form-hint">At least 10 characters.</small>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-wide" disabled={busy}>
          {busy ? "Creating…" : "Create team"}
        </button>
      </form>
    </Frame>
  );
}

function JoinForm({ invite }: { invite: string }) {
  const [info, setInfo] = useState<{ workspace: string; email: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    api
      .invite(invite)
      .then((i) => {
        setInfo(i);
        if (i.email) setEmail(i.email);
      })
      .catch((err: Error) => setProblem(err.message));
  }, [invite]);

  const { busy, error, submit } = useSubmit(async () => {
    await api.signup({ name: name.trim(), email: email.trim(), password, invite });
    await enter();
  });

  if (problem) {
    return (
      <Frame title="This invite can't be used" lead={problem}>
        <button className="btn" onClick={() => navigate("/login")}>
          Go to sign in
        </button>
      </Frame>
    );
  }
  if (!info) return <Frame title="Checking your invite…">{null}</Frame>;
  return (
    <Frame title={`Join ${info.workspace}`} lead="Create your account to get started.">
      <form className="auth-form" onSubmit={submit}>
        <label className="form-row">
          <span>Your name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
        </label>
        <label className="form-row">
          <span>Email</span>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={Boolean(info.email)} autoComplete="username" required />
        </label>
        <label className="form-row">
          <span>Password</span>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
          <small className="form-hint">At least 10 characters.</small>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-wide" disabled={busy}>
          {busy ? "Joining…" : "Join team"}
        </button>
      </form>
    </Frame>
  );
}

/** Someone already signed in opens an invite link: accept it for their account. */
export function JoinSignedIn({ invite }: { invite: string }) {
  const [info, setInfo] = useState<{ workspace: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit(async () => {
    await api.joinWorkspace(invite);
    await loadSession();
    navigate("/", { replace: true });
  });
  useEffect(() => {
    api
      .invite(invite)
      .then(setInfo)
      .catch((err: Error) => setProblem(err.message));
  }, [invite]);

  if (problem) {
    return (
      <Frame title="This invite can't be used" lead={problem}>
        <button className="btn" onClick={() => navigate("/", { replace: true })}>
          Continue
        </button>
      </Frame>
    );
  }
  if (!info) return <Frame title="Checking your invite…">{null}</Frame>;
  return (
    <Frame title={`Join ${info.workspace}`} lead="You'll be able to share conversations and snippets with the team.">
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-wide" disabled={busy}>
          {busy ? "Joining…" : "Join team"}
        </button>
      </form>
    </Frame>
  );
}
