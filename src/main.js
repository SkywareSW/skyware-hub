const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, exec } = require('child_process');

let mainWindow;

// ─── Discord RPC ─────────────────────────────────────────────────────────────
let discordRpc = null;
let rpcReady = false;
let pendingPresence = null; // queued presence to set once ready

function initDiscordRPC() {
  try {
    const RPC = require('discord-rpc');
    const CLIENT_ID = '1481768218270896398';
    discordRpc = new RPC.Client({ transport: 'ipc' });

    discordRpc.on('ready', () => {
      rpcReady = true;
      // Apply any presence that was requested before we were ready
      if (pendingPresence) {
        setRpcPresence(pendingPresence.details, pendingPresence.state);
        pendingPresence = null;
      } else {
        setRpcPresence('In the Launcher', 'Browsing game library');
      }
    });

    discordRpc.login({ clientId: CLIENT_ID }).catch(() => {
      rpcReady = false;
    });
  } catch (e) {
    rpcReady = false;
  }
}

let rpcStartTimestamp = new Date();

function setRpcPresence(details, state) {
  if (!rpcReady || !discordRpc) {
    pendingPresence = { details, state };
    return;
  }
  pendingPresence = null;
  // Reset timestamp when switching states
  rpcStartTimestamp = new Date();
  try {
    discordRpc.setActivity({
      details,
      state,
      startTimestamp: rpcStartTimestamp,
      largeImageKey: 'skyware_logo',
      largeImageText: 'Skyware Hub',
      instance: false,
    });
  } catch (e) {}
}

function clearRpc() {
  if (!rpcReady || !discordRpc) return;
  try { discordRpc.clearActivity(); } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // allow loading local images
    },
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  initDiscordRPC();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ─── Window controls ────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());

// ─── Game Scanner ────────────────────────────────────────────────────────────

function steamAppIdToUrl(appId) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

