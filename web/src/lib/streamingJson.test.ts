import { describe, expect, test } from "bun:test";
import { parsePartialQuestions } from "./streamingJson";

describe("parsePartialQuestions", () => {
  test("empty input → empty result", () => {
    const r = parsePartialQuestions("");
    expect(r.complete).toBe(false);
    expect(r.questions).toEqual([]);
    expect(r.title).toBeUndefined();
  });

  test("fully-formed JSON → complete=true with everything", () => {
    const json = JSON.stringify({
      title: "Quick Qs",
      questions: [
        { id: "a", kind: "enum", title: "A?", options: ["x", "y"] },
        { id: "b", kind: "text", title: "B?" },
      ],
    });
    const r = parsePartialQuestions(json);
    expect(r.complete).toBe(true);
    expect(r.title).toBe("Quick Qs");
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]?.id).toBe("a");
  });

  test("title arrives but questions[] still streaming → title set, no complete questions", () => {
    const partial = '{"title":"Quick Qs","questions":[{"id":"a","kind":"enum","title":"A?","options":["x"';
    const r = parsePartialQuestions(partial);
    expect(r.complete).toBe(false);
    expect(r.title).toBe("Quick Qs");
    expect(r.questions).toEqual([]);
  });

  test("first question fully balanced → emits it; second question still streaming", () => {
    const partial =
      '{"title":"Q","questions":[{"id":"a","kind":"enum","title":"A?","options":["x","y"]},{"id":"b","kind":"text"';
    const r = parsePartialQuestions(partial);
    expect(r.complete).toBe(false);
    expect(r.title).toBe("Q");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]?.id).toBe("a");
  });

  test("two complete questions, third still streaming", () => {
    const partial =
      '{"title":"Q","questions":[{"id":"a","kind":"text","title":"A?"},{"id":"b","kind":"text","title":"B?"},{"id":"c","kind":"enu';
    const r = parsePartialQuestions(partial);
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]?.id).toBe("a");
    expect(r.questions[1]?.id).toBe("b");
  });

  test("nested braces inside option label don't trip balance counter", () => {
    const partial =
      '{"title":"Q","questions":[{"id":"a","kind":"enum","title":"Pick {one}","options":["{x}","y"]}]';
    const r = parsePartialQuestions(partial);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]?.title).toBe("Pick {one}");
  });

  test("escaped quotes in title don't trip string scanner", () => {
    const partial = '{"title":"Quick \\"Qs\\"","questions":[';
    const r = parsePartialQuestions(partial);
    expect(r.title).toBe('Quick "Qs"');
  });

  test("title-string still streaming → title undefined", () => {
    const partial = '{"title":"Quick Qs';
    const r = parsePartialQuestions(partial);
    expect(r.title).toBeUndefined();
  });

  test("non-questions_v2 shape parses cleanly when complete", () => {
    const partial = '{"foo": 1}';
    const r = parsePartialQuestions(partial);
    expect(r.complete).toBe(true);
    expect(r.title).toBeUndefined();
    expect(r.questions).toEqual([]);
  });
});
