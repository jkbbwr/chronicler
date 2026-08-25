import { type Component, createSignal, For, Show } from "solid-js";
import { CaseSensitive, Replace, ReplaceAll } from "lucide-solid";

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface SearchViewProps {
  onOpenResult: (filename: string, line: number) => void;
  onStatus: (message: string) => void;
}

const inputStyle = {
  width: "100%",
  background: "var(--bg-color)",
  border: "1px solid var(--border-color)",
  color: "var(--text-main)",
  "font-size": "12px",
  padding: "6px 8px",
  outline: "none",
  "border-radius": "4px",
} as const;

export const SearchView: Component<SearchViewProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [matchCase, setMatchCase] = createSignal(false);
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searched, setSearched] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const runSearch = async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    try {
      const res = await window.chronicler.invoke("project/search", { query: q, matchCase: matchCase() });
      setResults(res.results as SearchResult[]);
      setSearched(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleInput = (value: string) => {
    setQuery(value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(value), 250);
  };

  const toggleCase = () => {
    setMatchCase(v => !v);
    if (query().trim()) runSearch(query());
  };

  const replaceOne = async (hit: SearchResult) => {
    try {
      await window.chronicler.invoke("project/replace", {
        query: query(),
        replacement: replacement(),
        matchCase: matchCase(),
        file: hit.file,
        line: hit.line,
      });
      props.onStatus(`Replaced in ${hit.file}:${hit.line}`);
      runSearch(query());
    } catch (err: any) {
      props.onStatus(`Replace failed: ${err.message}`);
    }
  };

  const replaceAll = async () => {
    if (!query().trim() || results().length === 0) return;
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Replace All", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Replace “${query()}” with “${replacement()}” across the project?`,
      detail: `${results().length} matching line(s). Open files reload automatically; take a snapshot first if you want an undo point.`,
    });
    if (r.response !== 0) return;
    try {
      const res = await window.chronicler.invoke("project/replace", {
        query: query(),
        replacement: replacement(),
        matchCase: matchCase(),
      });
      props.onStatus(`Replaced ${res.occurrences} occurrence(s) in ${res.filesChanged} file(s)`);
      runSearch(query());
    } catch (err: any) {
      props.onStatus(`Replace failed: ${err.message}`);
    }
  };

  // Group results by file for a VS Code-style tree
  const grouped = () => {
    const groups = new Map<string, SearchResult[]>();
    for (const r of results()) {
      const list = groups.get(r.file) ?? [];
      list.push(r);
      groups.set(r.file, list);
    }
    return [...groups.entries()];
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div style={{ padding: "10px 12px 4px", display: "flex", gap: "6px", "align-items": "center" }}>
        <input
          type="text"
          placeholder="Search project..."
          value={query()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          style={inputStyle}
        />
        <div
          onClick={toggleCase}
          title="Match case"
          style={{
            display: "flex", padding: "4px", cursor: "pointer", "border-radius": "4px",
            border: matchCase() ? "1px solid var(--accent)" : "1px solid var(--border-color)",
            color: matchCase() ? "var(--accent)" : "var(--text-faint)", "flex-shrink": 0,
          }}
        >
          <CaseSensitive size={14} />
        </div>
      </div>
      <div style={{ padding: "0 12px 8px", display: "flex", gap: "6px", "align-items": "center" }}>
        <input
          type="text"
          placeholder="Replace with..."
          value={replacement()}
          onInput={(e) => setReplacement(e.currentTarget.value)}
          style={inputStyle}
        />
        <div
          onClick={replaceAll}
          title={`Replace all (${results().length} lines)`}
          style={{
            display: "flex", padding: "4px", cursor: results().length ? "pointer" : "default",
            "border-radius": "4px", border: "1px solid var(--border-color)",
            color: results().length ? "var(--text-main)" : "var(--text-faint)", "flex-shrink": 0,
          }}
        >
          <ReplaceAll size={14} />
        </div>
      </div>

      <div style={{ "overflow-y": "auto", flex: 1, padding: "0 0 10px 0" }}>
        <Show when={searching()}>
          <div style={{ padding: "5px 15px", color: "var(--text-muted)", "font-size": "12px" }}>Searching...</div>
        </Show>
        <Show when={!searching() && searched() && results().length === 0}>
          <div style={{ padding: "5px 15px", color: "var(--text-faint)", "font-size": "12px" }}>No results</div>
        </Show>
        <For each={grouped()}>
          {([file, hits]) => (
            <div style={{ "margin-bottom": "6px" }}>
              <div style={{
                padding: "4px 12px",
                "font-size": "12px",
                "font-weight": 600,
                color: "var(--text-main)",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}>
                {file} <span style={{ color: "var(--text-faint)", "font-weight": 400 }}>({hits.length})</span>
              </div>
              <For each={hits}>
                {(hit) => (
                  <div
                    onClick={() => props.onOpenResult(hit.file, hit.line)}
                    class="search-hit"
                    style={{
                      padding: "3px 8px 3px 24px",
                      cursor: "pointer",
                      "font-size": "12px",
                      color: "var(--text-muted)",
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--hover-bg)"; e.currentTarget.style.color = "var(--text-main)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  >
                    <span style={{ color: "var(--text-faint)" }}>{hit.line}</span>
                    <span style={{ flex: 1, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>{hit.text}</span>
                    <div
                      onClick={(e) => { e.stopPropagation(); replaceOne(hit); }}
                      title="Replace on this line"
                      style={{ display: "flex", padding: "2px", color: "var(--text-faint)", "flex-shrink": 0 }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}
                    >
                      <Replace size={12} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
