import { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog, shell, safeStorage, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("Chronicler");

let mainWindow: BrowserWindow | null = null;
let rustProcess: ChildProcess | null = null;

// Simple Map to keep track of JSON-RPC promises
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
let nextRequestId = 1;

// Parse CLI flags (e.g. `--project /path/to/folder`)
const args = process.argv.slice(2);
const projectIdx = args.indexOf("--project");
// The most recently opened project; backend restarts (e.g. from the dev
// watcher) must reuse it rather than falling back to the default cwd.
let currentProjectPath: string | undefined =
  projectIdx >= 0 ? args[projectIdx + 1] : undefined;

// Expose CDP in dev so tools can attach to the renderer (9222 is often taken by Chrome)
// GUI apps launch with a minimal PATH; the backend shells out to `typst`
// for compile, so make sure the usual install locations are reachable.
if (app.isPackaged && process.platform === "darwin") {
  process.env.PATH = `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
}

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}

function rejectAllPending(reason: string) {
  for (const { reject } of pendingRequests.values()) {
    reject(new Error(reason));
  }
  pendingRequests.clear();
}

// ---- Research files ----
// Images and PDFs in the project's Research/ folder are shown in the
// renderer through `chronicler-research://project/<path inside Research>`.
// Only that folder, only image and PDF types, never a symlink out of it.

const RESEARCH_SCHEME = "chronicler-research";
const RESEARCH_DIR = "Research";
const RESEARCH_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

// Before `ready`: a secure, standard scheme so <img> and the built-in PDF
// viewer (in an iframe) can load from it.
protocol.registerSchemesAsPrivileged([
  { scheme: RESEARCH_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** The open project's Research/ folder, if it is a real folder. */
async function researchDir(): Promise<string | null> {
  if (!currentProjectPath) return null;
  const dir = path.join(path.resolve(currentProjectPath), RESEARCH_DIR);
  try {
    const st = await fs.promises.lstat(dir);
    return st.isDirectory() ? await fs.promises.realpath(dir) : null;
  } catch {
    return null;
  }
}

async function serveResearch(request: Request): Promise<Response> {
  const refuse = (status = 404) => new Response(null, { status });
  const dir = await researchDir();
  if (!dir) return refuse();
  let rel: string;
  try {
    const url = new URL(request.url);
    if (url.host !== "project") return refuse();
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return refuse();
  }
  const parts = rel.split(/[\\/]/);
  if (!rel || parts.some((p) => p === "" || p === ".." || p.startsWith("."))) return refuse();
  const type = RESEARCH_TYPES[path.extname(rel).slice(1).toLowerCase()];
  if (!type) return refuse(403);
  try {
    const real = await fs.promises.realpath(path.resolve(dir, ...parts));
    if (!real.startsWith(dir + path.sep)) return refuse();
    const st = await fs.promises.stat(real);
    if (!st.isFile()) return refuse();
    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(st.size),
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    };
    // An SVG opened on its own must not run anything.
    if (type === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
    const body = Readable.toWeb(fs.createReadStream(real)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { headers });
  } catch {
    return refuse();
  }
}

/** A file name that is visible (no leading dot) and free in `dir`. */
function freeName(dir: string, base: string): string {
  const clean = base.replace(/^\.+/, "").trim() || "Untitled";
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length) || "Untitled";
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

/**
 * Add files to Research/: main shows the open dialog and copies what the
 * writer picked (never overwriting). Returns the new project-relative paths.
 */
async function researchImport(): Promise<{ paths: string[]; errors: string[] }> {
  if (!currentProjectPath || !mainWindow) return { paths: [], errors: ["No project open."] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add to Research",
    buttonLabel: "Add",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images, PDFs and notes", extensions: [...Object.keys(RESEARCH_TYPES), "md", "markdown", "txt"] },
      { name: "Images", extensions: Object.keys(RESEARCH_TYPES).filter((e) => e !== "pdf") },
      { name: "PDFs", extensions: ["pdf"] },
      { name: "Text and Markdown", extensions: ["md", "markdown", "txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return { paths: [], errors: [] };
  const root = path.resolve(currentProjectPath);
  const dir = path.join(root, RESEARCH_DIR);
  try {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return { paths: [], errors: ["The Research folder isn't a normal folder."] };
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    return { paths: [], errors: [err.message] };
  }
  const paths: string[] = [];
  const errors: string[] = [];
  for (const source of result.filePaths) {
    try {
      if (!fs.statSync(source).isFile()) continue;
      const name = freeName(dir, path.basename(source));
      await fs.promises.copyFile(source, path.join(dir, name), fs.constants.COPYFILE_EXCL);
      paths.push(`${RESEARCH_DIR}/${name}`);
    } catch (err: any) {
      errors.push(`${path.basename(source)}: ${err.message}`);
    }
  }
  return { paths, errors };
}

// ---- Renderer confinement ----
// The renderer only ever shows the app itself: no in-app navigation, no new
// windows, and IPC answers only frames that are showing the app.

/** Is `url` the app's own page (dev server in dev, the built index.html otherwise)? */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer) return u.origin === new URL(devServer).origin;
    return (
      u.protocol === "file:" &&
      path.resolve(fileURLToPath(u)) === path.resolve(__dirname, "../dist/index.html")
    );
  } catch {
    return false;
  }
}

/** Hand web links to the OS browser; everything else is dropped. */
function openExternalSafe(url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
  } catch {
    // not a URL: ignore
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

/** `ipcMain.handle`, answering only the app's own frames. */
function handle(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url)) {
      throw new Error(`Refusing ${channel} from an untrusted frame`);
    }
    return listener(event, ...args);
  });
}

// ---- AI API key: encrypted at rest with the OS keychain, held in memory
// by the backend only. Re-sent whenever the backend (re)starts. ----

const aiKeyFile = () => path.join(app.getPath("userData"), "ai-key.enc");

function storeAiKey(key: string) {
  try {
    if (!key) {
      fs.rmSync(aiKeyFile(), { force: true });
      return;
    }
    fs.writeFileSync(aiKeyFile(), safeStorage.encryptString(key));
  } catch (err) {
    console.error("Failed to store AI key:", err);
  }
}

function loadAiKey(): string {
  try {
    return safeStorage.decryptString(fs.readFileSync(aiKeyFile()));
  } catch {
    return "";
  }
}

function sendAiKeyToBackend() {
  // An empty key must reach the backend too, or clearing only takes
  // effect after the next restart.
  const key = loadAiKey();
  if (!rustProcess?.stdin) return;
  const request = { jsonrpc: "2.0", id: nextRequestId++, method: "ai/set_key", params: { key } };
  rustProcess.stdin.write(JSON.stringify(request) + "\n");
}

// ---- Recent projects (IntelliJ-style welcome screen state) ----

interface RecentEntry { path: string; openedAt: string }
interface Recents { last: string | null; projects: RecentEntry[] }

const recentsFile = () => path.join(app.getPath("userData"), "recent-projects.json");

function loadRecents(): Recents {
  try {
    return JSON.parse(fs.readFileSync(recentsFile(), "utf8"));
  } catch {
    // One-time migration from before the app was named (userData was "frontend")
    try {
      const legacy = path.join(app.getPath("userData"), "..", "frontend", "recent-projects.json");
      const recents = JSON.parse(fs.readFileSync(legacy, "utf8"));
      saveRecents(recents);
      return recents;
    } catch {
      return { last: null, projects: [] };
    }
  }
}

function saveRecents(recents: Recents) {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(recents, null, 2));
  } catch (err) {
    console.error("Failed to save recent projects:", err);
  }
}

