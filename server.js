require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType, ChannelType } = require('discord.js');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// Config from environment variables
const config = {
  API_KEY: process.env.API_KEY, 
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,

  DISCORD_CLIENT_ID: process.env.BOT_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  DISCORD_CALLBACK_URL: process.env.REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
  TARGET_GUILD_ID: process.env.SERVER_ID,

  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1331021897735081984', 
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: { 
    STANDARD: process.env.ROLE_STANDARD_ID || '1330552089759191064',
    PREMIUM: process.env.ROLE_PREMIUM_ID || '1333286640248029264',
    ULTIMATE: process.env.ROLE_ULTIMATE_ID || '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 1000,
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  ADD_USER_TO_GUILD_IF_MISSING: process.env.ADD_USER_TO_GUILD_IF_MISSING === 'true',

  WEBHOOK_GAMELOGS_2_9: process.env.WEBHOOK_GAMELOGS_2_9,
  WEBHOOK_GAMELOGS_10_49: process.env.WEBHOOK_GAMELOGS_10_49,
  WEBHOOK_GAMELOGS_50_200: process.env.WEBHOOK_GAMELOGS_50_200,
  WEBHOOK_GAMELOGS_PREMIUM: process.env.WEBHOOK_GAMELOGS_PREMIUM,

  GAME_STATS_CURRENT_ACTIVE_VC_ID: process.env.GAME_STATS_CURRENT_ACTIVE_VC_ID || '1373732957910470699',
  GAME_STATS_TOTAL_GAMES_VC_ID: process.env.GAME_STATS_TOTAL_GAMES_VC_ID || '1373733192229720225',
};

if (/*!config.API_KEY || // API_KEY removida da verificação para Gamelogs, mas pode ser usada em outros locais */
    !config.GITHUB_TOKEN || 
    !config.DISCORD_BOT_TOKEN || 
    !config.GITHUB_LUA_MENU_URL ||
    !config.DISCORD_CLIENT_ID ||
    !config.DISCORD_CLIENT_SECRET ||
    !config.TARGET_GUILD_ID) {
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file.');
  process.exit(1);
}
if (!config.WEBHOOK_GAMELOGS_2_9 || !config.WEBHOOK_GAMELOGS_10_49 || !config.WEBHOOK_GAMELOGS_50_200 || !config.WEBHOOK_GAMELOGS_PREMIUM) {
    console.warn("Warning: One or more WEBHOOK_GAMELOGS URLs are not set. The /send/gamelogs feature might not work correctly.");
}
if (!config.GAME_STATS_CURRENT_ACTIVE_VC_ID || !config.GAME_STATS_TOTAL_GAMES_VC_ID){
    console.warn("Warning: One or both GAME_STATS voice channel IDs are not set. Stats display may fail.");
} else if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID === config.GAME_STATS_TOTAL_GAMES_VC_ID && config.GAME_STATS_TOTAL_GAMES_VC_ID) {
    console.warn(`Warning: GAME_STATS_CURRENT_ACTIVE_VC_ID and GAME_STATS_TOTAL_GAMES_VC_ID are the same. Only one statistic will be effectively displayed.`);
}

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

const scriptQueue = new Map();
const gameStats = new Map(); 
const GAME_DATA_EXPIRY_MS = 30 * 60 * 1000;

let voiceChannelUpdateTimeout = null;
const VOICE_CHANNEL_UPDATE_DEBOUNCE_MS = 10 * 60 * 1000; // Não atualizar nomes de canal mais de uma vez a cada 10 minutos


