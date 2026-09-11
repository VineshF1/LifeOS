"use client";

import type { ReactNode } from "react";

export const SOURCE_TAG = /\[Source:\s*(.*?),\s*Page:\s*(\d+),\s*Excerpt:\s*"([^"]*)"\]/g;

export function CitationChip({
  filename,
  page,
  excerpt,
}: {
  filename: string;
  page: string;
  excerpt: string;
}) {
  const short = filename.length > 28 ? `${filename.slice(0, 28)}…` : filename;

  return (
    <details className="d-inline-block align-middle mx-1">
      <summary className="badge bg-blue-lt" style={{ cursor: "pointer" }}>
        {short} · p{page}
      </summary>
      <div className="card card-body citation-pop mt-1 p-2">
        <div className="fw-medium" style={{ fontSize: 12 }}>
          {filename} — page {page}
        </div>
        <div className="text-muted fst-italic" style={{ fontSize: 12 }}>
          “{excerpt}”
        </div>
      </div>
    </details>
  );
}

export function renderWithCitations(text: string) {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(SOURCE_TAG.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(<CitationChip key={`cite-${key++}`} filename={match[1]} page={match[2]} excerpt={match[3]} />);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