function openProject(projectPath: string) {
  // Before setupMenu(), which disables the project-scoped items when this is
  // unset — startBackend() would otherwise set it a beat too late.
  currentProjectPath = projectPath;

  const recents = loadRecents();
  recents.projects = [
    { path: projectPath, openedAt: new Date().toISOString() },
    ...recents.projects.filter(p => p.path !== projectPath),
  ].slice(0, 10);
  recents.last = projectPath;
  saveRecents(recents);
  setupMenu(); // keep the Open Recent submenu current

  startBackend(projectPath);
  mainWindow?.webContents.send("menu-action", "project-opened");
}

/**
 * The inverse of openProject: no project open, no backend running, and
 * nothing for the next launch to reopen — so the welcome screen, which is
 * only reachable with `last` unset, is where both this session and the next
 * one land.
 */
function closeProject() {
  currentProjectPath = undefined;
  const recents = loadRecents();
  recents.last = null;
  saveRecents(recents);
  setupMenu(); // the File menu's project-scoped items are now disabled

  if (rustProcess) {
    rejectAllPending("Project closed");
    rustProcess.kill();
    rustProcess = null;
  }
  mainWindow?.webContents.send("menu-action", "project-closed");
}

async function openProjectFlow() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    openProject(result.filePaths[0]);
  }
}

