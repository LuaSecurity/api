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
  PORT: process.env.PORT || 3000, // Render will set this PORT env var
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 1000,
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  ADD_USER_TO_GUILD_IF_MISSING: process.env.ADD_USER_TO_GUILD_IF_MISSING === 'true',

  WEBHOOK_GAMELOGS_2_9: process.env.WEBHOOK_GAMELOGS_2_9,
  WEBHOOK_GAMELOGS_10_49: process.env.WEBHOOK_GAMELOGS_10_49,
  WEBHOOK_GAMELOGS_50_200: process.env.WEBHOOK_GAMELOGS_50_200,
  WEBHOOK_GAMELOGS_PREMIUM: process.env.WEBHOOK_GAMELOGS_PREMIUM,

  // Ensure your .env has GAME_STATS_CURRENT_ACTIVE_VC_ID set to 1373732957910470699
  GAME_STATS_CURRENT_ACTIVE_VC_ID: process.env.GAME_STATS_CURRENT_ACTIVE_VC_ID || '1373732957910470699',
  GAME_STATS_TOTAL_GAMES_VC_ID: process.env.GAME_STATS_TOTAL_GAMES_VC_ID || '1373733192229720225',
};

// Critical check for essential environment variables
if (!config.API_KEY || 
    !config.GITHUB_TOKEN || 
    !config.DISCORD_BOT_TOKEN || 
    !config.GITHUB_LUA_MENU_URL ||
    !config.DISCORD_CLIENT_ID ||
    !config.DISCORD_CLIENT_SECRET ||
    !config.TARGET_GUILD_ID) {
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file for API_KEY, GITHUB_TOKEN, DISCORD_BOT_TOKEN, GITHUB_LUA_MENU_URL, BOT_CLIENT_ID, BOT_CLIENT_SECRET, SERVER_ID.');
  if (!config.DISCORD_CALLBACK_URL.startsWith('http://localhost') && !process.env.REDIRECT_URI) {
    console.error('Warning: REDIRECT_URI is not set, and default callback is localhost. This might be an issue if deploying.');
  }
  process.exit(1);
}
// Warnings for gamelogs and stats channels
if (!config.WEBHOOK_GAMELOGS_2_9 || !config.WEBHOOK_GAMELOGS_10_49 || !config.WEBHOOK_GAMELOGS_50_200 || !config.WEBHOOK_GAMELOGS_PREMIUM) {
    console.warn("Warning: One or more WEBHOOK_GAMELOGS URLs are not set. The /send/gamelogs feature might not work correctly.");
}
if (!config.GAME_STATS_CURRENT_ACTIVE_VC_ID || !config.GAME_STATS_TOTAL_GAMES_VC_ID){
    console.warn("Warning: One or both GAME_STATS voice channel IDs are not set. Stats display may fail.");
} else if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID === config.GAME_STATS_TOTAL_GAMES_VC_ID && config.GAME_STATS_TOTAL_GAMES_VC_ID) { // also check if GAME_STATS_TOTAL_GAMES_VC_ID is not null/empty
    console.warn(`Warning: GAME_STATS_CURRENT_ACTIVE_VC_ID (${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) and GAME_STATS_TOTAL_GAMES_VC_ID (${config.GAME_STATS_TOTAL_GAMES_VC_ID}) are the same. Only one statistic will be effectively displayed on that channel name.`);
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

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// --- Session and Passport Setup ---
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: process.env.NODE_ENV === 'production' ? undefined : undefined, // For production, use a persistent store like connect-redis or connect-mongo
  // cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production (HTTPS) - Render provides HTTPS
}));
if (process.env.NODE_ENV !== 'production') {
    console.warn(`Warning: connect.session() MemoryStore is not
designed for a production environment, as it will leak
memory, and will not scale past a single process. Consider using a persistent session store for production.`);
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
    const user = {
      id: profile.id, username: profile.username, discriminator: profile.discriminator,
      avatar: profile.avatar, guilds: profile.guilds, accessToken: accessToken
    };
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

// --- Helper Functions (existing: generateLogId, isFromRoblox, sendActionLogToDiscord, getWhitelistFromGitHub, updateWhitelistOnGitHub, sendToDiscordChannel) ---
// (Assuming these are correctly defined from your original full script)
function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); } // Not used in gamelogs path

