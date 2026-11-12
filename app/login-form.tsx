"use client";

import { useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import { APP_ORIGIN, GENKI_ORIGIN, genkiLoginUrl } from "@/lib/sso-login";
import { safeNext } from "@/lib/nav";

function iframeSnapshot(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function subscribeIframe() {
  return () => {};
}

export default function LoginForm({
  framed,
  errorCode,
  next,
}: {
  framed: boolean;
  errorCode?: string;
  next: string;
}) {
  const inFrame = useSyncExternalStore(subscribeIframe, iframeSnapshot, () => framed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(
    errorCode === "oauth"
      ? "No se pudo iniciar sesión con Google. Intentá nuevamente."
      : errorCode === "sso"
        ? "No se pudo usar la sesión de Genki. Iniciá sesión de nuevo."
        : "",
  );

  const returnUrl = `${APP_ORIGIN}${next.startsWith("/") ? next : "/dashboard"}`;
  const genkiHref = genkiLoginUrl(returnUrl);

  async function signIn() {
    if (inFrame) return;
    setLoading(true);
    setError("");
    const callbackURL = safeNext(next, window.location.origin);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL,
      errorCallbackURL: "/login?error=oauth",
    });
    if (result.error) {
      setError("No se pudo iniciar sesión con Google. Intentá nuevamente.");
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <img className="auth-brand-icon" src="/icons/icon-192.v8.png" alt="" width="88" height="88" />
        <h1>Garpen</h1>
        <p className="auth-copy">Tu espacio de trabajo, relaciones y finanzas.</p>
        {inFrame ? (
          <a className="primary-button" href={genkiHref} target="_top" rel="noopener">
            Iniciá sesión en Genki
          </a>
        ) : (
          <button className="primary-button" onClick={() => void signIn()} disabled={loading}>
            {loading ? "Conectando con Google…" : "Continuar con Google"}
          </button>
        )}
        {error && <p className="error-message" role="alert">{error}</p>}
        <p className="auth-footnote">
          {inFrame ? `El acceso se abre en ${GENKI_ORIGIN.replace("https://", "")}.` : "El acceso requiere aprobación del administrador."}
        </p>
      </section>
    </main>
  );
}