// New Project is a renderer modal (name + location), not a native save
// panel: save panels make the filename field the project folder, which
// reads as "it ignored the folder I picked".
const defaultProjectParent = () => {
  try {
    return app.getPath("documents");
  } catch {
    return app.getPath("home");
  }
};

/** Folders the writer picked in a native dialog this session. */
const chosenParents = new Set<string>();

async function chooseProjectParent(): Promise<string | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Project Location",
    buttonLabel: "Choose",
    defaultPath: defaultProjectParent(),
    properties: ["openDirectory", "createDirectory"],
  });
  const chosen = result.canceled ? null : result.filePaths[0] ?? null;
  if (chosen) chosenParents.add(path.resolve(chosen));
  return chosen;
}

interface NewProjectOptions {
  name: string;
  author?: string;
  scaffold?: boolean;
  chapter?: string;
  scene?: string;
  targets?: { dailyTarget: number; projectTarget: number };
}

/**
 * A title makes a poor folder name ("Chapter 1: Ash / Ember"), so the folder
 * is a sanitized form of it and the full title lives in project.json.
 */
export function projectFolderName(rawName: string): string {
  return rawName
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

function createProjectIn(parent: string, opts: NewProjectOptions): { path?: string; error?: string } {
  // Only a location the writer actually picked (or the default) — never a
  // path the renderer made up.
  const resolvedParent = typeof parent === "string" ? path.resolve(parent) : "";
  if (resolvedParent !== path.resolve(defaultProjectParent()) && !chosenParents.has(resolvedParent)) {
    return { error: "Choose the project location first." };
  }
  parent = resolvedParent;
  const name = (opts?.name ?? "").trim();
  if (!name) return { error: "Give the project a name first." };
  const folder = projectFolderName(name);
  if (!folder) return { error: "That name has no characters a folder can use." };
  try {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      return { error: "That location no longer exists — choose another folder." };
    }
    const target = path.join(parent, folder);
    // An empty leftover folder is fine to adopt; a non-empty one is not ours
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      return { error: `"${folder}" already exists there and isn't empty.` };
    }
    fs.mkdirSync(target, { recursive: true });

    // The renderer reads this back on open: the binder header, the window
    // title, and the compile title page all come from it.
    fs.mkdirSync(path.join(target, ".chronicler"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".chronicler", "project.json"),
      JSON.stringify(
        {
          name,
          author: (opts.author ?? "").trim(),
          created: new Date().toISOString(),
          ...(opts.targets ? { targets: opts.targets } : {}),
        },
        null,
        2
      )
    );

    if (opts.scaffold) {
      // Numbered chapter folders with numbered scene files is the binder's
      // ordering convention — seed the first of each before the backend scans
      const chapterTitle = projectFolderName(opts.chapter || "") || "Chapter One";
      const sceneTitle = projectFolderName(opts.scene || "") || "First Scene";
      const chapter = path.join(target, `01 ${chapterTitle}`);
      fs.mkdirSync(chapter, { recursive: true });
      fs.writeFileSync(path.join(chapter, `01 ${sceneTitle}.md`), `# ${sceneTitle}\n\n`);
    }
    openProject(target);
    return { path: target };
  } catch (err: any) {
    return { error: err.message };
  }
}

/**
 * Reveal a project-relative path in the OS file manager (the project root
 * itself when `relPath` is empty). Confined to the open project so the
 * renderer can't point it at arbitrary paths.
 */
function revealInFileManager(relPath?: string): { error?: string } {
  if (!currentProjectPath) return { error: "No project open." };
  const root = path.resolve(currentProjectPath);
  const target = relPath ? path.resolve(root, relPath) : root;
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: "That path is outside the project." };
  }
  if (!fs.existsSync(target)) return { error: "That item no longer exists on disk." };
  // Selecting the root inside its parent is disorienting — open it instead
  if (target === root) shell.openPath(target);
  else shell.showItemInFolder(target);
  return {};
}

