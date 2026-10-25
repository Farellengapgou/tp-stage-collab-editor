import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeDocument, type CollaborationState } from "./collaboration";
import { addDocumentEditor, createDocument, getCurrentEditor, getDocument, getHistory, getRevision, identify, listDocumentEditors, listDocuments, lookupEditor, restoreRevision } from "./api";
import { type DocumentEditor, type DocumentSummary, type Editor, type HistoryEntry } from "./types";
import "./styles.css";

const message = (e: unknown) => e instanceof Error ? e.message : "Une erreur est survenue.";
const route = () => location.hash.slice(1) || "/documents";
const go = (value: string) => { location.hash = value; };

function Header({ editor }: { editor: Editor }) { return <header className="site-header"><button className="brand" onClick={() => go("/documents")}>Collab Editor</button><div className="editor-identity"><strong>{editor.displayName}</strong><span>{editor.email}</span></div></header>; }
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

function EditorMirror({ content, presences, members }: { content: string; presences: CollaborationState["remotePresences"]; members: DocumentEditor[] }) {
  const cursors = new Map<number, string[]>();
  for (const presence of Object.values(presences)) {
    if (typeof presence.selection?.focus !== "number") continue;
    const name = members.find(member => member.id === presence.editorId)?.displayName ?? "Collaborateur";
    const at = Math.max(0, Math.min(Array.from(content).length, presence.selection.focus));
    cursors.set(at, [...(cursors.get(at) ?? []), name]);
  }
  const characters = Array.from(content);
  return <pre className="editor-mirror" aria-hidden="true">{characters.map((character, index) => <Fragment key={index}>{cursors.get(index)?.map(name => <span key={name} className="remote-cursor" title={`${name} écrit ici`} />)}{character}</Fragment>)}{cursors.get(characters.length)?.map(name => <span key={name} className="remote-cursor" title={`${name} écrit ici`} />)}{"\n"}</pre>;
}

function DocumentPage({ editor, id }: { editor: Editor; id: string }) {
  const [doc, setDoc] = useState<DocumentSummary>(); const [members, setMembers] = useState<DocumentEditor[]>([]); const [share, setShare] = useState(false); const [history, setHistory] = useState(false); const [error, setError] = useState(""); const [state, setState] = useState<CollaborationState>({ content: "", revision: 0, connected: false, synchronizing: true, saving: false, remotePresences: {} }); const client = useRef<CollaborativeDocument | null>(null); const area = useRef<HTMLTextAreaElement>(null);
  const refresh = () => { void Promise.all([getDocument(id), listDocumentEditors(id)]).then(([document, list]) => { setDoc(document); setMembers(list); }).catch(e => setError(message(e))); };
  useEffect(() => { refresh(); const instance = new CollaborativeDocument(id, setState, setError); client.current = instance; instance.start(); return () => instance.stop(); }, [id]);
  function change() { const value = area.current?.value ?? ""; client.current?.submitChange(value); setState(current => ({ ...current, content: value })); }
  function selection() { const node = area.current; if (node) client.current?.updateSelection(state.content, node.selectionStart, node.selectionEnd); }
  const cursors = Object.values(state.remotePresences).map(p => `${members.find(m => m.id === p.editorId)?.displayName ?? "Collaborateur"} (${p.selection?.focus ?? 0})`);
  if (!doc) return <><Header editor={editor}/><main className="page-shell">Chargement… {error && <p className="form-error">{error}</p>}</main></>;
  return <><Header editor={editor}/><main className="page-shell document-page"><button className="back-link" onClick={() => go("/documents")}>← Documents</button><section className="workspace"><div className="workspace-heading"><div><p className="eyebrow">Document partagé</p><h1>{doc.title}</h1>{doc.description && <p>{doc.description}</p>}</div><div className="actions">{doc.role === "owner" && <button onClick={() => setShare(true)}>Partager</button>}<button onClick={() => setHistory(true)}>Historique</button></div></div><div className="connection"><span>{state.connected ? state.saving ? "Enregistrement…" : "Enregistré" : state.synchronizing ? "Synchronisation…" : "Reconnexion…"}</span><span>Révision {state.revision}</span><span>{cursors.length ? `Curseurs : ${cursors.join(", ")}` : "Aucun autre rédacteur connecté"}</span></div>{error && <p className="form-error">{error}</p>}<div className="editor-shell"><EditorMirror content={state.content} presences={state.remotePresences} members={members}/><textarea ref={area} className="editor editor-input" value={state.content} onChange={change} onSelect={selection} onKeyUp={selection} disabled={!state.connected || state.synchronizing} placeholder={state.synchronizing ? "Synchronisation du document…" : "Commencez à écrire…"}/></div></section></main>{share && <Share id={id} close={() => setShare(false)} refresh={refresh}/>} {history && <History id={id} revision={state.revision} owner={doc.role === "owner"} close={() => setHistory(false)} refresh={refresh}/>}</>;
}

function App() { const [editor, setEditor] = useState<Editor | null>(null); const [ready, setReady] = useState(false); const [current, setCurrent] = useState(route()); useEffect(() => { const update = () => setCurrent(route()); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); }, []); useEffect(() => { void getCurrentEditor().then(setEditor).catch(() => setEditor(null)).finally(() => setReady(true)); }, []); if (!ready) return <main className="authentication-page">Vérification de la session…</main>; if (!editor) return <Login done={setEditor}/>; const match = current.match(/^\/documents\/([0-9a-f-]{36})$/i); return match ? <DocumentPage editor={editor} id={match[1]}/> : <Dashboard editor={editor}/>; }
createRoot(document.getElementById("root")!).render(<App/>);
