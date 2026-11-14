import { describe, expect, test } from "bun:test";
import { memoryStore, STORAGE_KEYS } from "../platform/storage.ts";
import { createDraftStore } from "./drafts.ts";
import { createSessionGate } from "./gate.ts";
import { safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  test.each([
    "/onboarding",
    "/workspace/workspace_1/channel/ch_9?thread=7#latest",
    "/invite/inv-mel-pending",
    "/",
  ])("keeps an address inside the web: %s", (value) => {
    expect(safeRedirect(value)).toBe(value);
  });

  test.each([
    ["another site", "https://evil.example/login"],
    ["a protocol-relative address", "//evil.example"],
    ["a backslash the browser reads as a slash", "/\\evil.example"],
    ["a backslash further in", "/\\/evil.example"],
    ["a script address", "javascript:alert(1)"],
    ["a tab hidden in the slashes", "/\t/evil.example"],
    ["a line break", "/\n/evil.example"],
    ["no leading slash", "onboarding"],
    ["an empty string", ""],
    ["not a string", 42],
    ["nothing", undefined],
    ["an array", ["/onboarding"]],
  ])("drops %s", (_name, value) => {
    expect(safeRedirect(value)).toBeUndefined();
  });

  test.each(["/login", "/signup", "/login?redirect=/login", "/forgot-password", "/reset-password?token=x"])(
    "never returns to a sign-in screen: %s",
    (value) => {
      expect(safeRedirect(value)).toBeUndefined();
    },
  );
});

describe("drafts", () => {
  test("text is kept by id and survives a new store over the same storage", () => {
    const storage = memoryStore();
    createDraftStore(storage).write("workspace.name", "Birchwood Labs");
    expect(createDraftStore(storage).read("workspace.name")).toBe("Birchwood Labs");
    expect(createDraftStore(storage).read("other")).toBeUndefined();
  });

  test("writing an empty text, or removing, drops the draft", () => {
    const drafts = createDraftStore(memoryStore());
    drafts.write("a", "one");
    drafts.write("b", "two");
    drafts.write("a", "");
    drafts.remove("b");
    expect([drafts.read("a"), drafts.read("b")]).toEqual([undefined, undefined]);
  });

  test("the same person signing in again keeps their drafts", () => {
    const drafts = createDraftStore(memoryStore());
    drafts.claim("usr_ana");
    drafts.write("note", "half a sentence");
    drafts.claim("usr_ana");
    expect(drafts.read("note")).toBe("half a sentence");
  });

  test("someone else signing in finds none", () => {
    const drafts = createDraftStore(memoryStore());
    drafts.claim("usr_ana");
    drafts.write("note", "half a sentence");
    drafts.claim("usr_jonas");
    expect(drafts.read("note")).toBeUndefined();
  });

  test("text typed before anyone was known is not handed to whoever signs in", () => {
    const drafts = createDraftStore(memoryStore());
    drafts.write("note", "typed by nobody");
    drafts.claim("usr_ana");
    expect(drafts.read("note")).toBeUndefined();
  });

  test.each(["not json", "[]", '{"owner":7,"values":{}}', '{"owner":null,"values":{"a":1}}', "null"])(
    "stored junk is ignored: %s",
    (junk) => {
      const storage = memoryStore();
      storage.setItem(STORAGE_KEYS.drafts, junk);
      const drafts = createDraftStore(storage);
      expect(drafts.read("a")).toBeUndefined();
      drafts.write("a", "fresh");
      expect(drafts.read("a")).toBe("fresh");
    },
  );

  test("a storage that throws loses the draft and nothing else", () => {
    const drafts = createDraftStore({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    drafts.write("a", "text");
    expect(drafts.read("a")).toBeUndefined();
  });
});

describe("the session gate", () => {
  const setup = () => {
    const drafts = createDraftStore(memoryStore());
    let ended = 0;
    const gate = createSessionGate({ drafts, onEnded: () => ended++ });
    return { drafts, gate, ended: () => ended };
  };

  test("the end of a session is reported once, however many calls fail", () => {
    const { gate, ended } = setup();
    gate.established("usr_ana");
    gate.ended();
    gate.ended();
    gate.ended();
    expect(ended()).toBe(1);
    expect(gate.userId()).toBeNull();
  });

  test("a 401 before any session existed is not the end of one", () => {
    const { gate, ended } = setup();
    gate.ended();
    expect(ended()).toBe(0);
  });

  test("drafts outlive the end of a session and return to the same person", () => {
    const { gate, drafts } = setup();
    gate.established("usr_ana");
    drafts.write("workspace.name", "Birchwood");
    gate.ended();
    gate.established("usr_ana");
    expect(drafts.read("workspace.name")).toBe("Birchwood");
  });

  test("drafts are gone when another person signs in after the session ended", () => {
    const { gate, drafts } = setup();
    gate.established("usr_ana");
    drafts.write("workspace.name", "Birchwood");
    gate.ended();
    gate.established("usr_jonas");
    expect(drafts.read("workspace.name")).toBeUndefined();
  });

  test("signing out on purpose drops the drafts and reports nothing", () => {
    const { gate, drafts, ended } = setup();
    gate.established("usr_ana");
    drafts.write("workspace.name", "Birchwood");
    gate.leftOnPurpose();
    gate.ended();
    expect(drafts.read("workspace.name")).toBeUndefined();
    expect(ended()).toBe(0);
  });
});
