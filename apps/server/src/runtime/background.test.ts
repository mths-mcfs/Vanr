import { describe, expect, test } from "bun:test";
import { BackgroundWork } from "./background";

const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("background work", () => {
  test("settle waits for the tracked work, including work that starts while it waits", async () => {
    const work = new BackgroundWork();
    const done: string[] = [];
    work.track(
      later(20, "first").then((v) => {
        done.push(v);
        work.track(
          later(20, "spawned").then((w) => done.push(w)),
          "spawned",
        );
      }),
      "first",
    );
    await work.settle();
    expect(done).toEqual(["first", "spawned"]);
  });

  test("a failing work is logged and breaks neither settle nor the other work", async () => {
    const work = new BackgroundWork();
    const done: string[] = [];
    work.track(Promise.reject(new Error("boom")), "fails");
    work.track(
      later(10, "ok").then((v) => done.push(v)),
      "ok",
    );
    await work.settle();
    expect(done).toEqual(["ok"]);
  });

  test("with nothing tracked settle resolves at once; stop waits for the work in progress", async () => {
    const work = new BackgroundWork();
    await work.settle();
    let finished = false;
    work.track(
      later(30, null).then(() => {
        finished = true;
      }),
      "slow",
    );
    await work.stop();
    expect(finished).toBe(true);
  });
});
