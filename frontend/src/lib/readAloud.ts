import { createSignal } from "solid-js";
import { invoke } from "./rpc";

// Read aloud: one module-level player. The caller hands over the scene's
// paragraphs (path + 1-based line + raw markdown); this strips the markup,
// fetches audio a paragraph at a time from the backend (which caches it per
// project, so re-listening is free), prefetches ahead so there are no gaps,
// and exposes what's being read so the editor can highlight it.

export interface ReadAloudItem {
  path: string;
  line: number;
  text: string;
}

export interface ReadingPosition {
  path: string;
  line: number;
  /** Index into the items passed to `startReading`. */
  index: number;
}

/** Paragraphs fetched ahead of the one playing. */
const PREFETCH = 2;
const RATE_KEY = "chronicler.readAloud.rate";
export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

const [reading, setReading] = createSignal<ReadingPosition | null>(null);
const [playing, setPlaying] = createSignal(false);
/** Fetching the current paragraph's audio. */
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [rate, setRateSignal] = createSignal(loadRate());

export { reading, playing, loading, error, rate };

function loadRate(): number {
  try {
    const r = parseFloat(localStorage.getItem(RATE_KEY) ?? "");
    return Number.isFinite(r) && r >= 0.5 && r <= 3 ? r : 1;
  } catch {
    return 1;
  }
}

/** Playback speed (applied locally, no re-synthesis). */
export function setRate(r: number) {
  setRateSignal(r);
  if (audio) audio.playbackRate = r;
  try {
    localStorage.setItem(RATE_KEY, String(r));
  } catch { /* storage unavailable */ }
}

// ---- Markdown → speakable text ----

const SCENE_BREAK = /^\s*([*\-_#~=]\s*){3,}$/;

/** What a narrator would say for one markdown line/paragraph ("" = skip). */
export function speakable(raw: string): string {
  let t = raw.replace(/<!--[\s\S]*?-->/g, " "); // annotations
  if (/^\s*<!--/.test(t)) t = t.replace(/<!--[\s\S]*$/, " "); // unterminated
  t = t.replace(/<[^>]+>/g, " "); // stray HTML
  if (!t.trim() || SCENE_BREAK.test(t)) return "";
  t = t
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, "$1.") // headings: read once, as a sentence
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "") // list markers
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[target|label]]
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[wiki]]
    .replace(/\[\^[^\]]+\]/g, "") // footnote refs
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, "$1") // escapes, before the emphasis passes
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/gu, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/==(?=\S)([\s\S]*?\S)==/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // A heading ending in punctuation already doesn't need the added full stop.
  t = t.replace(/([.!?…:;,])\.$/u, "$1");
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

// ---- Player ----

interface Prepared extends ReadAloudItem {
  /** Index in the caller's items. */
  index: number;
  speech: string;
}

let queue: Prepared[] = [];
/** Position in `queue`. */
let cursor = -1;
/** Bumped on every start/stop/jump so stale async work bows out. */
let generation = 0;
let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
/** Audio fetches by queue position. */
const fetches = new Map<number, Promise<Blob>>();

/** A player element; only the one in `audio` drives the queue. */
function makeEl(): HTMLAudioElement {
  const el = new Audio();
  el.preload = "auto";
  el.addEventListener("ended", () => {
    if (el !== audio) return;
    if (cursor + 1 < queue.length) void playAt(cursor + 1);
    else finish();
  });
  el.addEventListener("pause", () => { if (el === audio) setPlaying(false); });
  el.addEventListener("play", () => { if (el === audio) setPlaying(true); });
  return el;
}

function player(): HTMLAudioElement {
  audio ??= makeEl();
  return audio;
}

/** The next paragraph, already loaded into its own element so it starts
 * the moment this one ends (no fetch-and-decode gap between paragraphs). */
let staged: { pos: number; el: HTMLAudioElement; url: string } | null = null;

function unstage() {
  if (!staged) return;
  staged.el.removeAttribute("src");
  URL.revokeObjectURL(staged.url);
  staged = null;
}

function stage(pos: number) {
  if (pos >= queue.length || staged?.pos === pos) return;
  const gen = generation;
  void fetchAudio(pos).then((blob) => {
    if (gen !== generation || cursor + 1 !== pos) return;
    unstage();
    const el = makeEl();
    const url = URL.createObjectURL(blob);
    el.src = url;
    el.load();
    staged = { pos, el, url };
  }, () => {});
}

