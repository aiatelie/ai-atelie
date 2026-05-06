import { test, expect, beforeEach } from "bun:test";
import { folderStateKey, readFolderState, writeFolderState } from "./folderState";

// Bun's runtime has no DOM, so we install a minimal localStorage stub.
// Each test resets the store via beforeEach so they're order-independent.
const store = new Map<string, string>();
const stubStorage: Storage = {
  get length() { return store.size; },
  clear() { store.clear(); },
  getItem(k) { return store.has(k) ? store.get(k)! : null; },
  setItem(k, v) { store.set(k, v); },
  removeItem(k) { store.delete(k); },
  key(i) { return Array.from(store.keys())[i] ?? null; },
};
(globalThis as { localStorage: Storage }).localStorage = stubStorage;

beforeEach(() => { store.clear(); });

test("readFolderState returns {} for an unseen project", () => {
  expect(readFolderState("p1")).toEqual({});
});

test("write → read round-trips an open/closed mix", () => {
  writeFolderState("p1", { uploads: false, inspirations: true });
  expect(readFolderState("p1")).toEqual({ uploads: false, inspirations: true });
});

test("each project keeps its own state", () => {
  writeFolderState("p1", { uploads: false });
  writeFolderState("p2", { uploads: true });
  expect(readFolderState("p1")).toEqual({ uploads: false });
  expect(readFolderState("p2")).toEqual({ uploads: true });
});

test("readFolderState ignores corrupt JSON", () => {
  store.set(folderStateKey("p1"), "{not valid json");
  expect(readFolderState("p1")).toEqual({});
});

test("readFolderState filters out non-boolean values", () => {
  store.set(folderStateKey("p1"), JSON.stringify({ ok: true, bad: "yes", n: 1 }));
  expect(readFolderState("p1")).toEqual({ ok: true });
});

test("readFolderState rejects arrays masquerading as state", () => {
  store.set(folderStateKey("p1"), JSON.stringify([true, false]));
  expect(readFolderState("p1")).toEqual({});
});
