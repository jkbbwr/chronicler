import { type Component, createSignal, For, type JSX, Show } from "solid-js";
import { CaseSensitive, Replace, ReplaceAll } from "lucide-solid";
import { IconButton } from "../ui";
import { flush, sceneName, chapterOf } from "../../stores/documents";
import "./SearchView.css";

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface SearchViewProps {
  onOpenResult: (filename: string, line: number) => void;
  onStatus: (message: string) => void;
}

/** The line with every match of `q` wrapped in <mark>. */
function highlight(text: string, q: string, matchCase: boolean): JSX.Element[] {
  if (!q) return [text];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? q : q.toLowerCase();
  const out: JSX.Element[] = [];
  let i = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

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
    if (!(await flush())) return; // replace works on the saved text
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
      detail: `${results().length} matching line(s). The previous text stays in History.`,
    });
    if (r.response !== 0) return;
    if (!(await flush())) return;
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
    <div class="search-view">
      <div class="search-fields">
        <div class="search-row">
          <input class="input" placeholder="Find in the manuscript…" value={query()} onInput={(e) => handleInput(e.currentTarget.value)} />
          <IconButton label="Match case" active={matchCase()} onClick={toggleCase}><CaseSensitive size={15} /></IconButton>
        </div>
        <div class="search-row">
          <input class="input" placeholder="Replace with…" value={replacement()} onInput={(e) => setReplacement(e.currentTarget.value)} />
          <IconButton label={`Replace all (${results().length} lines)`} disabled={results().length === 0} onClick={() => void replaceAll()}><ReplaceAll size={15} /></IconButton>
        </div>
        <Show when={searched() && results().length > 0}>
          <div class="hint">{results().length} line{results().length === 1 ? "" : "s"} in {grouped().length} scene{grouped().length === 1 ? "" : "s"}</div>
        </Show>
      </div>

      <div class="search-results">
        <Show when={searching()}><div class="hint search-note">Searching…</div></Show>
        <Show when={!searching() && searched() && results().length === 0}><div class="hint search-note">No matches</div></Show>
        <For each={grouped()}>
          {([file, hits]) => (
            <div class="search-group">
              <div class="section-label" title={file}>
                <span class="search-scene">{sceneName(file)}</span>
                <span class="search-chapter">{chapterOf(file)}</span>
                <span class="row-meta">{hits.length}</span>
              </div>
              <For each={hits}>
                {(hit) => (
                  <div class="list-row search-hit" onClick={() => props.onOpenResult(hit.file, hit.line)}>
                    <span class="search-text">{highlight(hit.text, query(), matchCase())}</span>
                    <span class="row-actions">
                      <IconButton size="sm" label="Replace on this line" onClick={(e) => { e.stopPropagation(); void replaceOne(hit); }}>
                        <Replace size={12} />
                      </IconButton>
                    </span>
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
