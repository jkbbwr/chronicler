import { createSignal } from "solid-js";

export interface Command {
  id: string;
  title: string;
  /** e.g. "Mod+Shift+P" — Mod is Cmd on macOS, Ctrl elsewhere */
  keybinding?: string;
  /** Hidden commands (e.g. Go to Tab 3) don't clutter the palette */
  hidden?: boolean;
  run: () => void;
}

const [commands, setCommands] = createSignal<Command[]>([]);

/** Reactive list of registered commands, for the palette. */
export const commandList = () => commands().filter(c => !c.hidden);

export function registerCommands(cmds: Command[]) {
  setCommands(prev => [...prev.filter(c => !cmds.some(n => n.id === c.id)), ...cmds]);
}

export function runCommand(id: string) {
  commands().find(c => c.id === id)?.run();
}

const isMac = navigator.platform.toLowerCase().includes("mac");

export function formatKeybinding(binding: string): string {
  return binding
    .replace(/Mod/g, isMac ? "Cmd" : "Ctrl")
    .replace(/\+/g, " + ");
}

function bindingMatches(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map(m => m.toLowerCase());

  const wantMod = mods.includes("mod");
  const expectMeta = isMac ? wantMod : false;
  const expectCtrl = mods.includes("ctrl") || (!isMac && wantMod);

  if (e.metaKey !== expectMeta) return false;
  if (e.ctrlKey !== expectCtrl) return false;
  if (e.shiftKey !== mods.includes("shift")) return false;
  if (e.altKey !== mods.includes("alt")) return false;

  return e.key.toLowerCase() === key;
}

/** Find the registered command matching a keyboard event, if any. */
export function matchKeybinding(e: KeyboardEvent): Command | undefined {
  return commands().find(c => c.keybinding && bindingMatches(c.keybinding, e));
}
