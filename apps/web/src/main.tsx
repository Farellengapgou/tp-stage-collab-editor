import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeDocument, type CollaborationState } from "./collaboration";
import { addDocumentEditor, createDocument, diagnosticPdf, downloadPublication, getCurrentEditor, getDocument, getHistory, getPublication, getRevision, identify, listDocumentEditors, listDocuments, listPublications, lookupEditor, publishDocument, restoreRevision } from "./api";
import { ApiError, type DocumentEditor, type DocumentSummary, type Editor, type HistoryEntry, type Publication } from "./types";
import "./styles.css";

const message = (e: unknown) => e instanceof Error ? e.message : "Une erreur est survenue.";
const route = () => location.hash.slice(1) || "/documents";
const go = (value: string) => { location.hash = value; };

function Header({ editor }: { editor: Editor }) { return <header className="site-header"><button className="brand" onClick={() => go("/documents")}>Collab Editor</button><nav><button className="journal-link" onClick={() => go("/journal")}>Journal</button></nav><div className="editor-identity"><strong>{editor.displayName}</strong><span>{editor.email}</span></div></header>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><h2>{title}</h2><button onClick={close}>×</button></div>{children}</section></div>; }

function Login({ done }: { done: (editor: Editor) => void }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [error, setError] = useState("");
  async function submit(e: FormEvent) { e.preventDefault(); try { done(await identify(name, email)); go("/documents"); } catch (reason) { setError(message(reason)); } }
  return <main className="authentication-page"><section className="authentication-card"><p className="eyebrow">Journal collaboratif</p><h1>Bienvenue</h1><form onSubmit={submit}><label>Nom affiché<input value={name} onChange={e => setName(e.target.value)} required /></label><label>E-mail<input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button">Accéder à mes documents</button></form></section></main>;
}

function Dashboard({ editor }: { editor: Editor }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]); const [modal, setModal] = useState(false); const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void listDocuments().then(setDocuments).catch(e => setError(message(e))); }, []);
  async function submit(e: FormEvent) { e.preventDefault(); try { const doc = await createDocument(title, description); go(`/documents/${doc.id}`); } catch (reason) { setError(message(reason)); } }
  return <><Header editor={editor}/><main className="page-shell"><section className="page-heading"><div><p className="eyebrow">Espace de rédaction</p><h1>Mes documents</h1></div><button className="primary-button" onClick={() => setModal(true)}>Nouveau document</button></section>{error && <p className="form-error">{error}</p>}<div className="document-list">{documents.length === 0 && <p className="empty-state">Aucun document accessible.</p>}{documents.map(doc => <button className="document-card" key={doc.id} onClick={() => go(`/documents/${doc.id}`)}><strong>{doc.title}</strong>{doc.description && <span>{doc.description}</span>}<small>{doc.role === "owner" ? "Propriétaire" : "Rédacteur"} · Révision {doc.currentRevision}</small></button>)}</div></main>{modal && <Modal title="Nouveau document" close={() => setModal(false)}><form onSubmit={submit}><label>Titre<input value={title} onChange={e => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} onChange={e => setDescription(e.target.value)}/></label><button className="primary-button">Créer</button></form></Modal>}</>;
}

function Share({ id, close, refresh }: { id: string; close: () => void; refresh: () => void }) {
  const [email, setEmail] = useState(""); const [error, setError] = useState("");
  async function submit(e: FormEvent) { e.preventDefault(); try { const target = await lookupEditor(email); await addDocumentEditor(id, target.id); refresh(); close(); } catch (reason) { setError(message(reason)); } }
  return <Modal title="Partager" close={close}><form onSubmit={submit}><label>E-mail du rédacteur existant<input type="email" value={email} onChange={e => setEmail(e.target.value)} required/></label>{error && <p className="form-error">{error}</p>}<button className="primary-button">Ajouter</button></form></Modal>;
}

