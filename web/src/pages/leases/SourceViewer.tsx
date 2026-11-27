import { useEffect, useMemo, useRef } from "react";

export interface Highlight {
  page: number | null;
  text: string;
}

/** Build a whitespace/quote-tolerant pattern, mirroring the server's verbatim check. */
function snippetPattern(snippet: string): RegExp | null {
  const words = snippet
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/["']/g, "[\"'“”‘’]"));
  if (!words.length) return null;
  try {
    return new RegExp(words.join("\\s+"), "i");
  } catch {
    return null;
  }
}

function Page({ text, number, highlight }: { text: string; number: number; highlight: Highlight | null }) {
  const parts = useMemo(() => {
    if (!highlight) return null;
    const re = snippetPattern(highlight.text);
    const m = re ? re.exec(text) : null;
    if (!m) return null;
    return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)] as const;
  }, [text, highlight]);

  return (
    <div className="source-page" data-page={number}>
      <div className="source-page-label">Page {number}</div>
      <pre className="source-text">
        {parts ? (
          <>
            {parts[0]}
            <mark className="source-mark">{parts[1]}</mark>
            {parts[2]}
          </>
        ) : (
          text
        )}
      </pre>
    </div>
  );
}

/** The extracted text of the original document, with the selected evidence highlighted. */
export function SourceViewer({ pages, highlight }: { pages: string[]; highlight: Highlight | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector(".source-mark") ?? (highlight?.page ? ref.current?.querySelector(`[data-page="${highlight.page}"]`) : null);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);

  const notFound = useMemo(() => {
    if (!highlight) return false;
    const re = snippetPattern(highlight.text);
    return !re || !pages.some((p) => re.test(p));
  }, [highlight, pages]);

  return (
    <div className="source-viewer" ref={ref}>
      {notFound && <div className="alert alert-info source-note">This excerpt does not appear verbatim in the document text, which is why it was not trusted.</div>}
      {pages.map((p, i) => (
        <Page key={i} number={i + 1} text={p} highlight={highlight && (highlight.page === null || highlight.page === i + 1) ? highlight : null} />
      ))}
    </div>
  );
}
