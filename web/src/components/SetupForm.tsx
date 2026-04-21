import { useState } from "react";
import { useSwarm } from "../state/store";

export function SetupForm() {
  const [repoUrl, setRepoUrl] = useState("https://github.com/sindresorhus/is-odd");
  const [localPath, setLocalPath] = useState("C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs\\is-odd");
  const [agentCount, setAgentCount] = useState(3);
  const [model, setModel] = useState("glm-5.1:cloud");
  const [rounds, setRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const setError = useSwarm((s) => s.setError);
  const reset = useSwarm((s) => s.reset);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    reset();
    try {
      const res = await fetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, localPath, agentCount, model, rounds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.formErrors?.[0] ?? body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto flex items-center justify-center p-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-xl bg-ink-800 border border-ink-700 rounded-lg p-6 space-y-4 shadow-xl"
      >
        <div>
          <h2 className="text-xl font-semibold mb-1">Start a swarm</h2>
          <p className="text-sm text-ink-400">
            Clone a GitHub repo and spawn N OpenCode agents inside it. All agents read the repo and
            discuss what it is and what to do next.
          </p>
        </div>

        <Field label="GitHub URL" hint="Public repo, or private if GITHUB_TOKEN is set in .env">
          <input
            required
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            className="input"
            placeholder="https://github.com/owner/repo"
          />
        </Field>

        <Field label="Local path" hint="Where to clone. Must be empty or a valid existing clone.">
          <input
            required
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            className="input font-mono"
            placeholder="C:\\Users\\you\\projects\\repo"
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Agents">
            <input
              type="number"
              min={1}
              max={8}
              value={agentCount}
              onChange={(e) => setAgentCount(Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field label="Rounds">
            <input
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field label="Model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input font-mono"
            />
          </Field>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-ink-600 disabled:cursor-not-allowed text-white font-medium rounded px-4 py-2 transition"
        >
          {busy ? "Starting…" : "Start swarm"}
        </button>

        <style>{`
          .input {
            width: 100%;
            background: #0b0d10;
            border: 1px solid #2a2f3a;
            border-radius: 6px;
            padding: 8px 10px;
            color: #e5e7eb;
            font-size: 14px;
          }
          .input:focus { outline: none; border-color: #10b981; }
        `}</style>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
      {hint ? <div className="text-xs text-ink-400 mt-1">{hint}</div> : null}
    </label>
  );
}