async function sendActionLogToDiscord(title, description, interactionOrUser, color = 0x0099FF, additionalFields = []) {
    try {
        if (!config.LOG_CHANNEL_ID) {
            console.warn("sendActionLogToDiscord: LOG_CHANNEL_ID is not configured. Skipping log.");
            return;
        }
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(err => {
            console.error("sendActionLogToDiscord: Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID, "Error:", err.message);
            return null;
        });
        if (!logChannel) return;

        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        
        if (interactionOrUser) { 
            if (interactionOrUser.user) { 
                 logEmbed.addFields({ name: 'Action Initiated By', value: `${interactionOrUser.user.tag} (<@${interactionOrUser.user.id}>)`, inline: true });
                 if (interactionOrUser.guild) {
                     logEmbed.addFields({ name: 'Context', value: `Guild: ${interactionOrUser.guild.name}\nChannel: ${interactionOrUser.channel?.name || 'N/A'}`, inline: true });
                 }
            } else if (interactionOrUser.id && interactionOrUser.username) { 
                 logEmbed.addFields({ name: 'Action By User', value: `${interactionOrUser.username}#${interactionOrUser.discriminator} (<@${interactionOrUser.id}>)`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23) { // Max fields is 25, leaving room for more auto fields
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."}); break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("CRITICAL: Failed to send action log to Discord:", logSendError.message); }
}


// ... (ensure getWhitelistFromGitHub, updateWhitelistOnGitHub, sendToDiscordChannel, SCRIPT_IN_ATTACHMENT_PLACEHOLDER are here)

async function getWhitelistFromGitHub() {
  console.log(`Fetching whitelist: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
  let rawDataContent; 
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    rawDataContent = response.data; 
    if (response.status !== 200) {
        console.warn(`GitHub API returned status ${response.status} for getWhitelistFromGitHub.`);
        throw new Error(`GitHub API request failed with status ${response.status}`);
    }
    // console.log("Whitelist content fetched successfully from GitHub. Type of data:", typeof rawDataContent);
    let parsedWhitelist;
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") { 
          console.warn("getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(rawDataContent);
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) { // If github raw somehow returns parsed JSON array (less likely for raw accept header)
      parsedWhitelist = rawDataContent;
    } else {
      console.warn("getWhitelistFromGitHub: Received data was not a raw string or an array. Type:", typeof rawDataContent,"Data (partial):", JSON.stringify(rawDataContent).substring(0, 200));
      throw new Error('Unexpected GitHub response format for whitelist content.');
    }
    if (!Array.isArray(parsedWhitelist)) {
        console.warn("getWhitelistFromGitHub: Parsed whitelist is not an array. Type:", typeof parsedWhitelist, "Content (partial):", JSON.stringify(parsedWhitelist).substring(0,500));
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    // console.log(`Whitelist parsed. Found ${parsedWhitelist.length} entries.`);
    return parsedWhitelist;
  } catch (error) {
    console.error(`Error in getWhitelistFromGitHub: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,200) : (rawDataContent ? JSON.stringify(rawDataContent).substring(0, 200) : "N/A");
    await sendActionLogToDiscord(
        'GitHub Whitelist Fetch/Parse Error',
        `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}:\n**Error:** ${error.message}\n**Raw Data Preview:** \`\`\`${rawDataPreview}\`\`\``,
        null, 0xFF0000
    );
    throw new Error(`Failed to fetch or parse whitelist from GitHub. Path: ${config.WHITELIST_PATH}. Original: ${error.message}`);
  }
}
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
   try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Log channel not found for script log.');
    const embed = new EmbedBuilder(embedData); // embedData should be an object, not already an EmbedBuilder instance from body
    const messageOptions = { embeds: [embed], components: [] };
    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        const currentDescription = embed.data.description || '';
        embed.setDescription(currentDescription.replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
    }
    // Assuming handleBlacklist and handleGetAssetOrScript are defined elsewhere for button interactions.
    // If these buttons are only for this specific type of log, their definition or inclusion needs to be verified.
    // For now, I'll include them as per the original provided code.
    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download Found Assets')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!fullScriptContent || fullScriptContent.trim().length === 0)
    ));
    return channel.send(messageOptions);
  } catch (error) { console.error('Discord sendToDiscordChannel (script log) error:', error); }
}

// --- OAuth Middleware: ensureAuthenticatedAndAuthorized (Existing - assumed correct) ---
async function ensureAuthenticatedAndAuthorized(req, res, next) { /* ... Your existing function ... */ 
    if (!req.isAuthenticated()) {
    return res.redirect('/auth/discord'); 
  }

  const user = req.user;
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
  } catch (e) {
    console.error("Auth Middleware: Failed to get whitelist", e);
    await sendActionLogToDiscord("Authorization Error", "Failed to fetch whitelist for user authorization.", user, 0xFF0000, [{name: "Error", value: e.message}]);
    return res.status(500).send("Error checking whitelist status. Please try again later.");
  }

  const userWhitelistEntry = whitelist.find(entry => entry && entry.Discord === user.id);

  if (!userWhitelistEntry) {
    await sendActionLogToDiscord("Authorization Denied", "User not found in whitelist.", user, 0xFFA500);
    return res.status(403).send(`
      <h1>Access Denied</h1>
      <p>Your Discord account (${user.username}#${user.discriminator}) is not whitelisted for this service.</p>
      <p><a href="/logout">Logout</a></p>
    `);
  }

  const requiredRoleIds = Object.values(config.ROLES).filter(Boolean);
  if (requiredRoleIds.length === 0) {
    console.warn("No whitelist roles configured. Allowing access by default if user is in whitelist.json.");
    req.robloxUsername = userWhitelistEntry.User; 
    return next();
  }
  
  let member;
  try {
    const guild = await discordClient.guilds.fetch(config.TARGET_GUILD_ID);
    if (!guild) {
        await sendActionLogToDiscord("Authorization Error", `Target guild ${config.TARGET_GUILD_ID} not found or bot not in it.`, user, 0xFF0000);
        return res.status(500).send("Configuration error: Target guild not accessible.");
    }
    member = await guild.members.fetch(user.id).catch(() => null);

    if (!member && config.ADD_USER_TO_GUILD_IF_MISSING && user.accessToken) {
        console.log(`User ${user.username} not in guild ${config.TARGET_GUILD_ID}. Attempting to add.`);
        try {
            await guild.members.add(user.id, { accessToken: user.accessToken, roles: [] }); 
            member = await guild.members.fetch(user.id); 
            await sendActionLogToDiscord("User Auto-Joined Guild", `User ${user.username}#${user.discriminator} was automatically added to the guild.`, user, 0x00FF00);
        } catch (addError) {
            console.error(`Failed to add user ${user.id} to guild ${config.TARGET_GUILD_ID}:`, addError);
            await sendActionLogToDiscord("Guild Join Failed", `Attempted to add user ${user.username} to guild but failed.`, user, 0xFF0000, [{name: "Error", value: addError.message}]);
            if (!member) { 
                 return res.status(403).send(`
                    <h1>Access Denied</h1>
                    <p>You are not a member of the required Discord server. We attempted to add you but failed. Please join manually or contact support.</p>
                    <p><a href="/logout">Logout</a></p>
                `);
            }
        }
    } else if (!member) {
        await sendActionLogToDiscord("Authorization Denied", "User not in target guild.", user, 0xFFA500, [{name: "Guild ID", value: config.TARGET_GUILD_ID}]);
        return res.status(403).send(`
            <h1>Access Denied</h1>
            <p>You must be a member of our Discord server to use this service.</p>
            <p><a href="/logout">Logout</a></p>
        `);
    }

    const hasRequiredRole = member.roles.cache.some(role => requiredRoleIds.includes(role.id));
    if (!hasRequiredRole) {
        await sendActionLogToDiscord("Authorization Denied", "User does not have any required whitelist roles.", user, 0xFFA500, [{name: "Required Roles", value: requiredRoleIds.map(r => `<@&${r}>`).join(', ')}]);
        return res.status(403).send(`
            <h1>Access Denied</h1>
            <p>You do not have the necessary roles for this service.</p>
            <p><a href="/logout">Logout</a></p>
        `);
    }
    
    req.robloxUsername = userWhitelistEntry.User; 
    next();

  } catch (err) {
    console.error("Error during role/guild check:", err);
    await sendActionLogToDiscord("Authorization Error", "An error occurred during guild/role check.", user, 0xFF0000, [{name: "Error", value: err.message}]);
    return res.status(500).send("Error verifying your permissions. Please try again later.");
  }
}


