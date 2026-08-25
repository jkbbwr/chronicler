import { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}

function rejectAllPending(reason: string) {
  for (const { reject } of pendingRequests.values()) {
    reject(new Error(reason));
  }
  pendingRequests.clear();
}

// ---- Recent projects (IntelliJ-style welcome screen state) ----

interface RecentEntry { path: string; openedAt: string }
interface Recents { last: string | null; projects: RecentEntry[] }

const recentsFile = () => path.join(app.getPath("userData"), "recent-projects.json");

function loadRecents(): Recents {
  try {
    return JSON.parse(fs.readFileSync(recentsFile(), "utf8"));
  } catch {
    return { last: null, projects: [] };
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

async function openProjectFlow() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    openProject(result.filePaths[0]);
  }
}

async function createProjectFlow() {
  if (!mainWindow) return;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Create Project",
    buttonLabel: "Create",
    nameFieldLabel: "Project name",
  });
  if (!result.canceled && result.filePath) {
    fs.mkdirSync(result.filePath, { recursive: true });
    openProject(result.filePath);
  }
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

  const template: any = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Preferences...', click: () => mainWindow?.webContents.send('menu-action', 'open-settings'), accelerator: 'CmdOrCtrl+,' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project...', click: () => createProjectFlow() },
        { label: 'Open Project...', click: () => openProjectFlow(), accelerator: 'CmdOrCtrl+O' },
        { label: 'Open Recent', submenu: recentSubmenu },
        { type: 'separator' },
        { label: 'New File', click: () => mainWindow?.webContents.send('menu-action', 'new-file'), accelerator: 'CmdOrCtrl+N' },
        { label: 'New Folder', click: () => mainWindow?.webContents.send('menu-action', 'new-folder'), accelerator: 'CmdOrCtrl+Shift+N' },
        { label: 'Save', click: () => mainWindow?.webContents.send('menu-action', 'save-file'), accelerator: 'CmdOrCtrl+S' },
        { 
          label: 'Save As...', 
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow!, {
              title: 'Save As',
              filters: [{ name: 'Markdown', extensions: ['md'] }]
            });
            if (!result.canceled && result.filePath) {
              mainWindow?.webContents.send('menu-action', `save-as:${result.filePath}`);
            }
          }, 
          accelerator: 'CmdOrCtrl+Shift+S' 
        },
        { type: 'separator' },
        { label: 'Close Tab', click: () => mainWindow?.webContents.send('menu-action', 'close-tab'), accelerator: 'CmdOrCtrl+W' },
        isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Go to File...', click: () => mainWindow?.webContents.send('menu-action', 'quick-open'), accelerator: 'CmdOrCtrl+P' },
        { label: 'Command Palette', click: () => mainWindow?.webContents.send('menu-action', 'command-palette'), accelerator: 'CmdOrCtrl+Shift+P' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
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
    const watcher = watch(path.join(__dirname, "../../backend/src/**/*.rs"), {
      ignoreInitial: true,
    });
    watcher.on("all", () => {
      // Only restart if a project is actually open (not on the welcome screen)
      if (!currentProjectPath) return;
      startBackend();
      // Optionally notify frontend that backend is recompiling
      mainWindow?.webContents.send("backend-event", { method: "system/recompiling" });
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
      spellcheck: true,
    },
  });

  mainWindow.maximize();

  // Spellcheck suggestions on right-click, plus standard edit actions in
  // editable areas. The app's own HTML context menus call preventDefault,
  // which suppresses this event, so the two never fight.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = new Menu();
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
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
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
ipcMain.handle("get-project", () => ({
  path: currentProjectPath ?? null,
  recents: loadRecents().projects.filter(p => fs.existsSync(p.path)),
}));

ipcMain.handle("open-project", async (_event, projectPath?: string) => {
  if (projectPath) {
    if (fs.existsSync(projectPath)) openProject(projectPath);
    return;
  }
  await openProjectFlow();
});

ipcMain.handle("create-project", () => createProjectFlow());

ipcMain.handle("remove-recent", (_event, projectPath: string) => {
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

// Native message boxes (three-way save prompts, destructive confirms, errors)
ipcMain.handle("show-message-box", async (_event, options: Electron.MessageBoxOptions) => {
  if (!mainWindow) return { response: options.cancelId ?? 0 };
  return dialog.showMessageBox(mainWindow, options);
});

// Expose invoke handler for renderer
ipcMain.handle("rpc-invoke", async (event, method: string, params: any) => {
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
      params: params || {},
    };

    rustProcess.stdin.write(JSON.stringify(request) + "\n");
  });
});
