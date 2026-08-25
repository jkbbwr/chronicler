import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { Camera, RotateCcw } from "lucide-solid";

interface Snapshot {
  hash: string;
  timestamp: number; // unix seconds
  message: string;
}

interface HistoryViewProps {
  activeFile: string | null;
  onStatus: (message: string) => void;
}

const relativeTime = (unixSeconds: number): string => {
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
};

const fetchSnapshots = async (): Promise<Snapshot[]> => {
  const res = await window.chronicler.invoke("snapshot/list");
  return res.snapshots as Snapshot[];
};

export const HistoryView: Component<HistoryViewProps> = (props) => {
  const [snapshots, { refetch }] = createResource(fetchSnapshots);
  const [busy, setBusy] = createSignal(false);

  const takeSnapshot = async () => {
    setBusy(true);
    try {
      const stamp = new Date().toLocaleString();
      const res = await window.chronicler.invoke("snapshot/create", { message: `Snapshot ${stamp}` });
      props.onStatus(res.created ? "Snapshot saved" : res.reason);
      refetch();
    } catch (err: any) {
      props.onStatus(`Snapshot failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const restoreActiveFile = async (snap: Snapshot) => {
    const file = props.activeFile;
    if (!file) {
      props.onStatus("Open a file to restore it from a snapshot");
      return;
    }
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Restore "${file}" from ${relativeTime(snap.timestamp)}?`,
      detail: "The current contents of this file will be replaced. Take a snapshot first if you want to keep them.",
    });
    if (r.response !== 0) return;
    try {
      await window.chronicler.invoke("snapshot/restore_file", { hash: snap.hash, rel_path: file });
      props.onStatus(`Restored ${file}`); // file watcher reloads the buffer
    } catch (err: any) {
      props.onStatus(`Restore failed: ${err.message}`);
    }
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div style={{ padding: "10px 12px" }}>
        <button
          onClick={takeSnapshot}
          disabled={busy()}
          style={{
            display: "flex", "align-items": "center", "justify-content": "center", gap: "8px",
            width: "100%", padding: "7px 0",
            background: "var(--accent)", color: "#fff",
            border: "none", "border-radius": "5px",
            "font-size": "12px", cursor: "pointer",
            opacity: busy() ? 0.6 : 1,
          }}
        >
          <Camera size={14} /> Take Snapshot
        </button>
      </div>

      <div style={{ "overflow-y": "auto", flex: 1 }}>
        <Show when={!snapshots.loading && (snapshots() ?? []).length === 0}>
          <div style={{ padding: "5px 15px", color: "var(--text-faint)", "font-size": "12px" }}>
            No snapshots yet. Snapshots capture the whole project so you can restore files later.
          </div>
        </Show>
        <For each={snapshots() ?? []}>
          {(snap) => (
            <div
              style={{ padding: "8px 12px", "border-bottom": "1px solid var(--border-color)", display: "flex", "align-items": "center", gap: "8px" }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              <div style={{ flex: 1, "min-width": 0 }}>
                <div style={{ "font-size": "12px", color: "var(--text-main)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                  {snap.message}
                </div>
                <div style={{ "font-size": "11px", color: "var(--text-faint)", "margin-top": "2px" }}>
                  {relativeTime(snap.timestamp)}
                </div>
              </div>
              <div
                title="Restore the active file from this snapshot"
                onClick={() => restoreActiveFile(snap)}
                style={{ display: "flex", padding: "4px", cursor: "pointer", color: "var(--text-faint)", "border-radius": "4px", "flex-shrink": 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-main)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}
              >
                <RotateCcw size={14} />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
