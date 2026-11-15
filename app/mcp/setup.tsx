"use client";

import { useState } from "react";

export function McpSetup({ email }: { email: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/token", { method: "POST", credentials: "include" });
      const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !data?.token) {
        setError(data?.error || `Error ${res.status}`);
        return;
      }
      setToken(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <p style={{ color: "#555" }}>Sesión: {email}</p>
      <button type="button" onClick={() => void mint()} disabled={busy} style={{ marginTop: "0.75rem", padding: "0.5rem 0.9rem", cursor: "pointer" }}>
        {busy ? "Generando…" : "Generar token"}
      </button>
      {error ? <p style={{ color: "#b00020", marginTop: "0.75rem" }}>{error}</p> : null}
      {token ? (
        <p style={{ marginTop: "1rem" }}>
          Copiá este token ahora; no se vuelve a mostrar.
          <textarea readOnly value={token} rows={4} style={{ width: "100%", marginTop: "0.5rem", fontFamily: "ui-monospace, monospace" }} />
        </p>
      ) : null}
    </section>
  );
}