app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: process.env.NODE_ENV === 'production' ? undefined : undefined, 
}));
if (process.env.NODE_ENV !== 'production') {
    console.warn("Warning: connect.session() MemoryStore is not designed for a production environment.");
}
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser(async (obj, done) => done(null, obj));
passport.use(new DiscordStrategy({
  clientID: config.DISCORD_CLIENT_ID,
  clientSecret: config.DISCORD_CLIENT_SECRET,
  callbackURL: config.DISCORD_CALLBACK_URL,
  scope: ['identify', 'guilds', 'guilds.join']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = { id: profile.id, username: profile.username, discriminator: profile.discriminator, avatar: profile.avatar, guilds: profile.guilds, accessToken: accessToken };
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
async function sendActionLogToDiscord(title, description, interactionOrUser, color = 0x0099FF, additionalFields = []) {
    try {
        if (!config.LOG_CHANNEL_ID) { console.warn("sendActionLogToDiscord: LOG_CHANNEL_ID not configured."); return; }
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(err => {
            console.error("sendActionLogToDiscord: Failed to fetch log channel:", err.message); return null;
        });
        if (!logChannel) return;
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        if (interactionOrUser) {
            if (interactionOrUser.user) {
                 logEmbed.addFields({ name: 'Initiated By', value: `${interactionOrUser.user.tag} (<@${interactionOrUser.user.id}>)`, inline: true });
                 if (interactionOrUser.guild) logEmbed.addFields({ name: 'Context', value: `Guild: ${interactionOrUser.guild.name}\nChannel: ${interactionOrUser.channel?.name || 'N/A'}`, inline: true });
            } else if (interactionOrUser.id && interactionOrUser.username) {
                 logEmbed.addFields({ name: 'By User', value: `${interactionOrUser.username}#${interactionOrUser.discriminator} (<@${interactionOrUser.id}>)`, inline: true });
            }
        }
        additionalFields.forEach(field => { if (logEmbed.data.fields && logEmbed.data.fields.length < 24) logEmbed.addFields(field);});
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("CRITICAL: Failed to send action log:", logSendError.message); }
}
async function getWhitelistFromGitHub() {
  let rawDataContent; 
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    rawDataContent = response.data; 
    if (response.status !== 200) { throw new Error(`GitHub API request failed with status ${response.status}`); }
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") { return []; }
      return JSON.parse(rawDataContent);
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) {
      return rawDataContent;
    } else { throw new Error('Unexpected GitHub response format for whitelist content.'); }
  } catch (error) {
    console.error(`Error in getWhitelistFromGitHub: ${error.message}`);
    throw new Error(`Failed to fetch or parse whitelist from GitHub. Original: ${error.message}`);
  }
}

function parseGameDataFromEmbed(description) {
    if (!description) return null;
    const parseNumeric = (str) => { 
        if (!str) return 0;
        const cleaned = String(str).replace(/[^\d,]/g, '').replace(',', ''); 
        const num = parseInt(cleaned, 10);
        return isNaN(num) ? 0 : num;
    };
    const gameIdMatch = description.match(/games\/(\d+)/);
    const gameNameMatch = description.match(/\*\*Game Name\*\*: (.*?)\n/);
    const activePlayersMatch = description.match(/\*\*Active Players\*\*: `%?([\d,]+)%?`/);
    const visitsMatch = description.match(/\*\*Visits\*\*: `%?([\d,]+)%?`/);

    return {
        gameId: gameIdMatch ? gameIdMatch[1] : null,
        gameName: gameNameMatch ? gameNameMatch[1].trim() : "Unknown Game",
        activePlayers: activePlayersMatch ? parseNumeric(activePlayersMatch[1]) : 0,
        visits: visitsMatch ? parseNumeric(visitsMatch[1]) : 0,
    };
}

async function actualUpdateDiscordVoiceChannelNames() {
    if (!discordClient.isReady()) {
        console.warn("[VoiceUpdate] Discord client not ready. Skipping.");
        return;
    }
    const now = Date.now();
    let totalActivePlayers = 0;
    const uniqueActiveGamesForPlayerCount = new Map();

    for (const [gameId, data] of gameStats.entries()) {
        if (now - data.lastUpdate > GAME_DATA_EXPIRY_MS) {
            gameStats.delete(gameId);
        } else {
            if (!uniqueActiveGamesForPlayerCount.has(gameId) || data.activePlayers > uniqueActiveGamesForPlayerCount.get(gameId)) {
                uniqueActiveGamesForPlayerCount.set(gameId, data.activePlayers);
            }
        }
    }
    uniqueActiveGamesForPlayerCount.forEach(players => totalActivePlayers += players);
    const totalUniqueGames = gameStats.size;
    console.log(`[VoiceUpdate] Calculated: Active Players = ${totalActivePlayers}, Total Games = ${totalUniqueGames}`);
    const formatNumber = (num) => num.toLocaleString('en-US');

    if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID) {
        try {
            const channel = await discordClient.channels.fetch(config.GAME_STATS_CURRENT_ACTIVE_VC_ID);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const newName = `Current active: ${formatNumber(totalActivePlayers)}`;
                if (channel.name !== newName) {
                    await channel.setName(newName, 'Updating game stats');
                    console.log(`[VoiceUpdate] 'Current active' VC updated to: ${newName}`);
                }
            } else { console.warn(`[VoiceUpdate] Active players VC (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) not found/not voice.`); }
        } catch (error) { console.error(`[VoiceUpdate] Error updating 'Current active' VC:`, error.message); }
    }
    if (config.GAME_STATS_TOTAL_GAMES_VC_ID) {
        try {
            const channel = await discordClient.channels.fetch(config.GAME_STATS_TOTAL_GAMES_VC_ID);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const newName = `Total Games: ${formatNumber(totalUniqueGames)}`;
                if (channel.name !== newName) {
                    await channel.setName(newName, 'Updating game stats');
                    console.log(`[VoiceUpdate] 'Total Games' VC updated to: ${newName}`);
                }
            } else { console.warn(`[VoiceUpdate] Total games VC (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}) not found/not voice.`);}
        } catch (error) { console.error(`[VoiceUpdate] Error updating 'Total Games' VC:`, error.message); }
    }
}

