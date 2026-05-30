"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER + DASHBOARD
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

let bot = null;
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

let isReconnecting = false;
let reconnectTimeoutId = null;

// === Express Routes (Dashboard, Logs, etc.) ===
app.get('/', (req, res) => { /* ... dein Dashboard Code ... */ });
app.get("/tutorial", (req, res) => { /* ... dein Tutorial Code ... */ });
app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot?.entity?.position || null,
    reconnectAttempts: botState.reconnectAttempts,
  });
});
app.get("/logs", (req, res) => { /* ... dein Logs Code ... */ });
app.post("/start", (req, res) => { /* ... */ });
app.post("/stop", (req, res) => { /* ... */ });
app.post("/command", (req, res) => { /* ... */ });

// Server starten
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});

// Self-Ping für Render
const startSelfPing = () => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return;
  setInterval(() => {
    https.get(`${renderUrl}/ping`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
  addLog("[KeepAlive] Self-ping started (every 10 min)");
};
startSelfPing();

// ============================================================
// BOT ERSTELLUNG - OPTIMIERT FÜR ATERNOS
// ============================================================
function createBot() {
  if (isReconnecting) return;
  if (bot) {
    try { bot.end(); } catch (_) {}
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  const botVersion = config.server.version?.trim() ? config.server.version : false;

  bot = mineflayer.createBot({
    username: config["bot-account"].username,
    auth: config["bot-account"].type,
    host: config.server.ip,
    port: config.server.port,
    version: botVersion,
    hideErrors: false,

    // === WICHTIGE ATERNOS-OPTIMIERUNGEN ===
    connectTimeout: 240000,      // 4 Minuten
    checkTimeoutInterval: 600000, // 10 Minuten
    keepAlive: true,
    timeout: 240000,
  });

  bot.loadPlugin(pathfinder);

  // Connection Timeout
  const connTimeout = setTimeout(() => {
    if (!botState.connected && bot) {
      addLog("[Bot] Connection timeout → forcing reconnect");
      bot.end();
    }
  }, 180000);

  bot.once("spawn", () => {
    clearTimeout(connTimeout);
    botState.connected = true;
    botState.reconnectAttempts = 0;
    isReconnecting = false;

    addLog(`[Bot] ✅ Successfully spawned on server!`);

    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.allowFreeMotion = false;
    defaultMove.canDig = false;

    initializeModules(bot, mcData, defaultMove);
  });

  bot.on("end", (reason) => {
    addLog(`[Bot] Disconnected: ${reason || "Unknown"}`);
    botState.connected = false;
    scheduleReconnect();
  });

  bot.on("error", (err) => {
    const msg = err.message || err.toString();
    addLog(`[Bot] Error: ${msg}`);

    if (msg.includes("ETIMEDOUT") || msg.includes("socketClosed") || 
        msg.includes("ECONNRESET") || msg.includes("ENOTFOUND")) {
      addLog("[Bot] Network timeout detected → extended delay");
      botState.wasThrottled = true;
    }
  });

  bot.on("kicked", (reason) => {
    const r = typeof reason === "object" ? JSON.stringify(reason) : reason;
    addLog(`[Bot] Kicked: ${r}`);
  });
}

// ============================================================
// RECONNECT LOGIC
// ============================================================
function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    return 45000 + Math.random() * 45000; // 45-90 Sekunden
  }

  const base = config.utils["auto-reconnect-delay"] || 8000;
  const max = config.utils["max-reconnect-delay"] || 300000;

  let delay = Math.min(base * Math.pow(1.7, botState.reconnectAttempts), max);
  delay += Math.random() * 5000;
  return delay;
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeoutId = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULES (kurz gefasst - du kannst sie erweitern)
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing...");

  // Anti-AFK + Movement
  if (config.utils["anti-afk"]?.enabled) {
    // Sneak, Swing, etc. (wie vorher)
    setInterval(() => {
      if (bot && botState.connected) bot.swingArm();
    }, 25000);
  }

  if (config.movement?.["circle-walk"]?.enabled) {
    startCircleWalk(bot, defaultMove);
  }

  addLog("[Modules] Done!");
}

function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius || 5;
  let angle = 0;
  setInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
    } catch (e) {}
  }, config.movement["circle-walk"].speed || 4500);
}

// ============================================================
// START
// ============================================================
addLog("=".repeat(60));
addLog("   Slobos AFK Aternos Bot - Optimized Edition");
addLog("=".repeat(60));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Username: ${config["bot-account"].username}`);

createBot();