// --- Express Routes (Existing: /, /verify/:username, etc. - assumed correct) ---
app.get('/', (req, res) => { /* ... */ });
app.get('/verify/:username', async (req, res) => { /* ... */ });
app.get('/download/:assetId', async (req, res) => { /* ... */ });
app.post('/send/scriptlogs', async (req, res) => { /* ... */ });
app.get('/scripts/LuaMenu', async (req, res) => { /* ... */ });

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), async (req, res) => { /* ... */ });
app.get('/logout', (req, res, next) => { /* ... */ });
app.get('/executor', ensureAuthenticatedAndAuthorized, (req, res) => { /* ... (HTML content) ... */ });
app.post('/api/execute-script', ensureAuthenticatedAndAuthorized, async (req, res) => { /* ... */ });
app.post('/queue/:username', async (req, res) => { /* ... */ });
app.get('/queue/:username', async (req, res) => { /* ... */ });

// Helper function to parse game data from embed description
function parseGameDataFromEmbed(description) {
    if (!description) return null;
    const parseNumeric = (str) => str ? parseInt(str.replace(/[\D]/g, ''), 10) : 0; // More robust parsing for numbers like `1,234` or `1.2k` (though k/M not handled yet)

    const gameIdMatch = description.match(/games\/(\d+)/);
    const gameNameMatch = description.match(/Game Name\*\*: (.*?)\n/);
    const activePlayersMatch = description.match(/Active Players\*\*:\s*\`?([\d,]+)\`?/); // Made backticks optional for parsing
    const serverPlayersMatch = description.match(/Server Players\*\*:\s*\`?(\d+)\/\d+\`?/);
    const visitsMatch = description.match(/Visits\*\*:\s*\`?([\d,]+)\`?/);
    const favoritesMatch = description.match(/Favourites\*\*:\s*\`?([\d,]+)\`?/);
    const jobInfoMatch = description.match(/launchData=([\w-]+)/);


    return {
        gameId: gameIdMatch ? gameIdMatch[1] : null,
        gameName: gameNameMatch ? gameNameMatch[1].trim() : "Unknown Game",
        activePlayers: activePlayersMatch ? parseNumeric(activePlayersMatch[1]) : 0,
        serverPlayers: serverPlayersMatch ? parseNumeric(serverPlayersMatch[1]) : 0,
        visits: visitsMatch ? parseNumeric(visitsMatch[1]) : 0,
        favorites: favoritesMatch ? parseNumeric(favoritesMatch[1]) : 0,
        jobInfo: jobInfoMatch ? jobInfoMatch[1] : null
    };
}

// Helper function to update Discord voice channel names
async function updateDiscordVoiceChannelNames() {
    if (!discordClient.isReady()) {
        console.warn("updateDiscordVoiceChannelNames: Discord client not ready. Skipping update.");
        return;
    }

    const now = Date.now();
    let totalActivePlayers = 0;
    // Use a Set to track unique game IDs contributing to player count, if players are global per gameId
    // If activePlayers from embed is "current players in this server instance", then just sum all non-expired.
    // Based on embed "Active Players", this sounds like total for the game.
    const uniqueActiveGamesForPlayerCount = new Map(); 


    for (const [gameId, data] of gameStats.entries()) {
        if (now - data.lastUpdate > GAME_DATA_EXPIRY_MS) {
            gameStats.delete(gameId);
            // console.log(`Game data expired and removed for game ID: ${gameId}`);
        } else {
            // We want sum of global "Active Players" for each unique game
             if (!uniqueActiveGamesForPlayerCount.has(gameId) || data.activePlayers > uniqueActiveGamesForPlayerCount.get(gameId)) {
                 uniqueActiveGamesForPlayerCount.set(gameId, data.activePlayers); // Store the highest reported active players for this game
             }
        }
    }
    
    uniqueActiveGamesForPlayerCount.forEach(players => totalActivePlayers += players);
    const totalUniqueGames = gameStats.size; // Count of non-expired, distinct gameIds we have info for.

    console.log(`[StatsUpdate] Calculated: Total Active Players = ${totalActivePlayers}, Total Unique Games = ${totalUniqueGames}`);
    const formatNumber = (num) => num.toLocaleString('en-US');

    // Update "Current Active Players" voice channel
    if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID) {
        try {
            const activePlayersChannel = await discordClient.channels.fetch(config.GAME_STATS_CURRENT_ACTIVE_VC_ID);
            if (activePlayersChannel && activePlayersChannel.type === ChannelType.GuildVoice) {
                const newName = `Current active: ${formatNumber(totalActivePlayers)}`;
                if (activePlayersChannel.name !== newName) {
                     await activePlayersChannel.setName(newName, 'Updating game statistics');
                     console.log(`[StatsUpdate] Updated 'Current active' VC (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) to: ${newName}`);
                } else {
                     // console.log(`[StatsUpdate] 'Current active' VC (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) name is already: ${newName}`);
                }
            } else {
                console.warn(`[StatsUpdate] Voice channel for active players (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) not found or not a voice channel.`);
            }
        } catch (error) {
            console.error(`[StatsUpdate] Error updating 'Current active players' voice channel (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}):`, error.message);
        }
    } else {
        console.warn("[StatsUpdate] GAME_STATS_CURRENT_ACTIVE_VC_ID is not set. Cannot update active players channel.");
    }


    // Update "Total Games" voice channel
    if (config.GAME_STATS_TOTAL_GAMES_VC_ID) {
        try {
            const totalGamesChannel = await discordClient.channels.fetch(config.GAME_STATS_TOTAL_GAMES_VC_ID);
            if (totalGamesChannel && totalGamesChannel.type === ChannelType.GuildVoice) {
                const newName = `Total Games: ${formatNumber(totalUniqueGames)}`;
                 if (totalGamesChannel.name !== newName) {
                    await totalGamesChannel.setName(newName, 'Updating game statistics');
                    console.log(`[StatsUpdate] Updated 'Total Games' VC (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}) to: ${newName}`);
                 } else {
                    // console.log(`[StatsUpdate] 'Total Games' VC (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}) name is already: ${newName}`);
                 }
            } else {
                console.warn(`[StatsUpdate] Voice channel for total games (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}) not found or not a voice channel.`);
            }
        } catch (error) {
            console.error(`[StatsUpdate] Error updating 'Total games' voice channel (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}):`, error.message);
        }
    } else {
        console.warn("[StatsUpdate] GAME_STATS_TOTAL_GAMES_VC_ID is not set. Cannot update total games channel.");
    }
}


async function gameLogRequestHandler(req, res, webhookUrl, tierName) {
    const sourceIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',').shift();
    console.log(`[Gamelog:${tierName}] PUBLIC Request received for endpoint: ${req.path} from IP: ${sourceIp}`); // Adicionado 'PUBLIC' para indicar a ausência de auth
    
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    // ATENÇÃO: A VERIFICAÇÃO DE API KEY FOI REMOVIDA DESTA FUNÇÃO CONFORME SOLICITADO
    // ISSO TORNA ESTE ENDPOINT PÚBLICO E SUJEITO A ABUSO
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

    // Verifica se o corpo da requisição e os embeds existem
    if (!req.body || !req.body.embeds || !req.body.embeds.length) {
        console.warn(`[Gamelog:${tierName}] PUBLIC: Dados de embed inválidos/ausentes. Preview do Body:`, JSON.stringify(req.body).substring(0, 200));
        return res.status(400).json({ status: 'error', message: 'Dados de embed inválidos ou ausentes.' });
    }

    // Verifica se a URL do webhook para o tier específico está configurada
    if (!webhookUrl) {
        console.error(`[Gamelog:${tierName}] PUBLIC: CRÍTICO: webhookUrl está INDEFINIDO para este tier. Path: ${req.path}`);
        // Evita enviar log para Discord sobre config interna em um endpoint público não autenticado,
        // a menos que você queira logar tentativas de acesso a tiers não configurados.
        // await sendActionLogToDiscord('Erro de Configuração GameLog', `Webhook URL está AUSENTE para o tier ${tierName} (Path: ${req.path}). O GameLog não pode ser encaminhado.`, null, 0xFF0000);
        return res.status(500).json({ status: 'error', message: 'Erro interno de configuração do servidor (URL do webhook ausente para este tier).' });
    }
    // console.log(`[Gamelog:${tierName}] PUBLIC: Target webhook: ${webhookUrl.substring(0,60)}...`);

    const embedData = req.body.embeds[0];
    if (!embedData || !embedData.description) {
        console.warn(`[Gamelog:${tierName}] PUBLIC: Dados do embed ou descrição ausentes no payload. Embed recebido:`, JSON.stringify(embedData).substring(0, 200));
    }
    
    const gameData = parseGameDataFromEmbed(embedData ? embedData.description : null);

    if (gameData && gameData.gameId) {
        const oldData = gameStats.get(gameData.gameId);
        gameStats.set(gameData.gameId, { ...gameData, lastUpdate: Date.now() });
        console.log(`[Gamelog:${tierName}] PUBLIC: Armazenado/Atualizado game ID: ${gameData.gameId} ('${gameData.gameName}'), Active: ${gameData.activePlayers}, Visits: ${gameData.visits}. Nova entrada: ${!oldData}`);
    } else {
        console.warn(`[Gamelog:${tierName}] PUBLIC: Não foi possível parsear um gameId válido ou outros dados cruciais para estatísticas. GameId parseado: ${gameData?.gameId}. GameName: ${gameData?.gameName}. Snippet da Descrição: ${(embedData && embedData.description || '').substring(0, 150)}...`);
    }
    
    try {
        // Como não há API key no corpo para remover (a menos que o cliente ainda envie),
        // encaminhamos req.body diretamente.
        const bodyParaEncaminhar = { ...req.body };
        // Se, por acaso, o cliente ainda enviar o campo 'apiKey' no corpo e você quiser removê-lo ANTES de encaminhar:
        if (bodyParaEncaminhar.apiKey) {
            // delete bodyParaEncaminhar.apiKey; // Descomente se quiser remover o campo 'apiKey' do corpo se presente
        }
        
        await axios.post(webhookUrl, bodyParaEncaminhar, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000 // 10 segundos de timeout
        });
        // console.log(`[Gamelog:${tierName}] PUBLIC: Encaminhado com sucesso para o webhook do tier.`);
        res.status(200).json({ status: 'success', message: 'Game log recebido e encaminhado.' });

        if (gameData && gameData.gameId) {
             await updateDiscordVoiceChannelNames(); 
        }

    } catch (error) {
        let errorDetail = error.message;
        let responseBodyPreview = "N/A";

        if (error.response) {
            errorDetail = `Webhook respondeu com Status ${error.response.status}`;
            responseBodyPreview = JSON.stringify(error.response.data).substring(0,300);
        } else if (error.request) {
            errorDetail = 'Sem resposta do servidor webhook (timeout ou problema de conexão)';
        }
        console.error(`[Gamelog:${tierName}] PUBLIC: Falha ao encaminhar log para gameId '${gameData?.gameId || 'N/A'}'. Erro: ${errorDetail}`);
        
        // Considerar se deve enviar este log de erro para o Discord, pois pode ser spamado se o endpoint for abusado.
        const fields = [
            { name: "Webhook URL", value: webhookUrl.substring(0,1000) },
            { name: "Error", value: errorDetail.substring(0,1020) }
        ];
        if(responseBodyPreview !== "N/A") fields.push({name: "Preview da Resposta do Webhook", value: `\`\`\`\n${responseBodyPreview}\n\`\`\``});
        if (gameData?.gameId) fields.push({ name: "Game ID (parseado)", value: gameData.gameId, inline: true});
        if (gameData?.gameName) fields.push({ name: "Game Name (parseado)", value: gameData.gameName.substring(0,100), inline: true});

        /* // Descomente com cautela para logar erros no Discord:
        await sendActionLogToDiscord(
            'Erro ao Encaminhar GameLog (Público)',
            `Falha ao encaminhar gamelog (endpoint público) para o webhook do tier **${tierName}**.`,
            null, 0xFF0000, fields
        );
        */
        res.status(502).json({ status: 'error', message: `Falha ao encaminhar game log: ${errorDetail}` });
    }
}