function History({ id, revision, owner, close, refresh }: { id: string; revision: number; owner: boolean; close: () => void; refresh: () => void }) {
  const [items, setItems] = useState<HistoryEntry[]>([]); const [selected, setSelected] = useState<number>(); const [content, setContent] = useState(""); const [error, setError] = useState("");
  useEffect(() => { void getHistory(id).then(setItems).catch(e => setError(message(e))); }, [id]);
  async function inspect(value: number) { setSelected(value); try { setContent((await getRevision(id, value)).content); } catch (e) { setError(message(e)); } }
  async function restore() { if (selected === undefined) return; try { await restoreRevision(id, selected, revision); refresh(); close(); } catch (e) { setError(message(e)); } }
  return <Modal title="Historique" close={close}>{error && <p className="form-error">{error}</p>}<div className="history-layout"><div className="history-list">{items.map(item => <button key={item.revision} onClick={() => void inspect(item.revision)}>Révision {item.revision}<small>{item.author?.displayName ?? "Création"}</small></button>)}</div><div><pre className="revision-preview">{content || "Sélectionnez une révision."}</pre>{owner && selected !== undefined && selected !== revision && <button className="primary-button" onClick={() => void restore()}>Restaurer</button>}</div></div></Modal>;
}

const avatarColors = ["#9b3f6d", "#315d9b", "#16706b", "#9b621e", "#66479b", "#ad4251"];
function colorFor(editorId: string) { return avatarColors[Array.from(editorId).reduce((hash, value) => (hash * 31 + value.charCodeAt(0)) >>> 0, 0) % avatarColors.length]; }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase(); }

function PresenceAvatars({ editor, presences, members, connected: isConnected }: { editor: Editor; presences: CollaborationState["remotePresences"]; members: DocumentEditor[]; connected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const connected = isConnected
    ? [...new Set([editor.id, ...Object.values(presences).map(presence => presence.editorId).filter((id): id is string => Boolean(id))])]
      .map(id => id === editor.id ? editor : members.find(member => member.id === id))
      .filter((member): member is Editor | DocumentEditor => Boolean(member))
    : [];
  if (connected.length === 0) return null;
  const visible = connected.slice(0, 4);
  return <div className="presence-avatars"><div className="avatar-row">{visible.map(member => <span key={member.id} className="avatar" style={{ backgroundColor: colorFor(member.id) }} title={member.displayName} aria-label={member.displayName}>{initials(member.displayName)}</span>)}{connected.length > 4 && <button className="avatar more-avatar" aria-label={`${connected.length - 4} rédacteurs supplémentaires`} onClick={() => setExpanded(value => !value)}>+{connected.length - 4}</button>}</div>{expanded && <div className="presence-popover">{connected.map(member => <div key={member.id}><span className="avatar avatar-small" style={{ backgroundColor: colorFor(member.id) }}>{initials(member.displayName)}</span>{member.displayName}</div>)}</div>}</div>;
}

function PublicationModal({ id, close }: { id: string; close: () => void }) {
  const [quota, setQuota] = useState("10"); const [error, setError] = useState(""); const [saving, setSaving] = useState(false); const [publication, setPublication] = useState<Publication>();
  async function submit(event: FormEvent) { event.preventDefault(); const maxDownloads = Number(quota); if (!Number.isInteger(maxDownloads) || maxDownloads <= 0) return setError("Le quota doit être un entier positif."); setSaving(true); setError(""); try { const result = await publishDocument(id, maxDownloads); if (!result.publication) return setError(result.status === "preparing" ? "Préparation du PDF en cours. Réessayez dans un instant." : "La préparation du PDF a échoué."); setPublication(result.publication); } catch (reason) { setError(message(reason)); } finally { setSaving(false); } }
  return <Modal title="Publier l’article" close={close}>{publication ? <><p>Publication créée à la révision {publication.revision}.</p><label>Lien public<input readOnly value={`${location.origin}${location.pathname}#/journal/${publication.publicToken}`} /></label><button className="primary-button" onClick={close}>Fermer</button></> : <form onSubmit={submit}><label>Quota de téléchargements<input type="number" min="1" step="1" value={quota} onChange={event => setQuota(event.target.value)} required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={saving}>{saving ? "Publication…" : "Générer et publier"}</button></form>}</Modal>;
}

function openDownload(publication: Publication, setError: (value: string) => void) {
  void downloadPublication(publication.publicToken).then(blob => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${publication.title || "article"}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }).catch(reason => setError(message(reason)));
}