function setupMenu() {
  const isMac = process.platform === 'darwin';

  const recents = loadRecents().projects.filter(p => fs.existsSync(p.path));
  const recentSubmenu: any[] = recents.length > 0
    ? [
        ...recents.map(p => ({
          label: p.path.replace(/^\/Users\/[^/]+/, "~"),
          click: () => openProject(p.path),
        })),
        { type: 'separator' },
        {
          label: 'Clear Recently Opened',
          click: () => {
            saveRecents({ last: null, projects: [] });
            setupMenu();
          },
        },
      ]
    : [{ label: 'No Recent Projects', enabled: false }];

  // Menu items run renderer commands by id, so menus, the palette and
  // shortcuts share one implementation. Editor keys (⌘B, ⌘I, ⌘F, ⌘Z) are left
  // to the editor.
  const cmd = (id: string) => () => mainWindow?.webContents.send('menu-action', `command:${id}`);
  const item = (label: string, id: string, accelerator?: string, enabled = true) => ({ label, click: cmd(id), accelerator, enabled });
  const hasProject = !!currentProjectPath;

  const template: any = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            item('Settings…', 'view.settings', 'CmdOrCtrl+,'),
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', click: () => mainWindow?.webContents.send('menu-action', 'new-project') },
        { label: 'Open Project…', click: () => openProjectFlow(), accelerator: 'CmdOrCtrl+O' },
        { label: 'Open Recent', submenu: recentSubmenu },
        {
          label: 'Close Project',
          enabled: hasProject,
          click: () => mainWindow?.webContents.send('menu-action', 'close-project-requested'),
        },
        { type: 'separator' },
        item('New Scene', 'file.newScene', 'CmdOrCtrl+N', hasProject),
        item('New Chapter Folder', 'file.newFolder', 'CmdOrCtrl+Shift+N', hasProject),
        item('Save', 'file.save', 'CmdOrCtrl+S', hasProject),
        item('Lock In This Version…', 'file.lockIn', 'CmdOrCtrl+Shift+S', hasProject),
        { type: 'separator' },
        item('Compile Manuscript…', 'file.compile', 'CmdOrCtrl+Shift+E', hasProject),
        {
          label: isMac ? 'Reveal Project in Finder' : 'Show Project in File Explorer',
          enabled: hasProject,
          click: () => revealInFileManager(),
        },
        { type: 'separator' },
        isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Search the Manuscript', 'view.search', 'CmdOrCtrl+Shift+F', hasProject),
        item('Add Margin Note', 'editor.annotate', 'CmdOrCtrl+Shift+A', hasProject),
        item('Add Selection to Codex', 'codex.promote', 'CmdOrCtrl+Shift+K', hasProject),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Write', 'mode.write', 'CmdOrCtrl+1', hasProject),
        item('Plan', 'mode.plan', 'CmdOrCtrl+2', hasProject),
        item('Review', 'mode.review', 'CmdOrCtrl+3', hasProject),
        item('Codex', 'mode.codex', 'CmdOrCtrl+4', hasProject),
        { type: 'separator' },
        item('Binder', 'view.binder', 'CmdOrCtrl+[', hasProject),
        item('Inspector', 'view.inspector', 'CmdOrCtrl+]', hasProject),
        item('Scene Beside as Reference', 'view.reference', 'CmdOrCtrl+\\', hasProject),
        item('Zen', 'view.zen', 'CmdOrCtrl+Shift+Return', hasProject),
        item('Show Markdown', 'editor.markdown', 'CmdOrCtrl+Shift+M', hasProject),
        { type: 'separator' },
        item('Go to Scene…', 'view.quickOpen', 'CmdOrCtrl+P', hasProject),
        item('Commands…', 'view.commandPalette', 'CmdOrCtrl+K', hasProject),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    {
      label: 'Agent',
      submenu: [
        item('Ask the Agent', 'agent.open', 'CmdOrCtrl+J', hasProject),
        item('Ask About Selection', 'agent.ask', 'CmdOrCtrl+Shift+J', hasProject),
        { type: 'separator' },
        item('Check Continuity in This Scene', 'agent.continuityScene', undefined, hasProject),
        item('Check Continuity Across the Book…', 'agent.continuity', undefined, hasProject),
        item('Reading Critique…', 'agent.critique', undefined, hasProject),
        { type: 'separator' },
        item('Update Fact Ledger', 'agent.ledger', undefined, hasProject),
        item('Draft Missing Synopses', 'agent.synopses', undefined, hasProject),
        item('Check the Codex', 'agent.hygiene', undefined, hasProject),
        { type: 'separator' },
        item('AI Settings…', 'view.settingsAi'),
      ],
    },
    {
      role: 'help',
      submenu: [item('Keyboard Shortcuts', 'view.shortcuts', 'CmdOrCtrl+/')],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function startBackend(projectPath?: string) {
  if (projectPath) currentProjectPath = projectPath;

  if (rustProcess) {
    console.log("Restarting Rust backend...");
    rejectAllPending("Backend restarting");
    rustProcess.kill();
  }

  const isDev = !app.isPackaged;
  const cwd = currentProjectPath || (isDev ? path.join(__dirname, "../../") : process.cwd());

  if (isDev) {
    rustProcess = spawn("cargo", ["run", "--manifest-path", path.join(__dirname, "../../backend/Cargo.toml")], {
      cwd: cwd,
    });
  } else {
    const binaryPath = path.join(process.resourcesPath, "chronicler-backend");
    rustProcess = spawn(binaryPath, [], { cwd: cwd });
  }

  const proc = rustProcess;

  rustProcess.stderr?.on("data", (data) => {
    console.log(`[Rust] ${data}`);
  });

  if (rustProcess.stdout) {
    const rl = createInterface({ input: rustProcess.stdout });
    rl.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id !== undefined && pendingRequests.has(response.id)) {
          const { resolve, reject } = pendingRequests.get(response.id)!;
          pendingRequests.delete(response.id);
          
          if (response.error) {
            reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            resolve(response.result);
          }
        } else if (response.method) {
          mainWindow?.webContents.send("backend-event", response);
        }
      } catch (err) {
        // Ignored: Non-JSON output from Rust
      }
    });
  }

  sendAiKeyToBackend();

  rustProcess.on("exit", (code) => {
    console.log(`Backend process exited with code ${code}`);
    // Only reject if this is still the live process; a superseded process
    // exiting after a restart must not kill the new process's requests.
    if (rustProcess === proc) {
      rejectAllPending(`Backend exited with code ${code}`);
    }
  });
}