function base64ToBlob(b64: string, mime = "audio/mpeg"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function fetchAudio(pos: number): Promise<Blob> {
  let p = fetches.get(pos);
  if (!p) {
    p = invoke("tts/speak", { text: queue[pos].speech }).then((r) => base64ToBlob(r.audio, r.mime));
    // Don't keep a failure around: a retry should ask again.
    p.catch(() => fetches.delete(pos));
    fetches.set(pos, p);
  }
  return p;
}

function prefetch(from: number) {
  for (let i = from + 1; i <= from + PREFETCH && i < queue.length; i++) void fetchAudio(i).catch(() => {});
  // Forget audio well behind us.
  for (const k of fetches.keys()) if (k < from - 1 || k > from + PREFETCH) fetches.delete(k);
}

function releaseUrl() {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

async function playAt(pos: number) {
  const gen = ++generation;
  cursor = pos;
  const item = queue[pos];
  setReading({ path: item.path, line: item.line, index: item.index });
  setError(null);
  audio?.pause();
  releaseUrl();
  prefetch(pos);
  // Already loaded: swap it in and play straight away.
  if (staged?.pos === pos) {
    const next = staged;
    staged = null;
    audio?.removeAttribute("src");
    audio = next.el;
    currentUrl = next.url;
    setLoading(false);
    await startPlayback(gen);
    stage(pos + 1);
    return;
  }
  unstage();
  const el = player();
  setLoading(true);
  let blob: Blob;
  try {
    blob = await fetchAudio(pos);
  } catch (err) {
    if (gen !== generation) return;
    setLoading(false);
    setPlaying(false);
    setError(err instanceof Error ? err.message : String(err));
    return;
  }
  if (gen !== generation) return;
  setLoading(false);
  currentUrl = URL.createObjectURL(blob);
  el.src = currentUrl;
  await startPlayback(gen);
  stage(pos + 1);
}

async function startPlayback(gen: number) {
  const el = player();
  el.playbackRate = rate();
  try {
    await el.play();
  } catch (err) {
    if (gen !== generation) return;
    setPlaying(false);
    setError(`Couldn't play the audio: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function finish() {
  generation++;
  unstage();
  audio?.pause();
  audio?.removeAttribute("src");
  releaseUrl();
  fetches.clear();
  queue = [];
  cursor = -1;
  setReading(null);
  setPlaying(false);
  setLoading(false);
}

/**
 * Read `items` aloud from `from` (an index into `items`; if that item has
 * nothing speakable, the next one that does). Replaces anything playing.
 */
export function startReading(items: ReadAloudItem[], from = 0) {
  finish();
  setError(null);
  queue = items
    .map((it, index) => ({ ...it, index, speech: speakable(it.text) }))
    .filter((it) => it.index >= 0 && it.speech);
  const start = queue.findIndex((it) => it.index >= from);
  if (start < 0) {
    queue = [];
    setError("Nothing to read here.");
    return;
  }
  void playAt(start);
}

export function pause() {
  // Pausing while the first fetch is in flight cancels the auto-play.
  if (loading()) generation++;
  setLoading(false);
  audio?.pause();
}

export function resume() {
  if (cursor < 0) return;
  if (audio && currentUrl && !error()) {
    void audio.play().catch((err) => setError(String(err)));
  } else {
    void playAt(cursor); // retry after an error, or a pause mid-fetch
  }
}

export function toggle() {
  if (playing() || loading()) pause();
  else resume();
}

export function stop() {
  finish();
  setError(null);
}

export function next() {
  if (cursor < 0) return;
  if (cursor + 1 < queue.length) void playAt(cursor + 1);
  else finish();
}

/** Back one paragraph; a few seconds into this one, restart it instead. */
export function previous() {
  if (cursor < 0) return;
  if (audio && audio.currentTime > 3 && !loading()) {
    audio.currentTime = 0;
    if (!playing()) void audio.play().catch(() => {});
    return;
  }
  void playAt(Math.max(0, cursor - 1));
}

/** Play a short sample of `text` with the current settings, or with
 * `voice` instead of the configured one (Settings previews). */
export async function sample(text: string, voice?: string): Promise<void> {
  const r = await invoke("tts/speak", voice ? { text, voice } : { text });
  await playUrlOnce(URL.createObjectURL(base64ToBlob(r.audio, r.mime)), true);
}

let previewEl: HTMLAudioElement | null = null;
/** Play a clip once (a provider's preview URL, or a blob URL we own and
 * revoke after). Rejects when it can't start playing. */
export function playUrlOnce(url: string, revoke = false): Promise<void> {
  previewEl?.pause();
  const el = new Audio(url);
  previewEl = el;
  const done = () => {
    if (revoke) URL.revokeObjectURL(url);
  };
  el.addEventListener("ended", done, { once: true });
  el.addEventListener("error", done, { once: true });
  return el.play().catch((err) => {
    done();
    throw err;
  });
}

export function stopPreview() {
  previewEl?.pause();
  previewEl = null;
}
