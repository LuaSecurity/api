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
  API_KEY: process.env.API_KEY, // Embora não usado nos gamelogs, pode ser usado em outras rotas.
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

// --- VALIDAÇÕES DE CONFIGURAÇÃO ESSENCIAL ---
// (Esta seção está ok, mantida como no seu script)
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
const gameStats = new Map(); // Key: gameId, Value: { ..., lastSuccessfulDiscordForward: timestamp, lastWebhookAttempt: timestamp, lastUpdate: timestamp }
const GAME_DATA_EXPIRY_MS = 30 * 60 * 1000;

// Cooldown para não enviar dados do MESMO JOGO para o Discord com muita frequência
const GAME_SPECIFIC_FORWARD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos

// Cooldown para não enviar NADA para a MESMA URL DE WEBHOOK com muita frequência
const webhookGlobalCooldowns = new Map(); // Key: webhookUrl, Value: timestamp of last send attempt
const GLOBAL_WEBHOOK_SEND_COOLDOWN_MS = 10 * 1000; // Não enviar para o mesmo webhook mais de uma vez a cada 10 segundos

// Debounce para atualização dos nomes dos canais de voz
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

// --- FUNÇÕES HELPER (sendActionLogToDiscord, getWhitelistFromGitHub, etc. - Mantidas como no seu script) ---
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
async function getWhitelistFromGitHub() { /* ... (seu código existente, assumido correto) ... */ 
  // console.log(`Fetching whitelist: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
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
// const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = ... (seu código)
// async function sendToDiscordChannel(...) ... (seu código)

// --- FUNÇÕES HELPER PARA GAMELOGS E ESTATÍSTICAS ---
function parseGameDataFromEmbed(description) {
    if (!description) return null;
    const parseNumeric = (str) => { // Robusto para limpar não-dígitos, exceto vírgula
        if (!str) return 0;
        const cleaned = String(str).replace(/[^\d,]/g, '').replace(',', ''); 
        const num = parseInt(cleaned, 10);
        return isNaN(num) ? 0 : num;
    };

    const gameIdMatch = description.match(/games\/(\d+)/);
    const gameNameMatch = description.match(/\*\*Game Name\*\*: (.*?)\n/);
    const activePlayersMatch = description.match(/\*\*Active Players\*\*: `%?([\d,]+)%?`/);
    const visitsMatch = description.match(/\*\*Visits\*\*: `%?([\d,]+)%?`/);
    // Adicione outros campos se necessário (serverPlayers, favorites, etc.)

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

    // Atualiza Canal "Current Active Players"
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
    // Atualiza Canal "Total Games"
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
        voiceChannelUpdateTimeout = null; // Pronta para o próximo agendamento
    }, VOICE_CHANNEL_UPDATE_DEBOUNCE_MS);
}

