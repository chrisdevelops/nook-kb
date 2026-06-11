export type Chunk = { position: number; text: string };

const DEFAULT_BUDGET = 3000;
/** Token estimator: chars/4 (TDD §5.1 — precision is not the contract). */
const tokens = (s: string): number => Math.ceil(s.length / 4);

const SPEAKER_TURN = /^[A-Z][\w .'-]{0,40}:/;

type Span = { start: number; end: number };

/**
 * Paragraph segmentation over the original text: a new paragraph starts at
 * a blank line, or at a speaker-turn line even without one (T-C.4).
 * Spans index into the body so chunk texts are exact slices (round-trip,
 * T-C.2).
 */
function paragraphSpans(body: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  let current: Span | null = null;
  for (const line of body.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // consumed "\n"
    if (line.trim() === "") {
      current = null; // blank line closes the paragraph
      continue;
    }
    if (current === null || SPEAKER_TURN.test(line)) {
      current = { start: lineStart, end: lineEnd };
      spans.push(current);
    } else {
      current.end = lineEnd;
    }
  }
  return spans;
}

/** Oversized single paragraph: sentence-boundary fallback, never mid-word (T-C.5). */
function splitSentences(text: string, budget: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current === "" ? sentence : `${current} ${sentence}`;
    if (current !== "" && tokens(candidate) > budget) {
      pieces.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

export function chunkTranscript(
  body: string,
  budgetTokens: number = DEFAULT_BUDGET
): Chunk[] {
  if (tokens(body) <= budgetTokens) {
    return [{ position: 1, text: body }];
  }

  const texts: string[] = [];
  let open: Span | null = null; // accumulating chunk as a body slice

  const close = () => {
    if (open !== null) texts.push(body.slice(open.start, open.end));
    open = null;
  };

  for (const span of paragraphSpans(body)) {
    const paragraph = body.slice(span.start, span.end);
    if (tokens(paragraph) > budgetTokens) {
      close();
      texts.push(...splitSentences(paragraph, budgetTokens));
      continue;
    }
    if (open === null) {
      open = { ...span };
    } else if (tokens(body.slice(open.start, span.end)) > budgetTokens) {
      close();
      open = { ...span };
    } else {
      open.end = span.end; // greedy: keep packing (T-C.3)
    }
  }
  close();

  return texts.map((text, i) => ({ position: i + 1, text }));
}
