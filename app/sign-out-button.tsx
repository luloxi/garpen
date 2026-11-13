"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { clearE2eSession, getE2eTeardown, isE2eActive, peekUninstall } from "@/lib/e2e/client-session";
import { runSignOut, signOutWarning } from "@/lib/e2e/sign-out";
import { browserPushDeps, removeDevicePush } from "@/lib/push-logout";
import { clearSwrCache } from "@/lib/swr-cache";
import { SIGN_OUT_FAILED_WARNING, leaveToLogin, signOutFailed } from "@/lib/sign-out-redirect";

export default function SignOutButton({ onWarning }: { onWarning?: (message: string) => void }) {
  const [pending, setPending] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  return (
    <>
      <button
        className="secondary-button"
        disabled={pending}
        onClick={() => {
          if (pending) return;
          setPending(true);
          void logout(setWarning, onWarning).finally(() => setPending(false));
        }}
      >
        Cerrar sesión
      </button>
      {warning ? <p className="error-message" role="alert">{warning}</p> : null}
    </>
  );
}

async function logout(setWarning: (warning: string | null) => void, onWarning?: (message: string) => void) {
  clearSwrCache();
  const e2eActive = isE2eActive();
  const uninstallFetch = peekUninstall();
  const teardown = getE2eTeardown();
  let authFailed = false;
  const result = await runSignOut({
    removePush: () => removeDevicePush(browserPushDeps()),
    e2eActive,
    wipeVault: () => teardown.wipeVault(),
    uninstallFetch,
    closeEngine: () => teardown.closeEngine(),
    authSignOut: async () => {
      try { authFailed = signOutFailed(await authClient.signOut()); } catch { authFailed = true; }
    },
  });
  if (authFailed) {
    // The server kept the session: say so, do not pretend the user left.
    setWarning(SIGN_OUT_FAILED_WARNING);
    onWarning?.(SIGN_OUT_FAILED_WARNING);
    return;
  }
  clearE2eSession();
  const message = signOutWarning(result);
  setWarning(message);
  if (message) onWarning?.(message);
  // The session cookie is already cleared; with a device-key warning stay put so it can be read.
  if (!message) leaveToLogin(document, window.location);
}
