import { describe, expect, it } from "vitest";
import { chunkTranscript } from "./chunker";

/** ~25 tokens of prose (chars/4 estimator) with a distinguishing number. */
function para(n: number): string {
  return `Paragraph ${n} talks about the topic at hand in a couple of sentences. It keeps going just long enough to carry some weight.`;
}

describe("chunker — pure function contract (TDD §5.1)", () => {
  it("T-C.1 under budget → single chunk equal to input", () => {
    const body = [para(1), para(2), para(3)].join("\n\n");
    expect(chunkTranscript(body, 3000)).toEqual([{ position: 1, text: body }]);
  });

  it("T-C.2 boundaries are paragraph boundaries; chunks round-trip", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => para(i + 1));
    const body = paragraphs.join("\n\n");

    const chunks = chunkTranscript(body, 250);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // starts and ends exactly at paragraph boundaries
      expect(paragraphs.some((p) => c.text.startsWith(p))).toBe(true);
      expect(paragraphs.some((p) => c.text.endsWith(p))).toBe(true);
      // no paragraph split across chunks
      for (const p of paragraphs) {
        if (c.text.includes(p.slice(0, 30))) expect(c.text).toContain(p);
      }
    }
    // separators restored → original body
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(body);
  });

  it("T-C.3 greedy packing: no two adjacent chunks could merge within budget", () => {
    const body = Array.from({ length: 40 }, (_, i) => para(i + 1)).join("\n\n");
    const budget = 250;
    const chunks = chunkTranscript(body, budget);

    const tokens = (s: string) => Math.ceil(s.length / 4);
    for (let i = 0; i < chunks.length - 1; i++) {
      const merged = `${chunks[i]!.text}\n\n${chunks[i + 1]!.text}`;
      expect(tokens(merged)).toBeGreaterThan(budget);
    }
  });

  it("T-C.4 speaker turns start paragraphs even without blank lines", () => {
    const turns = Array.from(
      { length: 12 },
      (_, i) =>
        `Host${i % 2}: turn ${i} rambles on and on for a good little while to fill some space here.`
    );
    const body = turns.join("\n"); // no blank lines

    const chunks = chunkTranscript(body, 60);

    expect(chunks.length).toBeGreaterThan(1);
    // every chunk starts at a turn boundary, none splits a turn line
    for (const c of chunks) {
      expect(/^Host[01]: turn \d+/.test(c.text)).toBe(true);
      for (const t of turns) {
        // 16 chars covers "HostX: turn NN r" — unique per turn
        if (c.text.includes(t.slice(0, 16))) expect(c.text).toContain(t);
      }
    }
  });

  it("T-C.5 oversized single paragraph splits on sentences, never mid-word", () => {
    const sentence =
      "This single sentence is repeated to build one enormous paragraph that cannot fit any budget.";
    const body = Array.from({ length: 50 }, () => sentence).join(" ");

    const chunks = chunkTranscript(body, 100);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i + 1));
    for (const c of chunks) {
      expect(c.text.startsWith("This single")).toBe(true);
      expect(c.text.endsWith("budget.")).toBe(true); // sentence-aligned, no mid-word cut
    }
  });

  it("T-C.6 deterministic", () => {
    const body = Array.from({ length: 40 }, (_, i) => para(i + 1)).join("\n\n");
    expect(chunkTranscript(body, 250)).toEqual(chunkTranscript(body, 250));
  });
});
