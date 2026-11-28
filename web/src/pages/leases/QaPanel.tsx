import { AlertTriangle, BookOpenText, CircleHelp, LoaderCircle, MessageSquareText, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiRequestError } from "../../api/client";
import { leasesApi, type QaAnswer, type QaCitation, type QaMessage } from "../../api/leases";
import { Alert } from "../../components/ui";

const SUGGESTIONS = [
  "What is the monthly rent?",
  "What is the security deposit?",
  "How many days' notice must the tenant give?",
  "Does the agreement allow pets?",
  "Who is responsible for plumbing repairs?",
  "What happens if rent is paid late?",
  "Is there a clause regarding early termination?",
  "When does this lease expire?",
];

const MAX_LENGTH = 500;

function citationLabel(c: QaCitation): string {
  return [c.doc_name, `Page ${c.page}`, c.section_ref].filter(Boolean).join(" · ");
}

function Answer({ answer, onCite, isPdf }: { answer: QaAnswer; onCite: (c: QaCitation) => void; isPdf: boolean }) {
  if (answer.status === "not_found") {
    return (
      <div className="qa-answer qa-not-found">
        <CircleHelp size={15} aria-hidden /> {answer.text}
      </div>
    );
  }
  return (
    <div className={`qa-answer${answer.status === "conflict" ? " qa-conflict" : ""}`}>
      {answer.status === "conflict" && (
        <div className="qa-conflict-label">
          <AlertTriangle size={14} aria-hidden /> The agreement is inconsistent on this point. Both places are cited below.
        </div>
      )}
      {answer.statements.map((s, i) => (
        <div key={i} className="qa-statement">
          <p>
            {s.kind === "interpretation" && (
              <span className="badge badge-warning" title="A cautious reading of the cited text, not something the agreement states directly">
                Interpretation
              </span>
            )}{" "}
            {s.text}
          </p>
          <ul className="qa-citations">
            {s.citations.map((c, j) => (
              <li key={j}>
                <button className="link-btn" onClick={() => onCite(c)} title="Show this passage in the source document">
                  <BookOpenText size={13} aria-hidden /> Source: {citationLabel(c)}
                </button>
                {isPdf && c.document_id !== null && (
                  <>
                    {" · "}
                    <a href={`/api/documents/${c.document_id}/file#page=${c.page}`} target="_blank" rel="noreferrer" className="small">
                      open original
                    </a>
                  </>
                )}
                <blockquote>“{c.quote}”</blockquote>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {answer.notice && <div className="qa-notice">{answer.notice}</div>}
    </div>
  );
}

/**
 * Ask questions about this agreement. Answers come only from the lease's own text, every statement cites
 * the page and passage it relies on, and anything the server cannot verify is answered as "not found".
 */
export function QaPanel({ leaseId, isPdf, onCite }: { leaseId: number; isPdf: boolean; onCite: (c: QaCitation) => void }) {
  const [messages, setMessages] = useState<QaMessage[] | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    leasesApi.qa
      .list(leaseId)
      .then(setMessages)
      .catch((e) => {
        setMessages([]);
        setError(e instanceof ApiRequestError ? e.message : "Could not load the conversation");
      });
  }, [leaseId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || pending) return;
    setPending(text);
    setError(null);
    setQuestion("");
    try {
      setMessages(await leasesApi.qa.ask(leaseId, text));
    } catch (e) {
      setQuestion(text);
      setError(e instanceof ApiRequestError ? e.message : "The question could not be answered");
    } finally {
      setPending(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(question);
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    try {
      await leasesApi.qa.clear(leaseId);
      setMessages([]);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not clear the conversation");
    }
  };

  return (
    <div className="qa-panel">
      <div className="qa-intro muted small">
        Answers use only this agreement's text and cite the page and passage they rely on. They are not legal advice.
      </div>

      <div className="qa-messages" aria-live="polite">
        {messages === null ? (
          <div className="spinner" aria-label="Loading" />
        ) : messages.length === 0 && !pending ? (
          <div className="qa-empty">
            <MessageSquareText size={22} strokeWidth={1.6} aria-hidden />
            <div className="small">Try one of these:</div>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === "user" ? (
              <div key={m.message_id} className="qa-question">
                {m.content}
              </div>
            ) : m.answer ? (
              <Answer key={m.message_id} answer={m.answer} onCite={onCite} isPdf={isPdf} />
            ) : null,
          )
        )}
        {pending && (
          <>
            <div className="qa-question">{pending}</div>
            <div className="qa-answer qa-loading">
              <LoaderCircle size={14} className="spin" aria-hidden /> Searching the agreement…
            </div>
          </>
        )}
        <div ref={endRef} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <form className="qa-form" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={onKey}
          placeholder="Ask about this agreement…"
          rows={2}
          maxLength={MAX_LENGTH}
          disabled={pending !== null}
          aria-label="Question about this agreement"
        />
        <div className="qa-form-actions">
          {confirmClear ? (
            <span className="small">
              Clear your conversation?{" "}
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void clear()}>
                Clear
              </button>{" "}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmClear(true)}
              disabled={!messages?.length || pending !== null}
              title="Clear this conversation"
            >
              <Trash2 size={14} aria-hidden /> Clear
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!question.trim() || pending !== null}>
            {pending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Send size={14} aria-hidden />} Ask
          </button>
        </div>
      </form>
    </div>
  );
}
