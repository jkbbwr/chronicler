// Unit tests for the documents store: the save / reload races that used to
// lose writing. Run with `bun test` from frontend/.
import { beforeEach, describe, expect, test } from "bun:test";

// ---- A fake backend: an in-memory project behind window.chronicler ----

const disk = new Map<string, string>();
let saveGate: Promise<void> | null = null;
const dialogs: string[] = [];
let dialogResponse = 0;

(globalThis as any).window = globalThis;
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
(globalThis as any).chronicler = {
  invoke: async (method: string, params: any) => {
    if (method === "document/read") {
      if (!disk.has(params.path)) throw new Error("not found");
      return { content: disk.get(params.path) };
    }
    if (method === "document/save") {
      const content = params.content;
      if (saveGate) await saveGate;
      disk.set(params.path, content);
      return { success: true };
    }
    throw new Error(`unexpected ${method}`);
  },
  showMessageBox: async (opts: { message: string }) => {
    dialogs.push(opts.message);
    return { response: dialogResponse };
  },
  onEvent: () => () => {},
};

const { EditorState } = await import("@codemirror/state");
const docsModule = await import("../src/stores/documents");
const {
  docs, ensureLoaded, getContent, save, replaceRange, reconcileExternal, retarget, resetDocuments,
  registerStateFactory, countWords, scene, openScene,
} = docsModule;

registerStateFactory((_path, text) => EditorState.create({ doc: text }));

/** Type at the end of line 1 (a user edit through the store). */
const typeAtEnd = (path: string, text: string) => {
  const line = getContent(path).split("\n")[0];
  const ok = replaceRange(path, 1, line.length, line.length, "", text);
  expect(ok).toBe(true);
};

beforeEach(() => {
  resetDocuments();
  disk.clear();
  dialogs.length = 0;
  dialogResponse = 0;
  saveGate = null;
});

describe("saving", () => {
  test("typing while a save is in flight keeps the doc dirty and loses nothing", async () => {
    disk.set("a.md", "Hello");
    await ensureLoaded("a.md");
    typeAtEnd("a.md", " world");

    let release!: () => void;
    saveGate = new Promise((r) => (release = r));
    const pending = save("a.md");
    typeAtEnd("a.md", "!"); // typed after the save began
    release();
    await pending;
    saveGate = null;

    expect(disk.get("a.md")).toBe("Hello world");
    expect(docs["a.md"].dirty).toBe(true); // "!" still unsaved
    await save("a.md");
    expect(disk.get("a.md")).toBe("Hello world!");
    expect(docs["a.md"].dirty).toBe(false);
  });

  test("a clean doc saves nothing", async () => {
    disk.set("a.md", "Same");
    await ensureLoaded("a.md");
    expect(await save("a.md")).toBe(true);
    expect(docs["a.md"].dirty).toBe(false);
  });
});

describe("outside changes", () => {
  test("the echo of our own save is not treated as an outside change", async () => {
    disk.set("a.md", "One");
    await ensureLoaded("a.md");
    typeAtEnd("a.md", " two");
    await save("a.md");
    typeAtEnd("a.md", " three"); // dirty again when the echo lands
    await reconcileExternal(["a.md"]);
    expect(dialogs).toHaveLength(0);
    expect(getContent("a.md")).toBe("One two three");
  });

  test("a clean doc reloads silently from disk", async () => {
    disk.set("a.md", "Before");
    await ensureLoaded("a.md");
    disk.set("a.md", "After, edited elsewhere");
    await reconcileExternal(["a.md"]);
    expect(dialogs).toHaveLength(0);
    expect(getContent("a.md")).toBe("After, edited elsewhere");
    expect(docs["a.md"].dirty).toBe(false);
  });

  test("a dirty doc asks, and keeping my version overwrites on the next save", async () => {
    disk.set("a.md", "Base");
    await ensureLoaded("a.md");
    typeAtEnd("a.md", " mine");
    disk.set("a.md", "Base theirs");
    dialogResponse = 0; // Keep My Version
    await reconcileExternal(["a.md"]);
    expect(dialogs).toHaveLength(1);
    expect(getContent("a.md")).toBe("Base mine");
    await save("a.md");
    expect(disk.get("a.md")).toBe("Base mine");
  });

  test("a dirty doc can take the version on disk", async () => {
    disk.set("a.md", "Base");
    await ensureLoaded("a.md");
    typeAtEnd("a.md", " mine");
    disk.set("a.md", "Base theirs");
    dialogResponse = 1; // Use the Version on Disk
    await reconcileExternal(["a.md"]);
    expect(getContent("a.md")).toBe("Base theirs");
    expect(docs["a.md"].dirty).toBe(false);
  });

  test("the same text arriving from disk just marks the doc clean", async () => {
    disk.set("a.md", "Start");
    await ensureLoaded("a.md");
    typeAtEnd("a.md", " end");
    disk.set("a.md", "Start end");
    await reconcileExternal(["a.md"]);
    expect(dialogs).toHaveLength(0);
    expect(docs["a.md"].dirty).toBe(false);
  });
});

describe("journal and renames", () => {
  test("journaled unsaved text reopens dirty", async () => {
    disk.set("a.md", "Saved text");
    await ensureLoaded("a.md", "Saved text plus unsaved");
    expect(getContent("a.md")).toBe("Saved text plus unsaved");
    expect(docs["a.md"].dirty).toBe(true);
  });

  test("a journaled scene deleted from disk stays recoverable", async () => {
    expect(await ensureLoaded("gone.md", "Only in the journal")).toBe(true);
    expect(docs["gone.md"].dirty).toBe(true);
  });

  test("renaming a folder moves its open scenes and the current scene", async () => {
    disk.set("Ch1/a.md", "A");
    disk.set("Ch1/b.md", "B");
    await ensureLoaded("Ch1/a.md");
    await openScene("Ch1/b.md");
    typeAtEnd("Ch1/b.md", " edited");
    retarget("Ch1", "Chapter One");
    expect(docs["Ch1/a.md"]).toBeUndefined();
    expect(docs["Chapter One/a.md"].path).toBe("Chapter One/a.md");
    expect(scene()).toBe("Chapter One/b.md");
    expect(getContent("Chapter One/b.md")).toBe("B edited");
    expect(docs["Chapter One/b.md"].dirty).toBe(true);
  });
});

test("word counts skip margin notes and code", () => {
  expect(countWords("She ran. <!-- fix this later --> He didn't.")).toBe(4);
  expect(countWords("One\n```\nnot prose here\n```\nTwo")).toBe(2);
});
