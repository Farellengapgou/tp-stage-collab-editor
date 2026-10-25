import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, type DocumentSummary, type Editor } from "./types";
import { createDocument, getCurrentEditor, getDocument, identify, listDocuments } from "./api";
import "./styles.css";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Une erreur est survenue.";
}

function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Header({ editor }: { editor: Editor }) {
  return (
    <header className="site-header">
      <button className="brand" type="button" onClick={() => navigate("/documents")}>Collab Editor</button>
      <div className="editor-identity">
        <strong>{editor.displayName}</strong>
        <span>{editor.email}</span>
      </div>
    </header>
  );
}

function Identification({ onIdentified }: { onIdentified: (editor: Editor) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      onIdentified(await identify(displayName, email));
      navigate("/documents");
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="authentication-page">
      <section className="authentication-card" aria-labelledby="identification-title">
        <p className="eyebrow">Journal collaboratif</p>
        <h1 id="identification-title">Bienvenue</h1>
        <p>Indiquez votre identité pour accéder à vos documents partagés.</p>
        <form onSubmit={submit}>
          <label htmlFor="display-name">Nom affiché</label>
          <input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={255} required autoComplete="name" />
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} required autoComplete="email" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? "Connexion…" : "Accéder à mes documents"}
          </button>
        </form>
      </section>
    </main>
  );
}

function DocumentsPage({ editor }: { editor: Editor }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void listDocuments()
      .then(setDocuments)
      .catch((requestError) => setError(messageFor(requestError)))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const document = await createDocument(title, description);
      navigate(`/documents/${document.id}`);
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Header editor={editor} />
      <main className="page-shell">
        <section className="page-heading">
          <div>
            <p className="eyebrow">Espace de rédaction</p>
            <h1>Mes documents</h1>
          </div>
          <p>Créez un document ou reprenez une rédaction partagée.</p>
        </section>
        <section className="documents-layout">
          <section aria-labelledby="documents-title">
            <h2 id="documents-title">Documents accessibles</h2>
            {loading && <p className="status-message">Chargement des documents…</p>}
            {!loading && error && <p className="form-error" role="alert">{error}</p>}
            {!loading && !error && documents.length === 0 && <p className="empty-state">Aucun document accessible pour le moment.</p>}
            <div className="document-list">
              {documents.map((document) => (
                <button className="document-card" type="button" key={document.id} onClick={() => navigate(`/documents/${document.id}`)}>
                  <span className="document-card-title">{document.title}</span>
                  {document.description && <span className="document-card-description">{document.description}</span>}
                  <span className="document-card-meta">{document.role === "owner" ? "Propriétaire" : "Rédacteur"} · Révision {document.currentRevision}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="creation-card" aria-labelledby="new-document-title">
            <h2 id="new-document-title">Nouveau document</h2>
            <form onSubmit={submit}>
              <label htmlFor="document-title">Titre</label>
              <input id="document-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} required />
              <label htmlFor="document-description">Description <span className="optional">facultative</span></label>
              <textarea id="document-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10_000} rows={4} />
              {error && !loading && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" disabled={submitting} type="submit">
                {submitting ? "Création…" : "Créer le document"}
              </button>
            </form>
          </section>
        </section>
      </main>
    </>
  );
}

function DocumentPage({ editor, documentId }: { editor: Editor; documentId: string }) {
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void getDocument(documentId)
      .then(setDocument)
      .catch((requestError) => setError(messageFor(requestError)));
  }, [documentId]);

  return (
    <>
      <Header editor={editor} />
      <main className="page-shell document-page">
        <button className="back-link" type="button" onClick={() => navigate("/documents")}>← Retour aux documents</button>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!document && !error && <p className="status-message">Chargement du document…</p>}
        {document && (
          <section className="document-workspace">
            <div>
              <p className="eyebrow">Document partagé</p>
              <h1>{document.title}</h1>
              {document.description && <p className="document-description">{document.description}</p>}
            </div>
            <div className="document-facts">
              <span>{document.role === "owner" ? "Propriétaire" : "Rédacteur"}</span>
              <span>Révision {document.currentRevision}</span>
            </div>
            <section className="editor-placeholder" aria-label="Éditeur bientôt disponible">
              <h2>Espace de rédaction</h2>
              <p>L’édition collaborative sera activée à l’étape suivante.</p>
            </section>
          </section>
        )}
      </main>
    </>
  );
}

function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    void getCurrentEditor()
      .then(setEditor)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.status !== 401) {
          setEditor(null);
        }
      })
      .finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) {
    return <main className="authentication-page"><p className="status-message">Vérification de votre session…</p></main>;
  }
  if (!editor) {
    return <Identification onIdentified={setEditor} />;
  }

  const documentMatch = path.match(/^\/documents\/([0-9a-f-]{36})$/i);
  if (documentMatch) {
    return <DocumentPage editor={editor} documentId={documentMatch[1]} />;
  }
  return <DocumentsPage editor={editor} />;
}

createRoot(document.getElementById("root")!).render(<App />);
