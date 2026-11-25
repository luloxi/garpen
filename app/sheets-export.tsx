"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Sheet } from "lucide-react";
import {
  createSheet,
  findSheet,
  friendlyMessage,
  loadGoogleIdentity,
  requestToken,
  SheetsError,
  updateSheet,
  versionTitle,
  type SheetFile,
  type SheetsExportData,
} from "@/lib/sheets/google-sheets";

type Oauth2 = Awaited<ReturnType<typeof loadGoogleIdentity>>;
type Stage =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "working"; label: string }
  | { kind: "choose"; file: SheetFile }
  | { kind: "done"; file: SheetFile; created: boolean }
  | { kind: "error"; message: string };

const APP = "Garpen";

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", cache: "no-store" });
  } catch {
    throw new SheetsError("network");
  }
  if (!res.ok) throw new SheetsError(res.status === 401 ? "auth" : "unknown");
  return (await res.json()) as T;
}

/** "Guardar en Google Sheets": one small dialog, opened from the Perfil menu. */
export default function SheetsExport({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [encrypted, setEncrypted] = useState(false);
  const [hasClient, setHasClient] = useState(false);
  const data = useRef<SheetsExportData | null>(null);
  const oauth2 = useRef<Oauth2 | null>(null);

  useEffect(() => {
    let cancelled = false;
    // For an encrypted account, /api/export/sheets is answered in this browser from the decrypted copy.
    Promise.all([
      getJson<{ clientId: string | null; encrypted: boolean }>("/api/export/sheets-config"),
      getJson<Omit<SheetsExportData, "clientId">>("/api/export/sheets"),
      loadGoogleIdentity(),
    ])
      .then(([config, payload, gis]) => {
        if (cancelled) return;
        data.current = { ...payload, clientId: config.clientId };
        oauth2.current = gis;
        setEncrypted(config.encrypted);
        setHasClient(Boolean(config.clientId));
        if (!config.clientId) setStage({ kind: "error", message: friendlyMessage(new SheetsError("not_configured"), APP) });
        else setStage({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setStage({ kind: "error", message: friendlyMessage(err, APP) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Called straight from a click: the Google popup must open inside the tap. */
  function token(): Promise<string> {
    const d = data.current;
    const g = oauth2.current;
    if (!d?.clientId || !g) return Promise.reject(new SheetsError("not_configured"));
    return requestToken(g, d.clientId, d.loginHint);
  }

  function fail(err: unknown) {
    setStage({ kind: "error", message: friendlyMessage(err, APP) });
  }

  function start() {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Conectando con Google…" });
    pending
      .then(async (t) => {
        const existing = await findSheet(t, APP, d.exportKey);
        if (existing) {
          setStage({ kind: "choose", file: existing });
          return;
        }
        setStage({ kind: "working", label: "Creando tu planilla…" });
        const file = await createSheet(t, d, d.fileTitle);
        setStage({ kind: "done", file, created: true });
      })
      .catch(fail);
  }

  function update(file: SheetFile) {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Actualizando la planilla…" });
    pending
      .then(async (t) => {
        try {
          const saved = await updateSheet(t, file, d);
          setStage({ kind: "done", file: saved, created: false });
        } catch (err) {
          if (err instanceof SheetsError && err.kind === "not_found") {
            const created = await createSheet(t, d, d.fileTitle);
            setStage({ kind: "done", file: created, created: true });
            return;
          }
          throw err;
        }
      })
      .catch(fail);
  }

  function newVersion() {
    const d = data.current;
    if (!d) return;
    const pending = token();
    setStage({ kind: "working", label: "Creando la versión nueva…" });
    pending
      .then(async (t) => {
        const file = await createSheet(t, d, versionTitle(d.fileTitle, new Date()));
        setStage({ kind: "done", file, created: true });
      })
      .catch(fail);
  }

  return (
    <div className="modal-backdrop sheets-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="sheets-modal" role="dialog" aria-modal="true" aria-labelledby="sheets-title">
        <div className="sheets-head">
          <span className="sheets-icon"><Sheet size={20} strokeWidth={1.9} /></span>
          <h2 id="sheets-title">Guardar en Google Sheets</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar">×</button>
        </div>

        {(stage.kind === "loading" || stage.kind === "ready") && (
          <>
            <p className="sheets-text">Una copia de tus datos en una planilla de tu Google Drive. Es solo para mirar: lo que cambies ahí no vuelve a Garpen.</p>
            {encrypted && (
              <p className="sheets-warning" role="note">Tu cuenta está cifrada. La planilla se guarda sin cifrar en tu Google Drive, así que Google y quien tenga acceso a tu Drive van a poder leerla.</p>
            )}
            <button type="button" className="primary-button sheets-wide" disabled={stage.kind === "loading"} onClick={start}>
              {stage.kind === "loading" && <Loader2 size={16} className="sheets-spin" />}
              {encrypted ? "Entendido, guardar" : "Guardar en Google Sheets"}
            </button>
          </>
        )}

        {stage.kind === "working" && (
          <p className="sheets-text sheets-status" role="status"><Loader2 size={16} className="sheets-spin" /> {stage.label}</p>
        )}

        {stage.kind === "choose" && (
          <>
            <p className="sheets-text">Ya tenés <strong>{stage.file.name}</strong>. ¿Qué hacemos?</p>
            <div className="sheets-actions">
              <button type="button" className="primary-button sheets-wide" onClick={() => update(stage.file)}>Actualizar este archivo</button>
              <button type="button" className="secondary-button sheets-wide" onClick={newVersion}>Crear una versión nueva</button>
            </div>
          </>
        )}

        {stage.kind === "done" && (
          <>
            <p className="sheets-text">{stage.created ? "Listo, tu planilla está creada." : "Listo, tu planilla está al día."}</p>
            <a className="primary-button sheets-wide sheets-link" href={stage.file.url} target="_blank" rel="noopener noreferrer">
              Abrir en Google Sheets <ExternalLink size={15} />
            </a>
          </>
        )}

        {stage.kind === "error" && (
          <>
            <p className="sheets-text" role="alert">{stage.message}</p>
            <div className="sheets-actions">
              {hasClient && <button type="button" className="primary-button sheets-wide" onClick={() => setStage({ kind: "ready" })}>Probar de nuevo</button>}
              <button type="button" className="secondary-button sheets-wide" onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
