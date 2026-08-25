import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import path from "node:path";
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
  projectIdx >= 0 ? args[projectIdx + 1] : process.env.PROJECT_DIR;

function rejectAllPending(reason: string) {
  for (const { reject } of pendingRequests.values()) {
    reject(new Error(reason));
  }
  pendingRequests.clear();
}

function setupMenu() {
  const isMac = process.platform === 'darwin';

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
        { label: 'New Project', click: () => mainWindow?.webContents.send('menu-action', 'new-project') },
        { 
          label: 'Open Project...', 
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
            if (!result.canceled && result.filePaths.length > 0) {
              const newPath = result.filePaths[0];
              // Restart backend with new CWD
              startBackend(newPath);
              mainWindow?.webContents.send('menu-action', 'project-opened');
            }
          }, 
          accelerator: 'CmdOrCtrl+O' 
        },
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
        isMac ? { role: 'close' } : { role: 'quit' }
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
        { label: 'Command Palette', click: () => mainWindow?.webContents.send('menu-action', 'command-palette'), accelerator: 'CmdOrCtrl+P' },
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
    },
  });

  mainWindow.maximize();

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  setupMenu();
  startBackend();
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