// --- HANDLER DAS ROTAS DE GAMELOG (SEM API KEY, COM RATE LIMIT CONTROL) ---
async function gameLogRequestHandler(req, res, webhookUrl, tierName) {
    const sourceIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',').shift();
    // console.log(`[Gamelog:${tierName}] PUBLIC Request from IP: ${sourceIp}, Path: ${req.path}`);

    if (!req.body || !req.body.embeds || !req.body.embeds.length) {
        // console.warn(`[Gamelog:${tierName}] Invalid/missing embed data. IP: ${sourceIp}`);
        return res.status(400).json({ status: 'error', message: 'Dados de embed inválidos ou ausentes.' });
    }
    if (!webhookUrl) {
        console.error(`[Gamelog:${tierName}] CRITICAL: webhookUrl UNDEFINED for tier. Path: ${req.path}`);
        return res.status(500).json({ status: 'error', message: 'Erro de config: URL de webhook ausente.' });
    }

    const embedData = req.body.embeds[0];
    if (!embedData || !embedData.description) {
        console.warn(`[Gamelog:${tierName}] Embed or description missing. IP: ${sourceIp}`);
        // Encaminhar mesmo sem descrição pode ser uma opção, mas estatísticas e cooldown por jogo não funcionarão.
        // Tentativa de encaminhamento direto se não houver descrição para parsear GameID
        try {
            await axios.post(webhookUrl, req.body, { headers: { 'Content-Type': 'application/json' }, timeout: 7000 });
            return res.status(200).json({ status: 'success', message: 'Game log (sem gameId parseável) encaminhado.' });
        } catch (e) {
             console.error(`[Gamelog:${tierName}] Falha ao encaminhar log (sem gameId parseável): ${e.message}`);
             return res.status(502).json({ status: 'error', message: `Falha ao encaminhar: ${e.message}` });
        }
    }
    
    const gameData = parseGameDataFromEmbed(embedData.description);
    if (!gameData || !gameData.gameId) {
        console.warn(`[Gamelog:${tierName}] Não foi possível parsear gameId da descrição. Desc: ${embedData.description.substring(0,100)}... IP: ${sourceIp}`);
         try { // Encaminha o embed mesmo se não conseguiu o ID para stats.
            await axios.post(webhookUrl, req.body, { headers: { 'Content-Type': 'application/json' }, timeout: 7000 });
            return res.status(200).json({ status: 'success', message: 'Log recebido e encaminhado (gameId não parseado para stats).' });
        } catch (e) {
            console.error(`[Gamelog:${tierName}] Falha ao encaminhar log (gameId não parseado): ${e.message}`);
            return res.status(502).json({ status: 'error', message: `Falha ao encaminhar log: ${e.message}`});
        }
    }
    
    const now = Date.now();
    let gameEntry = gameStats.get(gameData.gameId) || { ...gameData, lastUpdate: 0, lastSuccessfulDiscordForward: 0, lastWebhookAttempt: 0 };
    
    // Atualiza dados do jogo
    gameEntry = { ...gameEntry, ...gameData, lastUpdate: now };
    gameStats.set(gameData.gameId, gameEntry);
    // console.log(`[Gamelog:${tierName}] Stats locais atualizadas para GameID: ${gameData.gameId}`);

    let shouldForwardToDiscord = false;
    if (now - gameEntry.lastSuccessfulDiscordForward > GAME_SPECIFIC_FORWARD_COOLDOWN_MS) {
        shouldForwardToDiscord = true;
    } else {
        console.log(`[Gamelog:${tierName}] GameID ${gameData.gameId}: Dentro do cooldown específico do jogo. Encaminhamento para Discord pulado.`);
    }

    if (shouldForwardToDiscord) {
        const lastGlobalAttemptForWebhook = webhookGlobalCooldowns.get(webhookUrl) || 0;
        if (now - lastGlobalAttemptForWebhook < GLOBAL_WEBHOOK_SEND_COOLDOWN_MS) {
            console.log(`[Gamelog:${tierName}] URL Webhook ${webhookUrl.substring(0,50)}: Dentro do cooldown GLOBAL. Encaminhamento para Discord adiado. GameID: ${gameData.gameId}`);
            // Responde ao cliente, mas não encaminha AGORA. Próxima requisição para este jogo (após cooldown do jogo) tentará novamente.
            return res.status(202).json({ status: 'processed_local_ratelimit_external', message: 'Log processado, encaminhamento para Discord em espera devido a rate limit global.' });
        }
        
        // Marca uma tentativa de envio para este webhook AGORA
        webhookGlobalCooldowns.set(webhookUrl, now);
        gameEntry.lastWebhookAttempt = now; // Marca a tentativa no jogo também
        gameStats.set(gameData.gameId, gameEntry);

        try {
            await axios.post(webhookUrl, req.body, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
            
            gameEntry.lastSuccessfulDiscordForward = now; // <<< SUCESSO
            gameStats.set(gameData.gameId, gameEntry); // Salva o timestamp de sucesso
            console.log(`[Gamelog:${tierName}] Encaminhado com sucesso para Discord (GameID: ${gameData.gameId}).`);
            res.status(200).json({ status: 'success', message: 'Game log recebido e encaminhado para Discord.' });
        
        } catch (error) {
            let errorDetail = error.message;
            if (error.response) {
                errorDetail = `Webhook respondeu com Status ${error.response.status}`;
                console.error(`[Gamelog:${tierName}] Webhook Error (GameID: ${gameData.gameId}): Status ${error.response.status}, Data: ${JSON.stringify(error.response.data).substring(0,200)}`);
                if (error.response.status === 429) {
                    const retryAfter = parseInt(error.response.headers['retry-after'], 10) || (GLOBAL_WEBHOOK_SEND_COOLDOWN_MS / 1000); // segundos
                    const newCooldownUntil = Date.now() + (retryAfter * 1000);
                    webhookGlobalCooldowns.set(webhookUrl, newCooldownUntil - GLOBAL_WEBHOOK_SEND_COOLDOWN_MS + 1000); // Ajusta para que a próxima tentativa possa ocorrer após retryAfter
                    console.warn(`[Gamelog:${tierName}] Discord 429! Webhook ${webhookUrl.substring(0,50)} em cooldown forçado por ${retryAfter}s.`);
                }
            } else {
                console.error(`[Gamelog:${tierName}] Erro de encaminhamento (GameID: ${gameData.gameId}): ${errorDetail}`);
            }
            res.status(502).json({ status: 'error', message: `Falha ao encaminhar: ${errorDetail}` });
        }
    } else {
        res.status(200).json({ status: 'success', message: 'Log processado, encaminhamento para Discord pulado (cooldown específico do jogo).' });
    }
    scheduleVoiceChannelUpdate(); // Agendar atualização dos canais de voz (com debounce)
}

