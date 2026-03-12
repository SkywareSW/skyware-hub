const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skyware', {
  // Game scanning
  scanGames: () => ipcRenderer.invoke('scan-games'),
  launchGame: (game) => ipcRenderer.invoke('launch-game', game),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // User data
  toggleFavorite: (gameId, currentFav) => ipcRenderer.invoke('toggle-favorite', gameId, currentFav),
  saveUserData: (data) => ipcRenderer.invoke('save-user-data', data),
  loadUserData: () => ipcRenderer.invoke('load-user-data'),

  // Game details
  getGameDetails: (game) => ipcRenderer.invoke('get-game-details', game),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // Discord RPC
  rpcSetLauncher: () => ipcRenderer.invoke('rpc-set-launcher'),
  rpcSetPlaying: (gameName) => ipcRenderer.invoke('rpc-set-playing', gameName),

  // Minecraft launcher picker
  scanMinecraftLaunchers: () => ipcRenderer.invoke('scan-minecraft-launchers'),
  launchMinecraftLauncher: (launcher) => ipcRenderer.invoke('launch-minecraft-launcher', launcher),

  // Game exit notification
  onGameExited: (cb) => ipcRenderer.on('game-exited', cb),

  // Custom games & folders
  browseForExe: () => ipcRenderer.invoke('browse-for-exe'),
  browseForImage: () => ipcRenderer.invoke('browse-for-image'),
  launchCustomGame: (game) => ipcRenderer.invoke('launch-custom-game', game),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
});