function scheduleVoiceChannelUpdate() {
    if (voiceChannelUpdateTimeout) {
        clearTimeout(voiceChannelUpdateTimeout);
    }
    voiceChannelUpdateTimeout = setTimeout(async () => {
        console.log("[VoiceUpdateDebounce] Debounce time reached. Executing voice channel name updates.");
        try {
            await actualUpdateDiscordVoiceChannelNames();
        } catch (error) {
            console.error("[VoiceUpdateDebounce] Error during debounced execution:", error);
        }
        voiceChannelUpdateTimeout = null; 
    }, VOICE_CHANNEL_UPDATE_DEBOUNCE_MS);
}

// --- HANDLER DAS ROTAS DE GAMELOG (SEM COOLDOWN PARA WEBHOOK PROVIDER) ---
async function gameLogRequestHandler(req, res, webhookUrl, tierName) {
    const sourceIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',').shift();
    // console.log(`[Gamelog:${tierName}] PUBLIC Request from IP: ${sourceIp}, Path: ${req.path}`);

    if (!req.body || !req.body.embeds || !req.body.embeds.length) {
        return res.status(400).json({ status: 'error', message: 'Dados de embed inválidos ou ausentes.' });
    }
    if (!webhookUrl) {
        console.error(`[Gamelog:${tierName}] CRITICAL: webhookUrl UNDEFINED for tier. Path: ${req.path}`);
        return res.status(500).json({ status: 'error', message: 'Erro de config: URL de webhook ausente.' });
    }

    const embedData = req.body.embeds[0];
    // Tentativa de parsear dados do jogo para estatísticas locais
    if (embedData && embedData.description) {
        const gameData = parseGameDataFromEmbed(embedData.description);
        if (gameData && gameData.gameId) {
            const now = Date.now();
            let gameEntry = gameStats.get(gameData.gameId) || { ...gameData, lastUpdate: 0 };
            gameEntry = { ...gameEntry, ...gameData, lastUpdate: now };
            gameStats.set(gameData.gameId, gameEntry);
            // console.log(`[Gamelog:${tierName}] Stats locais atualizadas para GameID: ${gameData.gameId}`);
        } else {
            // console.warn(`[Gamelog:${tierName}] Não foi possível parsear gameId para stats. Desc: ${embedData.description.substring(0,100)}`);
        }
    } else {
        // console.warn(`[Gamelog:${tierName}] Embed ou descrição ausentes. Não é possível atualizar stats locais.`);
    }
    
    // TENTA ENVIAR PARA O WEBHOOK PROVIDER (EX: webhook.lewisakura.moe) IMEDIATAMENTE
    console.warn(`[Gamelog:${tierName}] REMOVING COOLDOWN! Attempting to forward to ${webhookUrl.substring(0,50)} for GameID: ${embedData?.description?.match(/games\/(\d+)/)?.[1] || 'N/A'}. THIS MAY CAUSE ISSUES WITH THE WEBHOOK PROVIDER.`);
    try {
        await axios.post(webhookUrl, req.body, { 
            // Dentro do gameLogRequestHandler, no axios.post:
            headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            timeout: 10000 
        });
        
        console.log(`[Gamelog:${tierName}] Encaminhado com sucesso (sem cooldown) para ${webhookUrl.substring(0,50)}.`);
        res.status(200).json({ status: 'success', message: 'Game log recebido e encaminhado (sem cooldown).' });
    
    } catch (error) {
        let errorDetail = error.message;
        if (error.response) {
            errorDetail = `Webhook (sem cooldown) respondeu com Status ${error.response.status}`;
            const responseDataPreview = typeof error.response.data === 'string' ? error.response.data.substring(0,200) : JSON.stringify(error.response.data).substring(0,200);
            console.error(`[Gamelog:${tierName}] Webhook Error (sem cooldown): Status ${error.response.status}, Data: ${responseDataPreview}`);
            // Aqui você poderia reenviar o erro para seu LOG_CHANNEL_ID se desejado.
        } else {
            console.error(`[Gamelog:${tierName}] Erro de encaminhamento (sem cooldown): ${errorDetail}`);
        }
        res.status(502).json({ status: 'error', message: `Falha ao encaminhar (sem cooldown): ${errorDetail}` });
    }
    scheduleVoiceChannelUpdate(); // Agendar atualização dos canais de voz
}