function watchRustBackend() {
  if (app.isPackaged) return;
  import("chokidar").then(({ watch }) => {
    // chokidar v4+ dropped glob support: watch the directory and filter
    const watcher = watch(path.join(__dirname, "../../backend/src"), {
      ignoreInitial: true,
    });
    let restartTimer: NodeJS.Timeout | undefined;
    watcher.on("all", (_event, file) => {
      if (!file.endsWith(".rs")) return;
      // Only restart if a project is actually open (not on the welcome screen)
      if (!currentProjectPath) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        startBackend();
        mainWindow?.webContents.send("backend-event", { method: "system/recompiling" });
      }, 300);
    });
  });
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hiddenInset", // MacOS VS Code style frameless window
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // Chronicler's own diagnostics engine owns spellcheck squiggles
      spellcheck: false,
      // Chromium's built-in PDF viewer, for Research PDFs (CSP keeps
      // object/embed off; only chronicler-research: frames may load).
      plugins: true,
    },
  });

  mainWindow.maximize();

  // Spellcheck suggestions on right-click, plus standard edit actions in
  // editable areas. The app's own HTML context menus call preventDefault,
  // which suppresses this event, so the two never fight.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = new Menu();
    const selection = params.selectionText.trim();
    if (selection) {
      menu.append(new MenuItem({
        label: "Ask Agent About Selection",
        click: () => mainWindow?.webContents.send("menu-action", "ask-agent-selection"),
      }));
    }
    if (selection && selection.length <= 80) {
      menu.append(new MenuItem({
        label: `Promote “${selection.length > 30 ? selection.slice(0, 30) + "…" : selection}” to Codex`,
        click: () => mainWindow?.webContents.send("menu-action", `codex-promote:${selection}`),
      }));
    }
    if (selection) {
      menu.append(new MenuItem({ type: "separator" }));
    }
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
      }));
    }
    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: "Add to Dictionary",
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: "separator" }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: "cut" }));
      menu.append(new MenuItem({ role: "copy" }));
      menu.append(new MenuItem({ role: "paste" }));
    }
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    // Opt-in; View › Toggle Developer Tools is always there in dev.
    if (process.env.CHRONICLER_DEVTOOLS) mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  protocol.handle(RESEARCH_SCHEME, serveResearch);
  setupMenu();

  // Resolve the startup project: explicit flag/env wins, then the last opened
  // project; with neither, the renderer shows the welcome screen instead.
  if (currentProjectPath && fs.existsSync(currentProjectPath)) {
    openProject(currentProjectPath);
  } else {
    currentProjectPath = undefined;
    const recents = loadRecents();
    if (recents.last && fs.existsSync(recents.last)) {
      openProject(recents.last);
    }
  }

  watchRustBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (rustProcess) {
    rustProcess.kill();
  }
});