function Journal({ token }: { token?: string }) {
  const [items, setItems] = useState<Publication[]>([]); const [publication, setPublication] = useState<Publication>(); const [error, setError] = useState("");
  useEffect(() => { void (token ? getPublication(token).then(setPublication) : listPublications().then(setItems)).catch(reason => setError(message(reason))); }, [token]);
  const render = (item: Publication) => <article className="publication-card" key={item.publicToken}><h2>{item.title}</h2><p>Par {item.author} · {new Date(item.publishedAt).toLocaleDateString("fr-FR")}</p><p>{item.consumedDownloads}/{item.maxDownloads} téléchargements consommés</p><div className="actions"><button onClick={() => go(`/journal/${item.publicToken}`)}>Voir l’article</button><button className="primary-button" disabled={item.consumedDownloads + item.activeReservations >= item.maxDownloads} onClick={() => openDownload(item, setError)}>{item.consumedDownloads + item.activeReservations >= item.maxDownloads ? "Quota atteint" : "Télécharger PDF"}</button></div></article>;
  return <main className="page-shell journal-page"><button className="brand" onClick={() => go("/documents")}>Collab Editor</button><section className="page-heading"><div><p className="eyebrow">Journal</p><h1>{token ? publication?.title ?? "Article" : "Articles publiés"}</h1></div></section>{error && <p className="form-error">{error}</p>}{token ? publication && render(publication) : <div className="document-list">{items.map(render)}{items.length === 0 && <p className="empty-state">Aucun article publié.</p>}</div>}</main>;
}

function PdfDiagnostic() {
  const [result, setResult] = useState("Prêt"); const [publication, setPublication] = useState<Publication>();
  async function download(path: string, label: string, options?: RequestInit) { setResult("Chargement…"); try { const response = await diagnosticPdf(path, options); const url = URL.createObjectURL(response.blob); const link = document.createElement("a"); link.href = url; link.download = `${label}.pdf`; link.click(); setResult(`Succès — HTTP ${response.status}, ${response.contentType}, ${response.blob.size} octets`); setTimeout(() => URL.revokeObjectURL(url), 60_000); } catch (error) { const apiError = error as ApiError; setResult(`Échec — HTTP ${apiError.status ?? "?"}, ${apiError.message}`); } }
  async function published() { setResult("Création de la publication…"); try { const response = await fetch("/api/diagnostic/pdf/published", { method: "POST", credentials: "include" }); const body = await response.json(); if (!response.ok) throw new ApiError(body.error ?? "Erreur", response.status); setPublication(body.publication); await download(`/downloads/${body.publication.publicToken}`, "pdf-publie", { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }); } catch (error) { const apiError = error as ApiError; setResult(`Échec — HTTP ${apiError.status ?? "?"}, ${apiError.message}`); } }
  return <main className="page-shell"><h1>Diagnostic PDF</h1><p>{result}</p><div className="actions"><button onClick={() => void download("/diagnostic/pdf/static", "pdf-statique")}>Télécharger PDF statique</button><button onClick={() => void download("/diagnostic/pdf/generated", "pdf-genere")}>Télécharger PDF généré</button><button className="primary-button" onClick={() => void published()}>Télécharger PDF publié</button></div>{publication && <p>Token : {publication.publicToken} · consommé : {publication.consumedDownloads} · restant : {publication.maxDownloads - publication.consumedDownloads - publication.activeReservations}</p>}</main>;
}

function EditorMirror({ content, presences, members }: { content: string; presences: CollaborationState["remotePresences"]; members: DocumentEditor[] }) {
  const cursors = new Map<number, { id: string; name: string }[]>();
  for (const presence of Object.values(presences)) {
    if (typeof presence.selection?.focus !== "number") continue;
    const member = members.find(member => member.id === presence.editorId);
    const name = member?.displayName ?? "Collaborateur";
    const id = member?.id ?? presence.editorId ?? name;
    const at = Math.max(0, Math.min(Array.from(content).length, presence.selection.focus));
    cursors.set(at, [...(cursors.get(at) ?? []), { id, name }]);
  }
  const characters = Array.from(content);
  return <pre className="editor-mirror" aria-hidden="true">{characters.map((character, index) => <Fragment key={index}>{cursors.get(index)?.map(cursor => <span key={cursor.id} className="remote-cursor" style={{ borderColor: colorFor(cursor.id), color: colorFor(cursor.id) }} data-editor={cursor.name} title={`${cursor.name} écrit ici`} />)}{character}</Fragment>)}{cursors.get(characters.length)?.map(cursor => <span key={cursor.id} className="remote-cursor" style={{ borderColor: colorFor(cursor.id), color: colorFor(cursor.id) }} data-editor={cursor.name} title={`${cursor.name} écrit ici`} />)}{"\n"}</pre>;
}