// --- ROTAS (OAuth, Executor, Queue - Mantidas como no seu script) ---
app.get('/', (req, res) => { /* ... */ });
app.get('/verify/:username', async (req, res) => { /* ... (Use API_KEY aqui se esta rota for protegida) ... */ });
// ... (outras rotas existentes, certificando-se de que as que precisam de API Key continuam usando-a)
// Rota /send/scriptlogs DEVE usar API_KEY
app.post('/send/scriptlogs', async (req, res) => { 
    if (req.headers['authorization'] !== config.API_KEY && req.body?.apiKey !== config.API_KEY) { // Verifica header e body se desejar
        return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }
    // ... (resto da lógica do scriptlogs) ... 
});

async function ensureAuthenticatedAndAuthorized(req, res, next) { /* ... (seu código, sem alterações)... */ 
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
     if (!member && config.ADD_USER_TO_GUILD_IF_MISSING && user.accessToken) { /* ... (lógica de adicionar membro) ... */ }
    if (!member) { return res.status(403).send(`<h1>Access Denied</h1><p>Not in Discord server.</p><p><a href="/logout">Logout</a></p>`);}
    const hasRequiredRole = member.roles.cache.some(role => requiredRoleIds.includes(role.id));
    if (!hasRequiredRole) { return res.status(403).send(`<h1>Access Denied</h1><p>Missing required roles.</p><p><a href="/logout">Logout</a></p>`); }
    req.robloxUsername = userWhitelistEntry.User; 
    next();
  } catch (err) { console.error("Auth Middleware: Role/Guild check error", err); return res.status(500).send("Error verifying permissions."); }
}

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), async (req, res) => { /* ... */ res.redirect('/executor'); });
app.get('/logout', (req, res, next) => { /* ... */ });
app.get('/executor', ensureAuthenticatedAndAuthorized, (req, res) => { /* ... (HTML) ... */ });
app.post('/api/execute-script', ensureAuthenticatedAndAuthorized, async (req, res) => { /* ... */ });

// Rota /queue/* deve continuar usando API_KEY
app.post('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY && req.body?.apiKey !== config.API_KEY) {
         return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }
    // ... (resto da lógica da queue) ...
 });
app.get('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY && !isFromRoblox(req)) {
        return res.status(401).send('Unauthorized');
    }
    // ... (resto da lógica da queue) ...
});


// --- ROTAS DE GAMELOG (Chamando o handler modificado) ---
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

// --- DISCORD EVENT HANDLERS ---
discordClient.on('interactionCreate', async interaction => { /* ... (seu código, sem alterações diretas para este fix) ... */ 
  if (!interaction.isButton()) return;
  async function handleBlacklist(interaction) { if(!interaction.replied) await interaction.reply({content: "Blacklist (placeholder).", ephemeral: true}); }
  async function handleGetAssetOrScript(interaction) { if(!interaction.replied) await interaction.reply({content: "Get Asset (placeholder).", ephemeral: true}); }
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) { console.error('Interaction error:', error); /* ... (fallback reply) ... */ }
});
discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag}.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Logs & Scripts', { type: ActivityType.Playing }); 
  scheduleVoiceChannelUpdate(); // Agendar uma atualização inicial (após o debounce)
});

// --- PROCESS ERROR HANDLERS ---
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason, promise); /* ... (log to discord) ... */ });
process.on('uncaughtException', (error, origin) => { console.error('Uncaught Exception:', error, origin); /* ... (log to discord) ... */ });

// --- START SERVER ---
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
