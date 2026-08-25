import { type Component, createSignal, For, Show } from "solid-js";

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface SearchViewProps {
  onOpenResult: (filename: string, line: number) => void;
}

export const SearchView: Component<SearchViewProps> = (props) => {
  const [query, setQuery] = createSignal("");
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
      const res = await window.chronicler.invoke("project/search", { query: q });
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
      <div style={{ padding: "10px 12px" }}>
        <input
          type="text"
          placeholder="Search project..."
          value={query()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          style={{
            width: "100%",
            background: "var(--bg-color)",
            border: "1px solid var(--border-color)",
            color: "var(--text-main)",
            "font-size": "12px",
            padding: "6px 8px",
            outline: "none",
            "border-radius": "4px",
          }}
        />
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
                    style={{
                      padding: "3px 12px 3px 24px",
                      cursor: "pointer",
                      "font-size": "12px",
                      color: "var(--text-muted)",
                      "white-space": "nowrap",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--hover-bg)"; e.currentTarget.style.color = "var(--text-main)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  >
                    <span style={{ color: "var(--text-faint)", "margin-right": "6px" }}>{hit.line}</span>
                    {hit.text}
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
