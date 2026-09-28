import { type Component, For, Show } from "solid-js";
import { Pause, Play, SkipBack, SkipForward, Square, Volume2 } from "lucide-solid";
import { IconButton } from "../ui";
import { error, loading, next, playing, previous, RATES, rate, reading, setRate, stop, toggle } from "../../lib/readAloud";
import "./ReadAloudBar.css";

/** "Part 1/03 The Quay.md" → "The Quay". */
const defaultName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/**
 * The floating read-aloud player. Renders only while something is being
 * read (`startReading` from lib/readAloud). Mount it once, anywhere inside
 * the page it should float over (it positions itself absolutely).
 */
export const ReadAloudBar: Component<{
  /** Display name for a scene path (defaults to the file name). */
  sceneName?: (path: string) => string;
}> = (props) => {
  const name = () => {
    const r = reading();
    return r ? (props.sceneName ?? defaultName)(r.path) : "";
  };
  return (
    <Show when={reading()}>
      <div class="read-aloud-bar" role="region" aria-label="Read aloud">
        <Volume2 size={14} class="read-aloud-icon" classList={{ live: playing() }} />
        <div class="read-aloud-title">
          <span class="read-aloud-scene" title={name()}>{name()}</span>
          <Show
            when={error()}
            fallback={<span class="read-aloud-status">{loading() ? "Preparing…" : playing() ? "Reading" : "Paused"}</span>}
          >
            <span class="read-aloud-status read-aloud-error" title={error()!}>{error()}</span>
          </Show>
        </div>
        <IconButton label="Previous paragraph" onClick={previous}><SkipBack size={14} /></IconButton>
        <IconButton label={playing() || loading() ? "Pause" : error() ? "Try again" : "Play"} class="read-aloud-play" onClick={toggle}>
          <Show when={playing() || loading()} fallback={<Play size={15} />}><Pause size={15} /></Show>
        </IconButton>
        <IconButton label="Next paragraph" onClick={next}><SkipForward size={14} /></IconButton>
        <select
          class="read-aloud-rate"
          aria-label="Playback speed"
          title="Playback speed"
          value={String(rate())}
          onChange={(e) => setRate(parseFloat(e.currentTarget.value))}
        >
          <For each={RATES}>{(r) => <option value={String(r)}>{r}×</option>}</For>
        </select>
        <IconButton label="Stop reading" onClick={stop}><Square size={13} /></IconButton>
      </div>
    </Show>
  );
};
