// store.test.ts — covers the toast pub-sub: push, dismiss, default
// tone/duration, sticky toasts, subscriber notification, and the
// shorthand `toast.error/info/warn/success` helpers.
//
// Run via `bun test src/components/toast/store.test.ts`.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  dismissToast,
  getToasts,
  pushToast,
  subscribe,
  toast,
} from "./store";

afterEach(() => __resetForTests());

describe("pushToast", () => {
  test("appends with default tone=info and duration=4000", () => {
    const id = pushToast({ message: "hello" });
    const [t] = getToasts();
    expect(t.id).toBe(id);
    expect(t.message).toBe("hello");
    expect(t.tone).toBe("info");
    expect(t.durationMs).toBe(4000);
  });

  test("respects explicit tone + duration", () => {
    pushToast({ message: "boom", tone: "error", durationMs: 0 });
    const [t] = getToasts();
    expect(t.tone).toBe("error");
    expect(t.durationMs).toBe(0);
  });

  test("preserves insertion order", () => {
    pushToast({ message: "first" });
    pushToast({ message: "second" });
    pushToast({ message: "third" });
    expect(getToasts().map((t) => t.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("dismissToast", () => {
  test("removes the toast with the given id", () => {
    const a = pushToast({ message: "a" });
    pushToast({ message: "b" });
    dismissToast(a);
    expect(getToasts().map((t) => t.message)).toEqual(["b"]);
  });

  test("noop for unknown id", () => {
    pushToast({ message: "a" });
    dismissToast("does-not-exist");
    expect(getToasts()).toHaveLength(1);
  });
});

describe("subscribe", () => {
  test("listener fires on push and dismiss", () => {
    const calls: number[] = [];
    const unsub = subscribe((toasts) => calls.push(toasts.length));
    const id = pushToast({ message: "a" });
    pushToast({ message: "b" });
    dismissToast(id);
    unsub();
    pushToast({ message: "c" }); // should NOT notify after unsub
    expect(calls).toEqual([1, 2, 1]);
  });
});

describe("toast shorthand", () => {
  test("toast.error sets tone=error", () => {
    toast.error("nope");
    expect(getToasts()[0].tone).toBe("error");
  });
  test("toast.success sets tone=success", () => {
    toast.success("yay");
    expect(getToasts()[0].tone).toBe("success");
  });
  test("toast.warn sets tone=warn", () => {
    toast.warn("hmm");
    expect(getToasts()[0].tone).toBe("warn");
  });
  test("toast.info sets tone=info", () => {
    toast.info("fyi");
    expect(getToasts()[0].tone).toBe("info");
  });
  test("opts pass through (actionLabel, onAction, durationMs)", () => {
    let fired = 0;
    toast.error("oops", {
      actionLabel: "Retry",
      onAction: () => fired++,
      durationMs: 0,
    });
    const [t] = getToasts();
    expect(t.actionLabel).toBe("Retry");
    expect(t.durationMs).toBe(0);
    t.onAction?.();
    expect(fired).toBe(1);
  });
});