async function ensureAuthenticatedAndAuthorized(req, res, next) { 
  if (!req.isAuthenticated()) { return res.redirect('/auth/discord');}
  const user = req.user;
  let whitelist;
  try { whitelist = await getWhitelistFromGitHub(); } catch (e) { console.error("Auth Middleware: Whitelist fetch error", e); return res.status(500).send("Error checking whitelist."); }
  const userWhitelistEntry = whitelist.find(entry => entry && entry.Discord === user.id);
  if (!userWhitelistEntry) { return res.status(403).send(`<h1>Access Denied</h1><p>Not whitelisted.</p><p><a href="/logout">Logout</a></p>`); }
  const requiredRoleIds = Object.values(config.ROLES).filter(Boolean);
  if (requiredRoleIds.length === 0) { req.robloxUsername = userWhitelistEntry.User; return next(); }
  let member;
  try {
    const guild = await discordClient.guilds.fetch(config.TARGET_GUILD_ID);
    if(!guild) return res.status(500).send("Config error: Target guild not accessible.");
    member = await guild.members.fetch(user.id).catch(() => null);
     if (!member && config.ADD_USER_TO_GUILD_IF_MISSING && user.accessToken) {
        try { 
            await guild.members.add(user.id, { accessToken: user.accessToken, roles: [] }); 
            member = await guild.members.fetch(user.id); 
        } catch (addError) { 
            console.error(`Failed to add user ${user.id} to guild:`, addError);
        }
     }
    if (!member) { return res.status(403).send(`<h1>Access Denied</h1><p>Not in Discord server.</p><p><a href="/logout">Logout</a></p>`);}
    const hasRequiredRole = member.roles.cache.some(role => requiredRoleIds.includes(role.id));
    if (!hasRequiredRole) { return res.status(403).send(`<h1>Access Denied</h1><p>Missing required roles.</p><p><a href="/logout">Logout</a></p>`); }
    req.robloxUsername = userWhitelistEntry.User; 
    next();
  } catch (err) { console.error("Auth Middleware: Role/Guild check error", err); return res.status(500).send("Error verifying permissions."); }
}