function DocumentPage({ editor, id }: { editor: Editor; id: string }) {
  const [doc, setDoc] = useState<DocumentSummary>(); const [members, setMembers] = useState<DocumentEditor[]>([]); const [share, setShare] = useState(false); const [history, setHistory] = useState(false); const [publish, setPublish] = useState(false); const [error, setError] = useState(""); const [state, setState] = useState<CollaborationState>({ content: "", revision: 0, connected: false, synchronizing: true, saving: false, remotePresences: {} }); const client = useRef<CollaborativeDocument | null>(null); const area = useRef<HTMLTextAreaElement>(null);
  const refresh = () => { void Promise.all([getDocument(id), listDocumentEditors(id)]).then(([document, list]) => { setDoc(document); setMembers(list); }).catch(e => setError(message(e))); };
  useEffect(() => { refresh(); const instance = new CollaborativeDocument(id, setState, setError); client.current = instance; instance.start(); return () => instance.stop(); }, [id]);
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = "auto"; node.style.height = `${Math.max(420, node.scrollHeight)}px`; }, [state.content]);
  function selection() { const node = area.current; if (node) client.current?.updateSelection(node.value, node.selectionStart, node.selectionEnd); }
  function change() { const node = area.current; const value = node?.value ?? ""; if (node) client.current?.updateSelection(value, node.selectionStart, node.selectionEnd); client.current?.submitChange(value); }
  const typingEditors = [...new Set(Object.values(state.remotePresences).filter((presence): presence is { editorId?: string; typing: true } => Boolean(presence?.typing)).map(presence => members.find(member => member.id === presence.editorId)?.displayName ?? "Collaborateur"))];
  if (!doc) return <><Header editor={editor}/><main className="page-shell">Chargement… {error && <p className="form-error">{error}</p>}</main></>;
  return <><Header editor={editor}/><main className="page-shell document-page"><button className="back-link" onClick={() => go("/documents")}>← Documents</button><section className="workspace"><div className="workspace-heading"><div><p className="eyebrow">Document partagé</p><h1>{doc.title}</h1>{doc.description && <p>{doc.description}</p>}</div><div className="workspace-tools"><PresenceAvatars editor={editor} presences={state.remotePresences} members={members} connected={state.connected}/><div className="actions">{doc.role === "owner" && <button onClick={() => setShare(true)}>Partager</button>}{doc.role === "owner" && <button disabled={state.saving || state.synchronizing} onClick={() => setPublish(true)}>Publier l’article</button>}<button onClick={() => setHistory(true)}>Historique</button></div></div></div><div className="connection"><span>{state.connected ? state.saving ? "Enregistrement…" : "Enregistré" : state.synchronizing ? "Synchronisation…" : "Reconnexion…"}</span><span>Révision {state.revision}</span>{typingEditors.length > 0 && <span className="typing-indicator">{typingEditors.join(", ")} {typingEditors.length > 1 ? "écrivent…" : "écrit…"}</span>}</div>{error && <p className="form-error">{error}</p>}<div className="editor-shell"><EditorMirror content={state.content} presences={state.remotePresences} members={members}/><textarea ref={area} className="editor editor-input" value={state.content} onChange={change} onSelect={selection} onKeyUp={selection} onFocus={selection} onBlur={() => client.current?.blur()} disabled={!state.connected || state.synchronizing} placeholder={state.synchronizing ? "Synchronisation du document…" : "Commencez à écrire…"}/></div></section></main>{share && <Share id={id} close={() => setShare(false)} refresh={refresh}/>} {history && <History id={id} revision={state.revision} owner={doc.role === "owner"} close={() => setHistory(false)} refresh={refresh}/>} {publish && <PublicationModal id={id} close={() => setPublish(false)}/>}</>;
}

function App() { const [editor, setEditor] = useState<Editor | null>(null); const [ready, setReady] = useState(false); const [current, setCurrent] = useState(route()); useEffect(() => { const update = () => setCurrent(route()); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); }, []); useEffect(() => { void getCurrentEditor().then(setEditor).catch(() => setEditor(null)).finally(() => setReady(true)); }, []); if (location.hostname === "127.0.0.1" && current === "/diagnostic/pdf") return <PdfDiagnostic/>; const journal = current.match(/^\/journal(?:\/([^/]+))?$/); if (journal) return <Journal token={journal[1]}/>; if (!ready) return <main className="authentication-page">Vérification de la session…</main>; if (!editor) return <Login done={setEditor}/>; const match = current.match(/^\/documents\/([0-9a-f-]{36})$/i); return match ? <DocumentPage editor={editor} id={match[1]}/> : <Dashboard editor={editor}/>; }
createRoot(document.getElementById("root")!).render(<App/>);
