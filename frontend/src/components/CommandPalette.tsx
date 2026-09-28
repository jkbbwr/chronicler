import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FileText, Search, ChevronRight, User } from "lucide-solid";
import { commandList, formatKeybinding } from "../commands";
import { invoke } from "../lib/rpc";
import { chapterOf, recent, sceneName } from "../stores/documents";
import { entities, openEntity } from "../stores/codex";
import "./CommandPalette.css";

// Go to anything: scenes and codex entries by default, commands after ">".
// Fuzzy, keyboard-first, recent things first.

interface CommandPaletteProps {
  isOpen: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelectFile: (filename: string) => void;
  onSelectCommand: (commandId: string) => void;
}

interface Item {
  id: string;
  kind: "scene" | "entity" | "command";
  label: string;
  detail?: string;
  key?: string;
  score: number;
  run: () => void;
}

/** Subsequence match: consecutive and word-start hits score higher. -1 = no match. */
function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (t.length - q.length) * 0.1 + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 + (found === 0 || /\W/.test(t[found - 1]) ? 15 : 0);
    ti = found + 1;
  }
  return score - (t.length - q.length) * 0.2;
}

const RECENT_COMMANDS_KEY = "chronicler-recent-commands";
const loadRecentCommands = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const rememberCommand = (id: string) => {
  const next = [id, ...loadRecentCommands().filter((c) => c !== id)].slice(0, 8);
  try { localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
};

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [files, setFiles] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal(0);
  let inputRef!: HTMLInputElement;
  let listRef!: HTMLDivElement;

  createEffect(on(() => props.isOpen, (open) => {
    if (!open) return;
    setQuery(props.initialQuery ?? "");
    setSelected(0);
    queueMicrotask(() => inputRef?.focus());
    invoke("project/list_files")
      .then((res) => setFiles(res.files.filter((f) => !f.isDir).map((f) => f.path)))
      .catch(() => setFiles([]));
  }));

  const commandMode = () => query().startsWith(">");

  const items = createMemo<Item[]>(() => {
    if (commandMode()) {
      const q = query().slice(1).trim();
      const recents = loadRecentCommands();
      return commandList()
        .map((c) => ({
          id: c.id,
          kind: "command" as const,
          label: c.title,
          key: c.keybinding ? formatKeybinding(c.keybinding) : undefined,
          score: q ? fuzzy(q, c.title) : 100 - (recents.includes(c.id) ? recents.indexOf(c.id) - 50 : 0),
          run: () => { rememberCommand(c.id); props.onSelectCommand(c.id); },
        }))
        .filter((i) => i.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
    }
    const q = query().trim();
    const recentRank = new Map(recent().map((p, i) => [p, i]));
    const scenes: Item[] = files().map((f) => {
      const name = sceneName(f);
      const base = q ? Math.max(fuzzy(q, name) + 50, fuzzy(q, f)) : 0;
      const bonus = recentRank.has(f) ? 40 - recentRank.get(f)! : 0;
      return {
        id: f, kind: "scene", label: name, detail: chapterOf(f), score: q && base < 0 ? -1 : base + bonus,
        run: () => props.onSelectFile(f),
      };
    });
    const people: Item[] = q
      ? (entities.latest ?? []).map((e) => {
          const s = Math.max(fuzzy(q, e.name), ...(e.aliases ?? []).map((a) => fuzzy(q, a)));
          return { id: `entity:${e.id}`, kind: "entity", label: e.name, detail: e.kind, score: s < 0 ? -1 : s - 20, run: () => openEntity(e.id) };
        })
      : [];
    const list = [...scenes, ...people].filter((i) => i.score >= 0);
    if (!q) {
      // Recent scenes first, then the rest in manuscript order.
      return list.sort((a, b) => (recentRank.get(a.id) ?? 1e9) - (recentRank.get(b.id) ?? 1e9)).slice(0, 80);
    }
    return list.sort((a, b) => b.score - a.score).slice(0, 80);
  });

  const choose = (item: Item | undefined) => {
    if (!item) return;
    props.onClose();
    item.run();
  };

  const move = (delta: number) => {
    const n = items().length;
    if (n === 0) return;
    setSelected((s) => (s + delta + n) % n);
    listRef?.querySelector(`[data-index="${selected()}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items()[selected()]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
  };

  return (
    <Show when={props.isOpen}>
      <Portal>
        <div class="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
          <div class="palette" role="dialog" aria-label={commandMode() ? "Commands" : "Go to"}>
            <div class="palette-input-row">
              {commandMode() ? <ChevronRight size={16} /> : <Search size={16} />}
              <input
                ref={inputRef}
                class="palette-input"
                value={query()}
                onInput={(e) => { setQuery(e.currentTarget.value); setSelected(0); }}
                onKeyDown={onKey}
                placeholder={commandMode() ? "Run a command…" : "Go to a scene or codex entry…  (type > for commands)"}
                spellcheck={false}
              />
            </div>
            <div class="palette-list" ref={listRef}>
              <For each={items()}>
                {(item, i) => (
                  <div
                    class="palette-item"
                    classList={{ selected: i() === selected() }}
                    data-index={i()}
                    onMouseMove={() => setSelected(i())}
                    onClick={() => choose(item)}
                  >
                    <span class="palette-icon">
                      {item.kind === "scene" ? <FileText size={14} /> : item.kind === "entity" ? <User size={14} /> : null}
                    </span>
                    <span class="palette-label" classList={{ prose: item.kind !== "command" }}>{item.label}</span>
                    <Show when={item.detail}><span class="palette-detail">{item.detail}</span></Show>
                    <Show when={item.key}><kbd class="kbd">{item.key}</kbd></Show>
                  </div>
                )}
              </For>
              <Show when={items().length === 0}>
                <div class="palette-empty">Nothing matches “{commandMode() ? query().slice(1).trim() : query()}”</div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};