// Welcome screen state and actions
handle("get-project", () => ({
  path: currentProjectPath ?? null,
  recents: loadRecents().projects.filter(p => fs.existsSync(p.path)),
}));

handle("open-project", async (_event, projectPath?: string) => {
  if (projectPath) {
    // Only projects the writer opened before; new ones go through the dialog.
    const known = loadRecents().projects.some(p => p.path === projectPath);
    if (known && fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) {
      openProject(projectPath);
    }
    return;
  }
  await openProjectFlow();
});

handle("default-project-parent", () => defaultProjectParent());
handle("choose-project-parent", () => chooseProjectParent());
handle("create-project-in", (_event, parent: string, opts: NewProjectOptions) => createProjectIn(parent, opts));
handle("reveal-in-file-manager", (_event, relPath?: string) =>
  revealInFileManager(typeof relPath === "string" ? relPath : undefined)
);
// The renderer calls this once it has flushed the session it is about to lose
handle("close-project", () => closeProject());
handle("research-import", () => researchImport());

handle("ai-store-key", (_event, key: string) => {
  if (typeof key !== "string") throw new Error("key must be a string");
  // Length-only breadcrumb so key lifecycle is traceable without leaking it
  console.log(key ? `AI key stored (${key.length} chars)` : "AI key cleared");
  storeAiKey(key);
  sendAiKeyToBackend();
  return { stored: !!key };
});

handle("remove-recent", (_event, projectPath: string) => {
  const recents = loadRecents();
  recents.projects = recents.projects.filter(p => p.path !== projectPath);
  if (recents.last === projectPath) {
    // Don't auto-reopen a project the user explicitly removed
    recents.last = null;
  }
  saveRecents(recents);
  setupMenu();
  return recents.projects.filter(p => fs.existsSync(p.path));
});

/**
 * Compile export: the backend only writes inside `<project>/.chronicler/build/`;
 * choosing the destination (a native dialog, here in main) and copying the
 * artifact out is the main process's job. The renderer names the artifact,
 * never the destination.
 */
handle("export-compiled", async (_event, source: string, options?: { defaultName?: string }) => {
  if (!currentProjectPath || !mainWindow) throw new Error("No project open");
  const buildDir = path.resolve(currentProjectPath, ".chronicler", "build");
  const src = typeof source === "string" ? path.resolve(buildDir, source) : "";
  if (!src.startsWith(buildDir + path.sep) || !fs.existsSync(src)) {
    throw new Error("Refusing to export a file that isn't a compiled manuscript");
  }
  const ext = path.extname(src).slice(1);
  const defaultName =
    typeof options?.defaultName === "string" && options.defaultName.trim()
      ? path.basename(options.defaultName.trim())
      : path.basename(src);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Manuscript",
    defaultPath: path.join(app.getPath("documents"), defaultName),
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.copyFile(src, result.filePath);
  shell.showItemInFolder(result.filePath);
  return { canceled: false, path: result.filePath };
});

// Native message boxes (three-way save prompts, destructive confirms, errors)
handle("show-message-box", async (_event, options: Electron.MessageBoxOptions) => {
  if (!mainWindow) return { response: options?.cancelId ?? 0 };
  return dialog.showMessageBox(mainWindow, options);
});

// Expose invoke handler for renderer
handle("rpc-invoke", async (_event, method: string, params: any) => {
  if (typeof method !== "string") throw new Error("method must be a string");
  return new Promise((resolve, reject) => {
    if (!rustProcess || !rustProcess.stdin) {
      return reject(new Error("Backend not running"));
    }

    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });

    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };

    rustProcess.stdin.write(JSON.stringify(request) + "\n");
  });
});
