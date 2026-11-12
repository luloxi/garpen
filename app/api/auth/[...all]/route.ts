import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";
import { isGoogleSignInPath, requestIsIframe } from "@/lib/sso-login";

async function handlers() {
  return toNextJsHandler(await getAuth());
}

function blockGoogleInIframe(request: Request): Response | null {
  if (!requestIsIframe(request)) return null;
  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!isGoogleSignInPath(pathname)) return null;
  return Response.json({ error: "Google sign-in is not available inside an iframe" }, { status: 400 });
}

export async function GET(request: Request) {
  const blocked = blockGoogleInIframe(request);
  if (blocked) return blocked;
  return (await handlers()).GET(request);
}

export async function POST(request: Request) {
  const blocked = blockGoogleInIframe(request);
  if (blocked) return blocked;
  return (await handlers()).POST(request);
}
