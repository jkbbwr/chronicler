import { type Component, For, Show } from "solid-js";

interface Heading {
  level: number;
  text: string;
  line: number; // 1-based
}

interface OutlinerViewProps {
  content: string;
  onJump: (line: number) => void;
}

const parseHeadings = (content: string): Heading[] => {
  const headings: Heading[] = [];
  let inFence = false;
  content.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2], line: i + 1 });
    }
  });
  return headings;
};

export const OutlinerView: Component<OutlinerViewProps> = (props) => {
  const headings = () => parseHeadings(props.content);

  return (
    <div style={{ "overflow-y": "auto", height: "100%", padding: "5px 0" }}>
      <Show when={headings().length === 0}>
        <div style={{ padding: "10px 15px", color: "var(--text-faint)", "font-size": "12px" }}>
          No headings in this document
        </div>
      </Show>
      <For each={headings()}>
        {(h) => (
          <div
            onClick={() => props.onJump(h.line)}
            style={{
              padding: `4px 15px 4px ${15 + (h.level - 1) * 14}px`,
              cursor: "pointer",
              "font-size": h.level === 1 ? "13px" : "12px",
              "font-weight": h.level <= 2 ? 600 : 400,
              color: h.level === 1 ? "var(--text-main)" : "var(--text-muted)",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--hover-bg)"; e.currentTarget.style.color = "var(--text-main)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = h.level === 1 ? "var(--text-main)" : "var(--text-muted)"; }}
          >
            {h.text}
          </div>
        )}
      </For>
    </div>
  );
};