app.get('/', (req, res) => { res.send("API is running. Login at /auth/discord. Executor at /executor."); });
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), async (req, res) => { res.redirect('/executor'); });
app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) { return next(err); }
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});
app.get('/executor', ensureAuthenticatedAndAuthorized, (req, res) => { res.send(`<h1>Executor Page</h1><p>Welcome ${req.user.username}#${req.user.discriminator}</p><p>Roblox: ${req.robloxUsername || 'N/A'}</p><textarea id="script" rows="10" cols="50"></textarea><button onclick="executeScript()">Execute</button><script>function executeScript(){ console.log('TODO: Execute', document.getElementById('script').value); }</script><a href="/logout">Logout</a>`); });


// --- ROTAS QUE AINDA PODEM PRECISAR DE API_KEY (EXEMPLO) ---
// Certifique-se de que estas rotas, se existirem e precisarem de API Key, continuem a usá-la.
// O pedido foi para remover API Key APENAS dos gamelogs.
app.post('/send/scriptlogs', async (req, res) => { 
    // Exemplo: Esta rota AINDA usa API_KEY
    if (req.headers['authorization'] !== config.API_KEY) { 
        return res.status(401).json({ status: 'error', message: 'Invalid API key for scriptlogs.' });
    }
    console.log("Received protected scriptlog:", req.body);
    res.status(200).json({status: "success", message: "Scriptlog received (protected)"});
});

app.post('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY ) { // Manteve a proteção de API Key aqui
         return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }
    console.log("Received protected queue post for", req.params.username);
    res.status(200).json({status: "success", message: "Queue post received (protected)"});
 });
app.get('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY && !isFromRoblox(req)) { // Manteve a proteção de API Key aqui
        return res.status(401).send('Unauthorized');
    }
    console.log("Received protected queue get for", req.params.username);
    res.status(200).json({status: "success", message: "Queue get received (protected)"});
});


// --- ROTAS DE GAMELOG (Chamando o handler modificado SEM COOLDOWN PARA WEBHOOK) ---
app.post('/send/gamelogs/9', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_2_9, '2-9');
});
app.post('/send/gamelogs/49', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_10_49, '10-49');
});
app.post('/send/gamelogs/200', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_50_200, '50-200');
});
app.post('/send/gamelogs/Premium', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_PREMIUM, 'Premium');
});

discordClient.on('interactionCreate', async interaction => { 
  if (!interaction.isButton()) return;
  async function handleBlacklist(interaction) { if(!interaction.replied && !interaction.deferred) await interaction.reply({content: "Blacklist (placeholder).", ephemeral: true}); }
  async function handleGetAssetOrScript(interaction) { if(!interaction.replied && !interaction.deferred) await interaction.reply({content: "Get Asset (placeholder).", ephemeral: true}); }
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) { console.error('Interaction error:', error); 
    if(interaction.isRepliable()){
        if(interaction.replied || interaction.deferred) await interaction.editReply({content: 'Error processing button.', ephemeral: true}).catch(()=>{});
        else await interaction.reply({content: 'Error processing button.', ephemeral: true}).catch(()=>{});
    }
 }
});
discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag}.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Logs & Scripts', { type: ActivityType.Playing }); 
  scheduleVoiceChannelUpdate();
});

process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason, promise); });
process.on('uncaughtException', (error, origin) => { console.error('Uncaught Exception:', error, origin); });

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => {
        console.log(`API on port ${config.PORT}. Bot connected.`);
        console.log(`OAuth Redirect: ${config.DISCORD_CALLBACK_URL}`);
        console.log(`Log Channel: ${config.LOG_CHANNEL_ID || 'NOT SET'}`);
        console.log(`VC Active: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID || 'NOT SET'}, VC Total: ${config.GAME_STATS_TOTAL_GAMES_VC_ID || 'NOT SET'}`);
    });
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
