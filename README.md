# Chronicler

A desktop app for writing novels, laid out like a code editor.

A book is a folder of Markdown files, one per scene, with a folder per
chapter. Chronicler keeps its own data in `.chronicler/` and the version
history in `.jj/`, both inside the book's folder, so the scenes can still be
opened in any text editor.

## What it does

The app has four modes.

Write is the editor. It shows one scene or a whole chapter at once, and has
margin notes, per-scene word targets, a sprint timer, typewriter scrolling and
read-aloud.

Plan has index cards, plot threads (which scenes carry which thread, and how
the point of view is split), a story timeline, a relationship graph and a
ledger of facts established so far.

Review collects spelling, grammar and style problems, margin notes to work
through, a report on repeated and overused words and sentence rhythm across
the book, version history and critique.

Codex holds characters, places, items and so on, and tracks where each is
mentioned. New names found in the text wait in an inbox until you add them.
Renaming an entry can change the name in the text as well.

A Research folder holds reference material: files, images, PDFs, saved web
pages and notes. It isn't compiled, counted or spell-checked.

### AI

AI features are optional and go through one connection: OpenRouter, or any
OpenAI-compatible server (a local one works). They include a chat agent that
can read the manuscript and research, continuity checks against facts from
earlier scenes, synopses, critique, codex drafting, a "catch me up" briefing,
and read-aloud through the provider's speech models.

The agent never edits the manuscript. Models, per-task overrides and the chat
prompt are set in Settings → AI.

### History

Version history uses [jj](https://github.com/jj-vcs/jj), in a `.jj/` folder
inside the book (not colocated with git). Every save goes into the working
draft; "lock in" names it and starts a new one. You can see what changed in
each save or version, compare a version with the current draft, and restore a
scene or the whole book.

## Requirements

To use it:

- `jj` for history
- `typst` for compiling to PDF

Chronicler looks for both on your PATH and tells you if either is missing. On
macOS: `brew install jj typst`.

To build it:

- Rust (stable)
- [Bun](https://bun.sh)

## Running from source

```sh
bun install
bun run dev
```

That starts Vite, Electron and the Rust backend. Changes to the backend
restart it; changes to the frontend reload the window.

## Building

```sh
bun run package   # macOS .app in frontend/release/
bun run dist      # installers (.dmg/.zip on macOS)
bun run dist:linux
```

Builds are unsigned. On macOS, right-click the app and choose Open the first
time.

CI (`.github/workflows/build.yml`) runs the tests on every push and builds
macOS arm64 and Linux x64/arm64. Pushing a `v*` tag attaches the builds to a
GitHub release.

## Tests

```sh
bun run test          # both of the below
bun run test:backend  # cargo test
bun run test:unit     # frontend unit tests
```

The backend tests that touch history and PDF compiling need `jj` and `typst`
installed. AI features are tested against a mock server, so no credits are
spent.

## Layout

```
backend/    Rust backend. JSON-RPC over stdio: files, indexing, codex,
            diagnostics, history, compile, agents.
frontend/   Electron + SolidJS + CodeMirror 6.
scripts/    Build helpers.
```

The RPC surface is one table in `backend/src/rpc/mod.rs`. TypeScript types
for it are generated into `frontend/src/rpc.gen.ts`; regenerate them after
changing an endpoint:

```sh
cargo run --manifest-path backend/Cargo.toml --bin gen-bindings
```

A test fails if the generated file is out of date.

## Files and settings

- A book's own data: `<book>/.chronicler/`
- Its version history: `<book>/.jj/`
- App-wide settings (AI, read-aloud): `~/.config/chronicler/`
  (`CHRONICLER_CONFIG_DIR` overrides this)
- API keys are encrypted by the OS keychain through Electron and only held in
  memory by the backend.

## License

[PolyForm Shield 1.0.0](LICENSE.md). You can use Chronicler for anything,
including writing books you sell, and change it for your own use. You can't
use its code to offer a product that competes with it, paid or free. What
you write with it is yours.