function steamAppIdToIcon(appId) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_231x87.jpg`;
}

// Scan Steam library
function scanSteam() {
  const games = [];
  const platform = process.platform;

  let steamPaths = [];
  if (platform === 'win32') {
    steamPaths = [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      path.join(os.homedir(), 'AppData', 'Local', 'Steam'),
    ];
    // Also check registry via env
    const reg = process.env['ProgramFiles(x86)'];
    if (reg) steamPaths.push(path.join(reg, 'Steam'));
  } else if (platform === 'darwin') {
    steamPaths = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Steam'),
    ];
  } else {
    steamPaths = [
      path.join(os.homedir(), '.steam', 'steam'),
      path.join(os.homedir(), '.local', 'share', 'Steam'),
      '/usr/share/steam',
    ];
  }

  const foundSteamPath = steamPaths.find(p => fs.existsSync(p));
  if (!foundSteamPath) return games;

  // Find all library folders
  const libraryFolders = [path.join(foundSteamPath, 'steamapps')];

  const vdfPath = path.join(foundSteamPath, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(vdfPath)) {
    try {
      const vdf = fs.readFileSync(vdfPath, 'utf8');
      const pathMatches = vdf.matchAll(/"path"\s+"([^"]+)"/g);
      for (const match of pathMatches) {
        const libPath = path.join(match[1], 'steamapps');
        if (fs.existsSync(libPath) && !libraryFolders.includes(libPath)) {
          libraryFolders.push(libPath);
        }
      }
    } catch (e) {}
  }

  for (const libPath of libraryFolders) {
    if (!fs.existsSync(libPath)) continue;
    try {
      const files = fs.readdirSync(libPath);
      for (const file of files) {
        if (!file.startsWith('appmanifest_') || !file.endsWith('.acf')) continue;
        try {
          const acf = fs.readFileSync(path.join(libPath, file), 'utf8');
          const appId = (acf.match(/"appid"\s+"?(\d+)"?/) || [])[1];
          const name = (acf.match(/"name"\s+"([^"]+)"/) || [])[1];
          const sizeOnDisk = (acf.match(/"SizeOnDisk"\s+"?(\d+)"?/) || [])[1];
          const lastPlayed = (acf.match(/"LastPlayed"\s+"?(\d+)"?/) || [])[1];
          const installDir = (acf.match(/"installdir"\s+"([^"]+)"/) || [])[1];

          if (!appId || !name) continue;

          // Skip non-game entries (tools, redistributables, etc.)
          const skipIds = ['228980', '1070560', '1391110', '2347770'];
          if (skipIds.includes(appId)) continue;
          if (name.toLowerCase().includes('redistributable') ||
              name.toLowerCase().includes('directx') ||
              name.toLowerCase().includes('steamworks') ||
              name.toLowerCase().includes('proton')) continue;

          const sizeMB = sizeOnDisk ? Math.round(parseInt(sizeOnDisk) / (1024 * 1024)) : 0;
          const sizeStr = sizeMB > 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`;

          games.push({
            id: `steam_${appId}`,
            name,
            source: 'steam',
            appId,
            cover: steamAppIdToUrl(appId),
            icon: steamAppIdToIcon(appId),
            installDir: path.join(libPath, 'common', installDir || ''),
            lastPlayed: lastPlayed ? parseInt(lastPlayed) : 0,
            size: sizeStr,
            hours: 0,
            fav: false,
            tags: [],
            achievements: 0,
            rating: 0,
            genre: '',
            desc: '',
            badge: null,
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  return games;
}

// Scan Epic Games
function scanEpic() {
  const games = [];
  const platform = process.platform;

  let manifestPaths = [];
  if (platform === 'win32') {
    manifestPaths = [
      'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
      path.join(os.homedir(), 'AppData', 'Local', 'EpicGamesLauncher', 'Saved', 'Config'),
    ];
  } else if (platform === 'darwin') {
    manifestPaths = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    ];
  } else {
    manifestPaths = [
      path.join(os.homedir(), '.config', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    ];
  }

  for (const manifestDir of manifestPaths) {
    if (!fs.existsSync(manifestDir)) continue;
    try {
      const files = fs.readdirSync(manifestDir).filter(f => f.endsWith('.item'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
          if (!data.DisplayName) continue;
          if (data.AppName && data.AppName.toLowerCase().includes('launcher')) continue;
          if (data.bIsApplication === false) continue;

          const sizeMB = data.InstallSize ? Math.round(data.InstallSize / (1024 * 1024)) : 0;
          const sizeStr = sizeMB > 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`;

          // Try to find a cover image in the install dir
          let cover = null;
          if (data.InstallLocation) {
            const imgExts = ['.jpg', '.png', '.jpeg'];
            for (const ext of imgExts) {
              const p = path.join(data.InstallLocation, `cover${ext}`);
              if (fs.existsSync(p)) { cover = `file://${p}`; break; }
            }
          }

          games.push({
            id: `epic_${data.AppName || data.DisplayName}`,
            name: data.DisplayName,
            source: 'epic',
            appId: data.AppName,
            cover: cover || `https://cdn2.unrealengine.com/Diesel/productionservergo/${data.AppName}/item/${data.AppName}-${data.AppName}-1920x1080.jpg`,
            icon: cover,
            installDir: data.InstallLocation || '',
            lastPlayed: 0,
            size: sizeStr,
            hours: 0,
            fav: false,
            tags: data.InstallTags || [],
            achievements: 0,
            rating: 0,
            genre: '',
            desc: '',
            badge: null,
            launchExecutable: data.LaunchExecutable,
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  return games;
}

// Inline SVG covers as data URIs — guaranteed to render with no network dependency
function makeSvgCover(bgColors, letter, textColor = '#fff') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="215" viewBox="0 0 460 215">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${bgColors[0]}"/>
      <stop offset="100%" style="stop-color:${bgColors[1]}"/>
    </linearGradient></defs>
    <rect width="460" height="215" fill="url(#g)"/>
    <text x="230" y="140" font-family="Arial Black, sans-serif" font-size="96" font-weight="900"
      fill="${textColor}" opacity="0.35" text-anchor="middle">${letter}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const MINECRAFT_JAVA_COVER = makeSvgCover(['#1a4a1a', '#2d8c2d'], 'MC', '#5dff5d');
const MINECRAFT_BEDROCK_COVER = makeSvgCover(['#1a3a4a', '#1a7a3a'], 'BE', '#4dffaa');
const HYTALE_COVER = makeSvgCover(['#1a0a2e', '#c47c00'], 'HY', '#fbbf24');

// Scan Minecraft
function scanMinecraft() {
  const games = [];
  const platform = process.platform;

  let mcPaths = [];
  if (platform === 'win32') {
    mcPaths = [
      path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft'),
      path.join(os.homedir(), 'AppData', 'Local', 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang'),
      path.join(os.homedir(), 'AppData', 'Local', 'Packages', 'Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang'),
    ];
  } else if (platform === 'darwin') {
    mcPaths = [
      path.join(os.homedir(), 'Library', 'Application Support', 'minecraft'),
    ];
  } else {
    mcPaths = [
      path.join(os.homedir(), '.minecraft'),
    ];
  }

  // Java Edition
  const javaMcPath = mcPaths[0];
  if (fs.existsSync(javaMcPath)) {
    let lastPlayed = 0;
    let version = '';
    try {
      const launcherProfiles = JSON.parse(fs.readFileSync(path.join(javaMcPath, 'launcher_profiles.json'), 'utf8'));
      const profiles = launcherProfiles.profiles || {};
      for (const p of Object.values(profiles)) {
        if (p.lastUsed) {
          const ts = new Date(p.lastUsed).getTime() / 1000;
          if (ts > lastPlayed) lastPlayed = ts;
        }
        if (p.lastVersionId) version = p.lastVersionId;
      }
    } catch (e) {}

    games.push({
      id: 'minecraft_java',
      name: 'Minecraft Java Edition',
      source: 'minecraft',
      cover: MINECRAFT_JAVA_COVER,
      icon: MINECRAFT_JAVA_COVER,
      installDir: javaMcPath,
      lastPlayed,
      size: 'Varies',
      hours: 0,
      fav: false,
      tags: ['Sandbox', 'Survival', 'Creative'],
      achievements: 0,
      rating: 4.9,
      genre: 'Sandbox',
      desc: 'The original sandbox survival game. Build, explore, and survive in an infinite procedurally generated world.',
      badge: null,
      version,
    });
  }

  // Bedrock (Windows Store)
  if (platform === 'win32' && fs.existsSync(mcPaths[1])) {
    games.push({
      id: 'minecraft_bedrock',
      name: 'Minecraft Bedrock',
      source: 'minecraft',
      cover: MINECRAFT_BEDROCK_COVER,
      icon: MINECRAFT_BEDROCK_COVER,
      installDir: mcPaths[1],
      lastPlayed: 0,
      size: 'Varies',
      hours: 0,
      fav: false,
      tags: ['Sandbox', 'Cross-play', 'Creative'],
      achievements: 0,
      rating: 4.6,
      genre: 'Sandbox',
      desc: 'Cross-platform edition of Minecraft. Play with friends on any device.',
      badge: null,
    });
  }

  return games;
}

// Scan Hytale
function scanHytale() {
  const games = [];
  const platform = process.platform;

  let hytalePaths = [];
  if (platform === 'win32') {
    hytalePaths = [
      'C:\\Program Files\\Hytale',
      'C:\\Program Files (x86)\\Hytale',
      path.join(os.homedir(), 'AppData', 'Local', 'Hytale'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Hytale'),
    ];
  } else if (platform === 'darwin') {
    hytalePaths = [
      '/Applications/Hytale.app',
      path.join(os.homedir(), 'Library', 'Application Support', 'Hytale'),
    ];
  } else {
    hytalePaths = [
      path.join(os.homedir(), '.hytale'),
      '/opt/Hytale',
    ];
  }

  const foundPath = hytalePaths.find(p => fs.existsSync(p));
  if (foundPath) {
    games.push({
      id: 'hytale',
      name: 'Hytale',
      source: 'hytale',
      cover: HYTALE_COVER,
      icon: HYTALE_COVER,
      installDir: foundPath,
      lastPlayed: 0,
      size: 'Varies',
      hours: 0,
      fav: false,
      tags: ['Sandbox', 'RPG', 'Adventure'],
      achievements: 0,
      rating: 0,
      genre: 'Sandbox',
      desc: 'The highly anticipated sandbox RPG from Hypixel Studios.',
      badge: 'new',
    });
  }

  return games;
}

// Load persisted data (favorites, hours, custom data)
function loadUserData() {
  const dataPath = path.join(app.getPath('userData'), 'skyware-userdata.json');
  try {
    if (fs.existsSync(dataPath)) {
      return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
  } catch (e) {}
  return { favorites: [], hoursMap: {}, notes: {} };
}

function saveUserData(data) {
  const dataPath = path.join(app.getPath('userData'), 'skyware-userdata.json');
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) { return false; }
}

// Load Steam playtime from localconfig.vdf
function loadSteamPlaytime() {
  const hoursMap = {};
  const platform = process.platform;
  let steamPaths = [];
  if (platform === 'win32') {
    steamPaths = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  } else if (platform === 'darwin') {
    steamPaths = [path.join(os.homedir(), 'Library', 'Application Support', 'Steam')];
  } else {
    steamPaths = [path.join(os.homedir(), '.steam', 'steam'), path.join(os.homedir(), '.local', 'share', 'Steam')];
  }

  const steamPath = steamPaths.find(p => fs.existsSync(p));
  if (!steamPath) return hoursMap;

  try {
    const usersPath = path.join(steamPath, 'userdata');
    if (!fs.existsSync(usersPath)) return hoursMap;
    const users = fs.readdirSync(usersPath).filter(d => /^\d+$/.test(d));
    for (const userId of users) {
      const configPath = path.join(usersPath, userId, 'config', 'localconfig.vdf');
      if (!fs.existsSync(configPath)) continue;
      const vdf = fs.readFileSync(configPath, 'utf8');
      // Extract playtime_forever for each app
      const appBlocks = vdf.matchAll(/"(\d{3,})"\s*\{([^}]+)\}/gs);
      for (const match of appBlocks) {
        const appId = match[1];
        const block = match[2];
        const ptMatch = block.match(/"Playtime_Forever"\s+"?(\d+)"?/i) ||
                        block.match(/"playtime_forever"\s+"?(\d+)"?/i);
        if (ptMatch) {
          hoursMap[`steam_${appId}`] = Math.round(parseInt(ptMatch[1]) / 60);
        }
      }
    }
  } catch (e) {}

  return hoursMap;
}

// Main scan handler
ipcMain.handle('scan-games', async () => {
  const userData = loadUserData();
  const steamHours = loadSteamPlaytime();

  let allGames = [
    ...scanSteam(),
    ...scanEpic(),
    ...scanMinecraft(),
    ...scanHytale(),
  ];

  // Merge user data
  allGames = allGames.map(g => ({
    ...g,
    fav: userData.favorites.includes(g.id),
    hours: steamHours[g.id] || userData.hoursMap[g.id] || g.hours,
    notes: userData.notes[g.id] || '',
  }));

  // Sort: last played first, then alphabetical
  allGames.sort((a, b) => {
    if (b.lastPlayed !== a.lastPlayed) return b.lastPlayed - a.lastPlayed;
    return a.name.localeCompare(b.name);
  });

  return allGames;
});

// Launch game
// ─── Process tracking for music resume ───────────────────────────────────────
function watchProcessExit(processName, intervalMs = 3000) {
  // Poll until the process disappears, then notify renderer
  const check = () => {
    const cmd = process.platform === 'win32'
      ? `tasklist /FI "IMAGENAME eq ${processName}" /NH`
      : `pgrep -x "${processName}"`;
    exec(cmd, (err, stdout) => {
      const running = process.platform === 'win32'
        ? stdout.toLowerCase().includes(processName.toLowerCase())
        : !!stdout.trim();
      if (running) {
        setTimeout(check, intervalMs);
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('game-exited');
        }
      }
    });
  };
  // Give the process a moment to start before we begin watching
  setTimeout(check, 4000);
}

function trackChild(child, fallbackProcessName) {
  if (!child || !child.pid) {
    // No trackable PID (e.g. protocol launch) — fall back to name polling
    if (fallbackProcessName) watchProcessExit(fallbackProcessName);
    return;
  }
  child.on('exit', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-exited');
    }
  });
}

ipcMain.handle('launch-game', async (event, game) => {
  try {
    if (game.source === 'steam') {
      await shell.openExternal(`steam://rungameid/${game.appId}`);
      // Steam games: watch for the game process by appId isn't easy, so watch
      // for steam.exe activity — best we can do without Steam API
      watchProcessExit('steam.exe', 5000);
      return { success: true };
    }

    if (game.source === 'epic') {
      if (process.platform === 'win32' && game.launchExecutable && game.installDir) {
        const exePath = path.join(game.installDir, game.launchExecutable);
        if (fs.existsSync(exePath)) {
          const child = execFile(exePath, { cwd: game.installDir });
          trackChild(child, path.basename(game.launchExecutable));
          return { success: true };
        }
      }
      await shell.openExternal(`com.epicgames.launcher://apps/${game.appId}?action=launch`);
      watchProcessExit('EpicGamesLauncher.exe', 5000);
      return { success: true };
    }

    if (game.source === 'minecraft') {
      if (game.id === 'minecraft_java') {
        const launcherPaths = [
          'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
          'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe',
          path.join(os.homedir(), 'AppData', 'Roaming', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
          '/Applications/Minecraft.app/Contents/MacOS/launcher',
          '/usr/bin/minecraft-launcher',
        ];
        const launcher = launcherPaths.find(p => fs.existsSync(p));
        if (launcher) {
          const child = execFile(launcher);
          trackChild(child, path.basename(launcher));
          return { success: true };
        }
        if (process.platform === 'win32') {
          exec('start minecraft-launcher:', (err) => {});
          watchProcessExit('MinecraftLauncher.exe');
          return { success: true };
        }
      }
      return { success: false, error: 'Launcher not found' };
    }

    if (game.source === 'hytale') {
      const platform = process.platform;
      const launcherPaths = platform === 'win32' ? [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'hytale-launcher', 'Hytale Launcher.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'hytale-launcher', 'Hytale Launcher.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Hytale', 'launcher', 'Hytale Launcher.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Hytale Launcher', 'Hytale Launcher.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Hytale Launcher', 'Hytale Launcher.exe'),
        'C:\\Program Files\\Hytale Launcher\\Hytale Launcher.exe',
        'C:\\Program Files (x86)\\Hytale Launcher\\Hytale Launcher.exe',
      ] : platform === 'darwin' ? [
        '/Applications/Hytale Launcher.app/Contents/MacOS/Hytale Launcher',
        path.join(os.homedir(), 'Applications', 'Hytale Launcher.app', 'Contents', 'MacOS', 'Hytale Launcher'),
      ] : [
        path.join(os.homedir(), '.local', 'bin', 'hytale-launcher'),
        '/usr/local/bin/hytale-launcher',
        '/opt/hytale-launcher/hytale-launcher',
      ];

      const exe = launcherPaths.find(p => fs.existsSync(p));
      if (exe) {
        const child = execFile(exe);
        trackChild(child, platform === 'win32' ? 'Hytale Launcher.exe' : 'hytale-launcher');
        return { success: true };
      }

      // Fuzzy scan: walk AppData dirs for any folder containing "hytale"
      if (platform === 'win32') {
        const searchDirs = [
          path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
          path.join(os.homedir(), 'AppData', 'Local'),
          path.join(os.homedir(), 'AppData', 'Roaming'),
        ];
        for (const dir of searchDirs) {
          try {
            for (const sub of fs.readdirSync(dir)) {
              if (!sub.toLowerCase().includes('hytale')) continue;
              const subDir = path.join(dir, sub);
              try {
                for (const f of fs.readdirSync(subDir).filter(f => f.endsWith('.exe'))) {
                  const fullPath = path.join(subDir, f);
                  const child = execFile(fullPath);
                  trackChild(child, f);
                  return { success: true };
                }
              } catch (e) {}
            }
          } catch (e) {}
        }
      }

      return { success: false, error: 'Hytale Launcher not found. Install it from hytale.com' };
    }

    return { success: false, error: 'Unknown platform' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Open game folder in file explorer
ipcMain.handle('open-folder', async (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
    return true;
  }
  return false;
});

// Save/toggle favorite
ipcMain.handle('toggle-favorite', async (event, gameId, currentFav) => {
  const userData = loadUserData();
  if (currentFav) {
    userData.favorites = userData.favorites.filter(id => id !== gameId);
  } else {
    if (!userData.favorites.includes(gameId)) userData.favorites.push(gameId);
  }
  return saveUserData(userData);
});

// Save all user data (favorites, etc.)
ipcMain.handle('save-user-data', async (event, data) => {
  return saveUserData(data);
});

ipcMain.handle('load-user-data', async () => {
  return loadUserData();
});

// Browse for a game executable
ipcMain.handle('browse-for-exe', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Game Executable',
    filters: [
      { name: 'Executables', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0].replace(/\\/g, '/');
});

// Browse for a cover image
ipcMain.handle('browse-for-image', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Cover Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0].replace(/\\/g, '/');
});

// Get Steam game details from local cache or API
ipcMain.handle('get-game-details', async (event, game) => {
  if (game.source !== 'steam') return null;
  try {
    // Read local steam data if available
    return null; // Steam API requires key; return null for browser to handle
  } catch (e) { return null; }
});

// Get platform info
ipcMain.handle('get-platform', () => process.platform);

// Get app root path for asset resolution
ipcMain.handle("get-app-path", () => app.getAppPath().replace(/\\/g, "/"));

// Launch a custom EXE game
ipcMain.handle('launch-custom-game', async (event, game) => {
  try {
    if (!game.exePath || !fs.existsSync(game.exePath)) {
      return { success: false, error: 'Executable not found: ' + (game.exePath || 'no path set') };
    }
    const cwd = path.dirname(game.exePath);
    const child = execFile(game.exePath, { cwd });
    trackChild(child, path.basename(game.exePath));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── Discord RPC IPC ─────────────────────────────────────────────────────────
ipcMain.handle('rpc-set-launcher', () => {
  setRpcPresence('In the Launcher', 'Browsing game library');
});

ipcMain.handle('rpc-set-playing', (event, gameName) => {
  setRpcPresence(`Playing ${gameName}`, 'via Skyware Hub');
});

// ─── Minecraft Launcher Detection ────────────────────────────────────────────
const MC_LAUNCHERS = [
  {
    id: 'official',
    name: 'Official Launcher',
    icon: '🟩',
    paths: {
      win32: [
        'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
        'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe',
        path.join(os.homedir(), 'AppData', 'Roaming', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', 'javaw.exe'),
      ],
      darwin: ['/Applications/Minecraft.app/Contents/MacOS/launcher'],
      linux: ['/usr/bin/minecraft-launcher', path.join(os.homedir(), '.local', 'share', 'applications', 'minecraft-launcher')],
    },
    protocol: 'win32',
    protocolCmd: 'minecraft-launcher:',
  },
  {
    id: 'lunar',
    name: 'Lunar Client',
    icon: '🌙',
    paths: {
      win32: [
        path.join(os.homedir(), 'AppData', 'Roaming', '.lunarclient', 'offline', 'multiver', 'lunar-launcher.exe'),
        'C:\\Program Files\\Lunar Client\\Lunar Client.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'lunarclient', 'Lunar Client.exe'),
      ],
      darwin: ['/Applications/Lunar Client.app/Contents/MacOS/Lunar Client'],
      linux: [path.join(os.homedir(), '.local', 'share', 'lunarclient', 'lunarclient')],
    },
  },
  {
    id: 'badlion',
    name: 'Badlion Client',
    icon: '🦁',
    paths: {
      win32: [
        'C:\\Program Files (x86)\\Badlion Client\\BadlionClient.exe',
        'C:\\Program Files\\Badlion Client\\BadlionClient.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'badlion-client', 'BadlionClient.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Badlion Client', 'BadlionClient.exe'),
      ],
      darwin: ['/Applications/Badlion Client.app/Contents/MacOS/BadlionClient'],
      linux: [],
    },
  },
  {
    id: 'feather',
    name: 'Feather Client',
    icon: '🪶',
    paths: {
      win32: [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'feather-launcher', 'Feather Launcher.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'feather-launcher', 'Feather Launcher.exe'),
        'C:\\Program Files\\Feather Launcher\\Feather Launcher.exe',
      ],
      darwin: ['/Applications/Feather Launcher.app/Contents/MacOS/Feather Launcher'],
      linux: [],
    },
  },
  {
    id: 'prism',
    name: 'Prism Launcher',
    icon: '🔷',
    paths: {
      win32: [
        'C:\\Program Files\\Prism Launcher\\prismlauncher.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PrismLauncher', 'prismlauncher.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'PrismLauncher', 'prismlauncher.exe'),
      ],
      darwin: ['/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher'],
      linux: ['/usr/bin/prismlauncher', '/usr/local/bin/prismlauncher'],
    },
  },
  {
    id: 'multimc',
    name: 'MultiMC',
    icon: '📦',
    paths: {
      win32: [
        'C:\\Program Files\\MultiMC\\MultiMC.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'MultiMC', 'MultiMC.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'MultiMC', 'MultiMC.exe'),
      ],
      darwin: ['/Applications/MultiMC.app/Contents/MacOS/MultiMC'],
      linux: ['/usr/bin/multimc', '/usr/local/bin/multimc'],
    },
  },
  {
    id: 'tlauncher',
    name: 'TLauncher',
    icon: '🚀',
    paths: {
      win32: [
        path.join(os.homedir(), 'AppData', 'Roaming', '.tlauncher', 'TLauncher.exe'),
        'C:\\Program Files\\TLauncher\\TLauncher.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'TLauncher', 'TLauncher.exe'),
      ],
      darwin: [],
      linux: [],
    },
  },
  {
    id: 'curseforge',
    name: 'CurseForge',
    icon: '🔥',
    paths: {
      win32: [
        'C:\\Program Files (x86)\\CurseForge\\CurseForge.exe',
        'C:\\Program Files\\CurseForge\\CurseForge.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'curseforge', 'CurseForge.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'CurseForge', 'CurseForge.exe'),
      ],
      darwin: ['/Applications/CurseForge.app/Contents/MacOS/CurseForge'],
      linux: [],
    },
  },
  {
    id: 'modrinth',
    name: 'Modrinth App',
    icon: '🌿',
    paths: {
      win32: [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ModrinthApp', 'ModrinthApp.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'ModrinthApp', 'ModrinthApp.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'modrinth-app', 'Modrinth App.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'ModrinthApp', 'ModrinthApp.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'modrinth', 'ModrinthApp.exe'),
        'C:\\Program Files\\Modrinth App\\ModrinthApp.exe',
        'C:\\Program Files (x86)\\Modrinth App\\ModrinthApp.exe',
      ],
      darwin: [
        '/Applications/Modrinth App.app/Contents/MacOS/Modrinth App',
        '/Applications/ModrinthApp.app/Contents/MacOS/ModrinthApp',
      ],
      linux: [
        path.join(os.homedir(), '.local', 'share', 'modrinth', 'modrinth-app'),
        '/usr/bin/modrinth-app',
      ],
    },
  },
  {
    id: 'skyware',
    name: 'Skyware Client',
    icon: '🌌',
    paths: {
      win32: [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'SkywareClient', 'SkywareClient.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'skyware-client', 'Skyware Client.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'SkywareClient', 'SkywareClient.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'SkywareClient', 'SkywareClient.exe'),
        'C:\\Program Files\\Skyware Client\\SkywareClient.exe',
        'C:\\Program Files (x86)\\Skyware Client\\SkywareClient.exe',
      ],
      darwin: [
        '/Applications/Skyware Client.app/Contents/MacOS/Skyware Client',
        '/Applications/SkywareClient.app/Contents/MacOS/SkywareClient',
      ],
      linux: [
        path.join(os.homedir(), '.local', 'share', 'skyware-client', 'skyware-client'),
        '/usr/bin/skyware-client',
      ],
    },
  },
];

ipcMain.handle('scan-minecraft-launchers', async () => {
  const platform = process.platform;
  const results = [];

  // Build a map of all exe files in common install dirs for fuzzy matching
  const searchDirs = platform === 'win32' ? [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    path.join(os.homedir(), 'AppData', 'Local'),
    path.join(os.homedir(), 'AppData', 'Roaming'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ] : [];

  // Quick shallow scan of top-level dirs to find any missed launchers
  const foundDirs = new Set();
  for (const dir of searchDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(sub => foundDirs.add(path.join(dir, sub)));
      }
    } catch (e) {}
  }

  for (const launcher of MC_LAUNCHERS) {
    let paths = (launcher.paths[platform] || []);

    // For Modrinth and Skyware: also try fuzzy-matching folder names in search dirs
    if (['modrinth', 'skyware'].includes(launcher.id)) {
      const keywords = launcher.id === 'modrinth'
        ? ['modrinth', 'ModrinthApp']
        : ['skyware', 'SkywareClient', 'skyware-client'];

      for (const dir of foundDirs) {
        const base = path.basename(dir).toLowerCase();
        if (keywords.some(k => base.toLowerCase().includes(k.toLowerCase()))) {
          try {
            const exes = fs.readdirSync(dir).filter(f => f.endsWith('.exe'));
            exes.forEach(exe => paths.push(path.join(dir, exe)));
          } catch (e) {}
        }
      }
    }

    const found = paths.find(p => { try { return fs.existsSync(p); } catch { return false; } });

    // Official launcher on Windows: always available via protocol
    if (!found && launcher.id === 'official' && platform === 'win32') {
      results.push({ id: launcher.id, name: launcher.name, icon: launcher.icon, exePath: null, available: true, protocol: true });
      continue;
    }

    results.push({
      id: launcher.id,
      name: launcher.name,
      icon: launcher.icon,
      exePath: found || null,
      available: !!found,
      protocol: false,
    });
  }

  return results;
});

ipcMain.handle('launch-minecraft-launcher', async (event, launcher) => {
  try {
    if (launcher.protocol && process.platform === 'win32') {
      exec('start minecraft-launcher:', (err) => {});
      watchProcessExit('MinecraftLauncher.exe');
      return { success: true };
    }
    if (launcher.exePath && fs.existsSync(launcher.exePath)) {
      const child = execFile(launcher.exePath);
      trackChild(child, path.basename(launcher.exePath));
      return { success: true };
    }
    return { success: false, error: 'Launcher not found on this system' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});