// Game Log API Routes
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


// Discord Event Handlers
discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // Placeholder functions for existing button handlers - ensure these are defined in your full script
  async function handleBlacklist(interaction) { 
      if(!interaction.replied && !interaction.deferred) await interaction.reply({content: "Blacklist (placeholder).", ephemeral: true}).catch(console.error);
      else if(interaction.deferred && !interaction.replied) await interaction.editReply({content: "Blacklist (placeholder).", ephemeral: true}).catch(console.error);
      console.log("handleBlacklist called");
  }
  async function handleGetAssetOrScript(interaction) { 
      if(!interaction.replied && !interaction.deferred) await interaction.reply({content: "Get Asset/Script (placeholder).", ephemeral: true}).catch(console.error);
      else if(interaction.deferred && !interaction.replied) await interaction.editReply({content: "Get Asset/Script (placeholder).", ephemeral: true}).catch(console.error);
      console.log("handleGetAssetOrScript called");
  }

  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) {
    console.error('Main Interaction error catcher:', error);
    await sendActionLogToDiscord( 'Main Interaction Catcher Error', `Error: ${error.message}\nStack: ${error.stack ? error.stack.substring(0,1000) : "No stack"}`, interaction, 0xFF0000);
    try {
        if (interaction.isRepliable()) {
            const replyOptions = { content: 'An unhandled error occurred processing this action. Admins have been notified.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(replyOptions).catch(e => console.error("Error sending fallback editReply:", e.message));
            } else {
                await interaction.reply(replyOptions).catch(e => console.error("Error sending fallback reply:", e.message));
            }
        }
    } catch(e) { console.error("Super fallback reply error", e.message); }
  }
});

discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Logs & Scripts', { type: ActivityType.Playing }); 
  updateDiscordVoiceChannelNames().catch(console.error); 
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  sendActionLogToDiscord('Unhandled Rejection', `Reason: ${reason}\nPromise: ${JSON.stringify(promise).substring(0,1000)}`, null, 0xCC0000)
    .catch(e => console.error("Failed to send unhandledRejection log", e));
});
process.on('uncaughtException', (error, origin) => {
  console.error('Uncaught Exception:', error, 'Origin:', origin);
   sendActionLogToDiscord('Uncaught Exception', `Error: ${error.message}\nOrigin: ${origin}\nStack: ${error.stack ? error.stack.substring(0,1000) : 'N/A'}`, null, 0xCC0000)
   .catch(e => console.error("Failed to send uncaughtException log", e));
  // Optional: process.exit(1) if it's truly fatal, but logging first is good.
});

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => { // Render sets PORT env variable
        console.log(`API listening on port ${config.PORT}. Bot connected to Discord.`);
        console.log(`OAuth Redirect URI should be: ${config.DISCORD_CALLBACK_URL}`);
        console.log(`Executor page: (your domain)/executor`); // Avoid localhost for deployed app
        console.log(`Gamelog endpoints like /send/gamelogs/9 are active.`);
        console.log(`Log Channel ID: ${config.LOG_CHANNEL_ID || 'NOT SET'}`);
        console.log(`Active Players VC ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID || 'NOT SET'}`);
        console.log(`Total Games VC ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID || 'NOT SET'}`);
    });
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
