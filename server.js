require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType, ChannelType } = require('discord.js'); // Added ChannelType
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// Config from environment variables
const config = {
  // Your existing ENV VARS
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,

  // Mapped ENV VARS
  DISCORD_CLIENT_ID: process.env.BOT_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  DISCORD_CALLBACK_URL: process.env.REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
  TARGET_GUILD_ID: process.env.SERVER_ID,

  // Other configurations - SET THESE IN .env OR DIRECTLY IF NEEDED
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1331021897735081984', // Replace or set via ENV
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: { // Replace with your actual role IDs or set via ENV VARS like ROLE_STANDARD_ID etc.
    STANDARD: process.env.ROLE_STANDARD_ID || '1330552089759191064',
    PREMIUM: process.env.ROLE_PREMIUM_ID || '1333286640248029264',
    ULTIMATE: process.env.ROLE_ULTIMATE_ID || '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 1000,
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  ADD_USER_TO_GUILD_IF_MISSING: process.env.ADD_USER_TO_GUILD_IF_MISSING === 'true',

  // New ENV VARS for Game Log Tracking
  WEBHOOK_GAMELOGS_2_9: process.env.WEBHOOK_GAMELOGS_2_9,
  WEBHOOK_GAMELOGS_10_49: process.env.WEBHOOK_GAMELOGS_10_49,
  WEBHOOK_GAMELOGS_50_200: process.env.WEBHOOK_GAMELOGS_50_200,
  WEBHOOK_GAMELOGS_PREMIUM: process.env.WEBHOOK_GAMELOGS_PREMIUM,
  VOICE_CHANNEL_CURRENT_ACTIVE_ID: '1373733192229720225', // e.g., '1373733192229720225'
  VOICE_CHANNEL_TOTAL_GAMES_ID: '1373733192229720226',     // e.g., '1373733192229720226' (ensure this is different for separate channels)
};

// Critical check for essential environment variables based on your provided names
if (!config.API_KEY || 
    !config.GITHUB_TOKEN || 
    !config.DISCORD_BOT_TOKEN || 
    !config.GITHUB_LUA_MENU_URL ||
    !config.BOT_CLIENT_ID ||  // Was BOT_CLIENT_ID
    !config.BOT_CLIENT_SECRET || // Was BOT_CLIENT_SECRET
    !config.SERVER_ID) { // Was SERVER_ID
  console.error('FATAL ERROR: Missing essential environment variables. Please check your .env file for API_KEY, GITHUB_TOKEN, DISCORD_BOT_TOKEN, GITHUB_LUA_MENU_URL, BOT_CLIENT_ID, BOT_CLIENT_SECRET, SERVER_ID.');
  if (!config.DISCORD_CALLBACK_URL.startsWith('http://localhost') && !process.env.REDIRECT_URI) {
    console.error('Warning: REDIRECT_URI is not set, and default callback is localhost. This might be an issue if deploying.');
  }
  process.exit(1);
}

// Check for new game log webhook URLs (optional, feature-specific)
if (!config.WEBHOOK_GAMELOGS_2_9 || !config.WEBHOOK_GAMELOGS_10_49 || !config.WEBHOOK_GAMELOGS_50_200 || !config.WEBHOOK_GAMELOGS_PREMIUM) {
    console.warn("Warning: One or more WEBHOOK_GAMELOGS_... environment variables are not set. The /send/gamelogs feature will not fully function.");
}
if (!config.VOICE_CHANNEL_CURRENT_ACTIVE_ID || !config.VOICE_CHANNEL_TOTAL_GAMES_ID) {
    console.warn("Warning: VOICE_CHANNEL_CURRENT_ACTIVE_ID or VOICE_CHANNEL_TOTAL_GAMES_ID is not set. Voice channel stat updates will be disabled.");
} else if (config.VOICE_CHANNEL_CURRENT_ACTIVE_ID === config.VOICE_CHANNEL_TOTAL_GAMES_ID) {
    console.log("Info: VOICE_CHANNEL_CURRENT_ACTIVE_ID and VOICE_CHANNEL_TOTAL_GAMES_ID are the same. A combined name will be used for this channel.");
}


const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

// --- In-memory queue for scripts ---
const scriptQueue = new Map();

// --- In-memory store for game statistics ---
const gameStatsData = new Map(); // gameId -> { gameId, activePlayers, visits, favourites, expiryTimestamp }
const GAME_STAT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// --- Session and Passport Setup ---
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser(async (obj, done) => {
    done(null, obj);
});


passport.use(new DiscordStrategy({
  clientID: config.DISCORD_CLIENT_ID,
  clientSecret: config.DISCORD_CLIENT_SECRET,
  callbackURL: config.DISCORD_CALLBACK_URL,
  scope: ['identify', 'guilds', 'guilds.join'] 
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = {
      id: profile.id,
      username: profile.username,
      discriminator: profile.discriminator,
      avatar: profile.avatar,
      guilds: profile.guilds,
      accessToken: accessToken 
    };
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

// --- Helper Functions (existing and new) ---
function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interactionOrUser, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error("Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID);
            return;
        }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        
        if (interactionOrUser) { 
            if (interactionOrUser.user) { 
                 logEmbed.addFields({ name: 'Action Initiated By', value: `${interactionOrUser.user.tag} (<@${interactionOrUser.user.id}>)`, inline: true });
                 if (interactionOrUser.guild) {
                     logEmbed.addFields({ name: 'Context', value: `Guild: ${interactionOrUser.guild.name}\nChannel: ${interactionOrUser.channel.name}`, inline: true });
                 }
            } else if (interactionOrUser.id && interactionOrUser.username) { 
                 logEmbed.addFields({ name: 'Action By User', value: `${interactionOrUser.username}#${interactionOrUser.discriminator} (<@${interactionOrUser.id}>)`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23 && additionalFields.length > 0) {
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."}); break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("CRITICAL: Failed to send action log to Discord:", logSendError); }
}

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
    let parsedWhitelist;
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") { 
          console.warn("getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(rawDataContent);
    } else if (rawDataContent && typeof rawDataContent.content === 'string') { 
      const decodedContent = Buffer.from(rawDataContent.content, 'base64').toString('utf-8');
      if (decodedContent.trim() === "") {
          console.warn("getWhitelistFromGitHub: Decoded whitelist file content is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(decodedContent);
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) {
      parsedWhitelist = rawDataContent;
    } else {
      console.warn("getWhitelistFromGitHub: Received data was not a string, an object with 'content', or an array.");
      throw new Error('Unexpected GitHub response format for whitelist content.');
    }
    if (!Array.isArray(parsedWhitelist)) {
        console.warn("getWhitelistFromGitHub: Parsed whitelist is not an array.");
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    return parsedWhitelist;
  } catch (error) {
    console.error(`Error in getWhitelistFromGitHub: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,500) : (rawDataContent ? JSON.stringify(rawDataContent).substring(0, 500) : "N/A");
    await sendActionLogToDiscord(
        'GitHub Whitelist Fetch/Parse Error',
        `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}:\n**Error:** ${error.message}\n**Raw Data Preview:** \`\`\`${rawDataPreview}\`\`\``,
        null, 0xFF0000
    );
    const newError = new Error(`Failed to fetch or parse whitelist from GitHub. Path: ${config.WHITELIST_PATH}. Original: ${error.message}`);
    newError.cause = error; 
    throw newError;
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
  console.log("Updating whitelist on GitHub...");
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha, branch: config.GITHUB_BRANCH
    });
    console.log("Whitelist updated successfully on GitHub.");
    return true;
  } catch (error) {
    console.error(`GitHub API Error (updateWhitelist): Status ${error.status}, Message: ${error.message}`);
    await sendActionLogToDiscord( 'GitHub Whitelist Update Error', `Failed to update whitelist: ${error.message}`, null, 0xFF0000);
    const newError = new Error(`Failed to update whitelist on GitHub. Original: ${error.message}`);
    newError.cause = error;
    throw newError;
  }
}

const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel) throw new Error('Log channel not found for script log.');
    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };
    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        embed.setDescription((embed.data.description || '').replace(/```lua\n[\s\S]*?\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
      }
    }
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

// --- Game Log Tracking Helpers ---
function safeParseInt(value) {
    if (typeof value !== 'string') return 0;
    return parseInt(value.replace(/,/g, ''), 10) || 0;
}

function parseGameInfoFromEmbed(embed) {
    if (!embed || !embed.description) {
        console.warn("parseGameInfoFromEmbed: Embed or description missing.");
        return null;
    }
    const desc = embed.description;
    let gameId = null;

    // Regex to find Game ID from Game Link or Join Link
    const gameLinkMatch = desc.match(/https?:\/\/www\.roblox\.com\/games\/(\d+)/);
    if (gameLinkMatch && gameLinkMatch[1]) {
        gameId = gameLinkMatch[1];
    } else {
        // Try to find from Join Link structure if different
        const joinLinkMatch = desc.match(/placeId=(\d+)/);
        if (joinLinkMatch && joinLinkMatch[1]) {
            gameId = joinLinkMatch[1];
        }
    }
    
    if (!gameId) {
        console.warn("parseGameInfoFromEmbed: Could not parse gameId from embed description.");
        // console.debug("Description for gameId parse failure:", desc); // For debugging
        return null;
    }

    const activePlayersMatch = desc.match(/> \*\*Active Players\*\*: `?([\d,]+)`?/);
    const activePlayers = activePlayersMatch ? safeParseInt(activePlayersMatch[1]) : 0;

    const visitsMatch = desc.match(/> \*\*Visits\*\*: `?([\d,]+)`?/);
    const visits = visitsMatch ? safeParseInt(visitsMatch[1]) : 0;

    const favsMatch = desc.match(/> \*\*Favourites\*\*: `?([\d,]+)`?/);
    const favourites = favsMatch ? safeParseInt(favsMatch[1]) : 0;
    
    return { gameId, activePlayers, visits, favourites };
}

let isUpdatingChannelNames = false; // Simple lock to prevent concurrent updates
async function updateGameStatsAndVoiceChannels() {
    if (isUpdatingChannelNames) {
        // console.log("Voice channel name update already in progress. Skipping.");
        return;
    }
    isUpdatingChannelNames = true;

    try {
        const now = Date.now();
        let totalActivePlayers = 0;
        let totalUniqueGames = 0;
        // const totalVisits = 0; // Not typically summed up this way for dynamic stats
        // const totalFavourites = 0; // Same as visits

        for (const [gameId, stats] of gameStatsData.entries()) {
            if (now > stats.expiryTimestamp) {
                gameStatsData.delete(gameId);
            } else {
                totalActivePlayers += stats.activePlayers;
                totalUniqueGames++;
                // If you needed to sum latest visits/favs:
                // totalVisits += stats.visits;
                // totalFavourites += stats.favourites;
            }
        }

        const activeChannelId = config.VOICE_CHANNEL_CURRENT_ACTIVE_ID;
        const totalGamesChannelId = config.VOICE_CHANNEL_TOTAL_GAMES_ID;

        if (!discordClient.isReady()) {
            console.warn("updateGameStatsAndVoiceChannels: Discord client not ready. Skipping update.");
            return;
        }

        const activeName = `Current Active: ${totalActivePlayers.toLocaleString()}`;
        const totalGamesName = `Total Games: ${totalUniqueGames.toLocaleString()}`;

        if (activeChannelId && totalGamesChannelId && activeChannelId === totalGamesChannelId) {
            const combinedName = `Active: ${totalActivePlayers.toLocaleString()} | Games: ${totalUniqueGames.toLocaleString()}`;
            try {
                const channel = await discordClient.channels.fetch(activeChannelId);
                if (channel && channel.type === ChannelType.GuildVoice) {
                    if (channel.name !== combinedName) {
                        await channel.setName(combinedName);
                        console.log(`Updated combined voice channel (${channel.id}) name: ${combinedName}`);
                    }
                } else if (channel) {
                    console.warn(`Channel ${activeChannelId} is not a voice channel.`);
                } else {
                     console.warn(`Channel ${activeChannelId} not found for combined stats.`);
                }
            } catch (err) {
                console.error(`Error updating combined voice channel ${activeChannelId}: ${err.message}`);
            }
        } else {
            if (activeChannelId) {
                try {
                    const channel = await discordClient.channels.fetch(activeChannelId);
                    if (channel && channel.type === ChannelType.GuildVoice) {
                        if (channel.name !== activeName) {
                            await channel.setName(activeName);
                            console.log(`Updated active players voice channel (${channel.id}) name: ${activeName}`);
                        }
                    } else if (channel) {
                        console.warn(`Channel ${activeChannelId} is not a voice channel.`);
                    } else {
                        console.warn(`Channel ${activeChannelId} not found for active players stats.`);
                    }
                } catch (err) {
                    console.error(`Error updating active players voice channel ${activeChannelId}: ${err.message}`);
                }
            }
            if (totalGamesChannelId) {
                 try {
                    const channel = await discordClient.channels.fetch(totalGamesChannelId);
                    if (channel && channel.type === ChannelType.GuildVoice) {
                        if (channel.name !== totalGamesName) {
                            await channel.setName(totalGamesName);
                            console.log(`Updated total games voice channel (${channel.id}) name: ${totalGamesName}`);
                        }
                    } else if (channel) {
                         console.warn(`Channel ${totalGamesChannelId} is not a voice channel.`);
                    } else {
                        console.warn(`Channel ${totalGamesChannelId} not found for total games stats.`);
                    }
                } catch (err) {
                    console.error(`Error updating total games voice channel ${totalGamesChannelId}: ${err.message}`);
                }
            }
        }
    } catch (error) {
        console.error("Error in updateGameStatsAndVoiceChannels:", error);
    } finally {
        isUpdatingChannelNames = false;
    }
}
// Periodically update/prune stats even if no new logs come in
setInterval(updateGameStatsAndVoiceChannels, 5 * 60 * 1000); // Every 5 minutes


// --- OAuth Middleware: Check if user is authenticated and authorized ---
async function ensureAuthenticatedAndAuthorized(req, res, next) {
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
    return res.status(403).send(`<h1>Access Denied</h1><p>Your Discord account (${user.username}#${user.discriminator}) is not whitelisted for this service.</p><p><a href="/logout">Logout</a></p>`);
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
                 return res.status(403).send(`<h1>Access Denied</h1><p>You are not a member of the required Discord server. We attempted to add you but failed. Please join manually or contact support.</p><p><a href="/logout">Logout</a></p>`);
            }
        }
    } else if (!member) {
        await sendActionLogToDiscord("Authorization Denied", "User not in target guild.", user, 0xFFA500, [{name: "Guild ID", value: config.TARGET_GUILD_ID}]);
        return res.status(403).send(`<h1>Access Denied</h1><p>You must be a member of our Discord server to use this service.</p><p><a href="/logout">Logout</a></p>`);
    }
    const hasRequiredRole = member.roles.cache.some(role => requiredRoleIds.includes(role.id));
    if (!hasRequiredRole) {
        await sendActionLogToDiscord("Authorization Denied", "User does not have any required whitelist roles.", user, 0xFFA500, [{name: "Required Roles", value: requiredRoleIds.map(r => `<@&${r}>`).join(', ')}]);
        return res.status(403).send(`<h1>Access Denied</h1><p>You do not have the necessary roles for this service.</p><p><a href="/logout">Logout</a></p>`);
    }
    req.robloxUsername = userWhitelistEntry.User; 
    next();
  } catch (err) {
    console.error("Error during role/guild check:", err);
    await sendActionLogToDiscord("Authorization Error", "An error occurred during guild/role check.", user, 0xFF0000, [{name: "Error", value: err.message}]);
    return res.status(500).send("Error verifying your permissions. Please try again later.");
  }
}


// --- Express Routes (existing and new) ---
app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
        res.redirect('/executor');
    } else {
        res.send(`<h1>Welcome to Lua Executor</h1><p>Please log in with Discord to continue.</p><a href="/auth/discord" style="padding: 10px 20px; background-color: #7289DA; color: white; text-decoration: none; border-radius: 5px;">Login with Discord</a><hr><p><small>Roblox Verification Endpoint: /verify/:username</small></p><p><small>Lua Menu Script Endpoint: /scripts/LuaMenu</small></p>`);
    }
});

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  let whitelist;
  try {
    whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) { 
        console.error(`Verify error for ${username}: Whitelist data from GitHub was not an array. Type: ${typeof whitelist}`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array. Type received: ${typeof whitelist}.`, null, 0xFF0000);
        return res.status(500).json({ status: 'error', message: "Internal server error: Whitelist data malformed." });
    }
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());
    if (!foundUser) {
      return res.status(404).json({ status: 'error', message: "User not found in whitelist." });
    }
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`Verify error for ${username} (caught in route): ${error.message}`);
    if (!(error.message.includes("Failed to fetch or parse whitelist from GitHub"))) {
        await sendActionLogToDiscord('Whitelist Verification Route Error', `Unexpected error during /verify/${username}: ${error.message}`, null, 0xFF0000);
    }
    res.status(500).json({ status: 'error', message: "Internal server error during verification." });
  }
});

app.get('/download/:assetId', async (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  const placeholderRbxmContent = `-- Roblox Asset: ${assetId}\n-- This is a placeholder file. Use the ID on the Roblox website or in Studio.`;
  res.set({ 'Content-Type': 'application/rbxm', 'Content-Disposition': `attachment; filename="${assetId}.rbxm"` }).send(placeholderRbxmContent);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data.' });
  try {
    const embedData = req.body.embeds[0];
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    await sendToDiscordChannel(embedData, scriptMatch ? scriptMatch[1] : null);
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) { console.error('Error /send/scriptlogs:', error.message); res.status(500).json({ status: 'error', message: "Processing script log failed." }); }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, { timeout: 8000, headers: { 'User-Agent': 'LuaWhitelistServer/1.9' }});
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(response.data);
  } catch (error) { console.error('Error /scripts/LuaMenu:', error.message); res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' }); }
});

// --- New Game Log Routes ---
const gameLogTiers = {
    '9': config.WEBHOOK_GAMELOGS_2_9,
    '49': config.WEBHOOK_GAMELOGS_10_49,
    '200': config.WEBHOOK_GAMELOGS_50_200,
    'Premium': config.WEBHOOK_GAMELOGS_PREMIUM,
};

app.post('/send/gamelogs/:tier', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }

    const tier = req.params.tier;
    const webhookUrl = gameLogTiers[tier];

    if (!webhookUrl) {
        return res.status(400).json({ status: 'error', message: 'Invalid game log tier specified.' });
    }

    if (!req.body || !req.body.embeds || !req.body.embeds.length) {
        return res.status(400).json({ status: 'error', message: 'Invalid or missing embed data in request body.' });
    }

    try {
        // 1. Forward to Discord Webhook
        await axios.post(webhookUrl, req.body, {
            headers: { 'Content-Type': 'application/json' }
        });
        // console.log(`Game log for tier ${tier} forwarded to webhook.`);

        // 2. Parse and Store Game Info
        const embed = req.body.embeds[0];
        const gameInfo = parseGameInfoFromEmbed(embed);

        if (gameInfo && gameInfo.gameId) {
            const expiryTimestamp = Date.now() + GAME_STAT_EXPIRY_MS;
            gameStatsData.set(gameInfo.gameId, { ...gameInfo, expiryTimestamp });
            // console.log(`Stored/updated game stats for game ID: ${gameInfo.gameId}`);
            
            // 3. Update Voice Channels (asynchronously, don't wait for it to respond to HTTP)
            updateGameStatsAndVoiceChannels().catch(err => {
                console.error("Error during async voice channel update from game log route:", err);
            });
        } else {
            console.warn(`Could not parse game info from received gamelog for tier ${tier}.`);
        }

        res.status(200).json({ status: 'success', message: `Game log received and processed for tier ${tier}.` });

    } catch (error) {
        console.error(`Error processing /send/gamelogs/${tier}:`, error.message);
        if (error.isAxiosError) {
            console.error("Axios error details:", error.response?.data);
        }
        await sendActionLogToDiscord(
            'Game Log Processing Error',
            `Failed to process game log for tier ${tier}.\nError: ${error.message}`,
            null, 0xFF0000,
            [{name: "Tier", value: tier, inline: true}, {name: "Webhook URL (partial)", value: webhookUrl.substring(0, webhookUrl.indexOf("?")+10) + "..." , inline:true}]
        );
        res.status(500).json({ status: 'error', message: 'Failed to process game log.' });
    }
});


// --- OAuth Routes ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }), 
  async (req, res) => {
    await sendActionLogToDiscord("User Login Success (OAuth)", `User successfully logged in via Discord.`, req.user, 0x5865F2);
    res.redirect('/executor'); 
  }
);
app.get('/logout', (req, res, next) => {
  const user = req.user;
  req.logout(err => {
    if (err) { return next(err); }
    req.session.destroy(async (err) => {
      if (err) {
        console.error("Session destruction error:", err);
        if (user) await sendActionLogToDiscord("Logout Error", `Error destroying session for user.`, user, 0xFF0000, [{name: "Error", value: err.message}]);
        return res.status(500).send("Could not log out properly.");
      }
      if (user) await sendActionLogToDiscord("User Logout", `User logged out.`, user, 0xAAAAAA);
      res.clearCookie('connect.sid'); 
      res.redirect('/');
    });
  });
});


// --- Executor Page Route ---
app.get('/executor', ensureAuthenticatedAndAuthorized, (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Lua Executor</title><link rel="stylesheet" data-name="vs/editor/editor.main" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/editor/editor.main.min.css"><style>body{font-family:sans-serif;margin:0;background-color:#2c2f33;color:#fff;display:flex;flex-direction:column;height:100vh}.top-bar{background-color:#23272a;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 2px 4px rgba(0,0,0,.2)}.top-bar h1{margin:0;font-size:1.5em}.top-bar .user-info{font-size:.9em}.top-bar .user-info img{width:30px;height:30px;border-radius:50%;vertical-align:middle;margin-right:8px}.top-bar a{color:#7289da;text-decoration:none;margin-left:15px}.main-content{display:flex;flex-direction:column;flex-grow:1;padding:15px}#editor-container{flex-grow:1;border:1px solid #4f545c;border-radius:4px;overflow:hidden;margin-bottom:15px}.controls{margin-bottom:15px;display:flex;gap:10px}.controls button{padding:10px 20px;border:none;border-radius:4px;cursor:pointer;font-weight:700;transition:background-color .2s}.execute-btn{background-color:#5865f2;color:#fff}.execute-btn:hover{background-color:#4752c4}.clear-btn{background-color:#747f8d;color:#fff}.clear-btn:hover{background-color:#636c78}#status{margin-top:10px;padding:10px;background-color:#23272a;border-radius:4px;font-size:.9em;min-height:20px}</style></head><body><div class="top-bar"><h1>Lua Executor</h1><div class="user-info">${req.user.avatar?`<img src="https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png?size=64" alt="avatar">`:""} Logged in as: <strong>${req.user.username}#${req.user.discriminator}</strong> (Roblox: ${req.robloxUsername||"N/A"}) <a href="/logout">Logout</a></div></div><div class="main-content"><div class="controls"><button id="execute-btn" class="execute-btn">Execute Script (for ${req.robloxUsername||"N/A"})</button><button id="clear-btn" class="clear-btn">Clear Editor</button></div><div id="editor-container"></div><div id="status">Ready. Enter your Lua script for Lua Serverside.</div></div><script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/loader.min.js"></script><script>let editor;require.config({paths:{vs:"https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs"}}),require(["vs/editor/editor.main"],function(){editor=monaco.editor.create(document.getElementById("editor-container"),{value:'-- Lua Serverside Script Executor\\nprint("Hello from Lua Executor!")',language:"lua",theme:"vs-dark",automaticLayout:!0})});const statusDiv=document.getElementById("status");document.getElementById("execute-btn").addEventListener("click",async()=>{const t=editor.getValue();if(!t.trim())return statusDiv.textContent="Error: Script is empty.",void(statusDiv.style.color="#ff6b6b");statusDiv.textContent="Executing...",statusDiv.style.color="#f1c40f";try{const e=await fetch("/api/execute-script",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({script:t})}),o=await e.json();e.ok?(statusDiv.textContent=\`Success: \${o.message} (Log ID: \${o.logId})\`,statusDiv.style.color="#2ecc71"):(statusDiv.textContent=\`Error (\${e.status}): \${o.message||"Failed to send script."}\`,statusDiv.style.color="#ff6b6b")}catch(t){console.error("Execution error:",t),statusDiv.textContent="Network error or server unavailable.",statusDiv.style.color="#ff6b6b"}}),document.getElementById("clear-btn").addEventListener("click",()=>{editor.setValue(""),statusDiv.textContent="Editor cleared.",statusDiv.style.color="#fff"});</script></body></html>`);
});

// --- API Route for Executor to send script ---
app.post('/api/execute-script', ensureAuthenticatedAndAuthorized, async (req, res) => {
    const { script } = req.body;
    const user = req.user; 
    const robloxUsername = req.robloxUsername; 
    if (!script || typeof script !== 'string' || script.trim() === '') {
        return res.status(400).json({ status: 'error', message: 'Script content is missing or empty.' });
    }
    if (!robloxUsername) { 
        await sendActionLogToDiscord("Execution Error", "Roblox username missing for authenticated user during script execution.", user, 0xFF0000);
        return res.status(500).json({ status: 'error', message: 'Internal error: Could not determine Roblox username.' });
    }
    try {
        scriptQueue.set(robloxUsername, script); 
        const logId = generateLogId();
        await sendActionLogToDiscord("Script Queued via Executor", `Script queued for Roblox user **${robloxUsername}** by Discord user ${user.username}#${user.discriminator}.`, user, 0x3498DB, [{ name: "Roblox Username", value: robloxUsername, inline: true }, { name: "Log ID", value: logId, inline: true }, { name: "Script Preview (first 200 chars)", value: `\`\`\`lua\n${script.substring(0, 200)}${script.length > 200 ? '...' : ''}\n\`\`\`` }]);
        console.log(`Script for ${robloxUsername} added to queue by ${user.username}. Length: ${script.length}`);
        res.status(200).json({ status: 'success', message: `Script queued for ${robloxUsername}.`, logId: logId });
    } catch (error) {
        console.error(`Error proxying script to queue for ${robloxUsername}:`, error);
        await sendActionLogToDiscord("Execution Error", `Failed to queue script for ${robloxUsername}.`, user, 0xFF0000, [{name: "Error", value: error.message}]);
        res.status(500).json({ status: 'error', message: 'Failed to send script to internal queue.' });
    }
});


// --- Queue API Routes ---
app.post('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
    }
    const username = req.params.username;
    const scriptContent = req.body.script; 
    if (!username) {
        return res.status(400).json({ status: 'error', message: 'Username parameter is required.' });
    }
    if (!scriptContent || typeof scriptContent !== 'string' || scriptContent.trim() === '') {
        return res.status(400).json({ status: 'error', message: 'Script content is missing or empty.' });
    }
    scriptQueue.set(username, scriptContent);
    const logId = generateLogId();
    console.log(`Script for ${username} added to queue via direct POST. Log ID: ${logId}`);
    await sendActionLogToDiscord("Script Queued (Direct API)", `Script queued for Roblox user **${username}** via direct API call.`, null, 0x1ABC9C, [{ name: "Roblox Username", value: username, inline: true }, { name: "Log ID", value: logId, inline: true }, { name: "Source IP", value: req.ip, inline: true }, { name: "Script Preview (first 200 chars)", value: `\`\`\`lua\n${scriptContent.substring(0, 200)}${scriptContent.length > 200 ? '...' : ''}\n\`\`\`` }]);
    res.status(200).json({ status: 'success', message: 'Script queued.', logId: logId });
});

app.get('/queue/:username', async (req, res) => {
    if (req.headers['authorization'] !== config.API_KEY && !isFromRoblox(req)) { 
         console.warn(`/queue GET: Unauthorized access attempt for ${req.params.username} from IP ${req.ip}`);
         return res.status(401).send('Unauthorized'); 
    }
    const username = req.params.username;
    if (!username) {
        return res.status(400).send('Username parameter is required.');
    }
    if (scriptQueue.has(username)) {
        const script = scriptQueue.get(username);
        scriptQueue.delete(username); 
        console.log(`Script retrieved from queue for ${username} by ${isFromRoblox(req) ? 'Roblox Game' : 'API Key User'}.`);
        await sendActionLogToDiscord("Script Dequeued", `Script retrieved from queue for Roblox user **${username}**. Initiated by ${isFromRoblox(req) ? 'Roblox Game' : 'API User'}.`, null, 0x2ECC71, [{ name: "Roblox Username", value: username, inline: true }, { name: "Source IP", value: req.ip, inline: true }]);
        res.set('Content-Type', 'text/plain; charset=utf-8').send(script);
    } else {
        res.status(404).send('-- No script in queue'); 
    }
});


// --- Discord Event Handlers ---
// ... (Existing handleBlacklist and handleGetAssetOrScript functions should be here if they were previously elided)
async function handleBlacklist(interaction) { 
    // Placeholder: Implement actual blacklist logic
    // 1. Extract user ID / Roblox username from the original message embed.
    // 2. Update Whitelist.json on GitHub to mark the user as blacklisted or remove them.
    // 3. Reply to interaction.
    console.log("handleBlacklist called by", interaction.user.tag);
    try {
        if (!interaction.message || !interaction.message.embeds || !interaction.message.embeds.length) {
            return interaction.reply({ content: "Could not find the original log data to blacklist.", ephemeral: true });
        }
        const originalEmbed = interaction.message.embeds[0];
        const fields = originalEmbed.fields || [];
        const robloxUserField = fields.find(f => f.name === 'Roblox Username');
        const discordUserField = fields.find(f => f.name === 'Discord User' || f.name.includes('Initiated By') || f.name.includes('Action By User'));
        
        let robloxUsernameToBlacklist = null;
        let discordIdToBlacklist = null;

        if (robloxUserField) {
            robloxUsernameToBlacklist = robloxUserField.value;
        }
        if (discordUserField) {
            const match = discordUserField.value.match(/<@!?(\d+)>/);
            if (match && match[1]) {
                discordIdToBlacklist = match[1];
            }
        }

        if (!robloxUsernameToBlacklist && !discordIdToBlacklist) {
             return interaction.reply({ content: "Could not identify a Roblox username or Discord ID from the log to blacklist.", ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });

        let whitelist = await getWhitelistFromGitHub();
        let updated = false;
        let blacklistedUsers = [];

        if (robloxUsernameToBlacklist) {
            const userIndex = whitelist.findIndex(entry => entry.User && entry.User.toLowerCase() === robloxUsernameToBlacklist.toLowerCase());
            if (userIndex !== -1) {
                whitelist[userIndex].Blacklisted = true; // Or remove: whitelist.splice(userIndex, 1);
                whitelist[userIndex].Reason = `Blacklisted by ${interaction.user.tag} via log interaction.`;
                updated = true;
                blacklistedUsers.push(`Roblox: ${robloxUsernameToBlacklist}`);
            }
        }
        if (discordIdToBlacklist) {
             const userIndex = whitelist.findIndex(entry => entry.Discord === discordIdToBlacklist);
             if (userIndex !== -1) {
                if(!whitelist[userIndex].Blacklisted) { // Avoid duplicate message part if already blacklisted by roblox username
                    blacklistedUsers.push(`Discord: <@${discordIdToBlacklist}> (Roblox: ${whitelist[userIndex].User})`);
                }
                whitelist[userIndex].Blacklisted = true;
                whitelist[userIndex].Reason = `Blacklisted by ${interaction.user.tag} via log interaction.`;
                updated = true;
             } else if (robloxUsernameToBlacklist && !updated) { // If discord ID not found but roblox user was, it implies they might not be linked, or one of them is wrong
                 // This case is mostly handled if robloxUsernameToBlacklist also triggered a blacklist.
                 // If only discordIdToBlacklist was found in embed, but not in whitelist, we can't do much more.
             }
        }
        
        if (updated) {
            await updateWhitelistOnGitHub(whitelist, `Blacklist action by ${interaction.user.tag}`);
            await sendActionLogToDiscord('User Blacklisted via Log', `User(s) blacklisted by ${interaction.user.tag}.\nDetails: ${blacklistedUsers.join(', ')}`, interaction, 0xFF0000);
            await interaction.editReply({ content: `Successfully blacklisted: ${blacklistedUsers.join(', ')}.` });
        } else {
            await interaction.editReply({ content: "User(s) not found in whitelist or already actioned." });
        }

    } catch (error) {
        console.error("Error in handleBlacklist:", error);
        await sendActionLogToDiscord('Blacklist Interaction Error', `Error: ${error.message}`, interaction, 0xFF0000);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error blacklisting user.', ephemeral: true });
        else if(interaction.deferred) await interaction.editReply({ content: 'Error blacklisting user.' });
    }
}

async function handleGetAssetOrScript(interaction) {
    // Placeholder: Implement actual asset/script retrieval
    // 1. Extract script content or asset IDs from the original message embed/attachment.
    // 2. Reply with the content (as text or file).
    console.log("handleGetAssetOrScript called by", interaction.user.tag);
    try {
        if (!interaction.message || !interaction.message.embeds || !interaction.message.embeds.length) {
            return interaction.reply({ content: "Could not find the original log data.", ephemeral: true });
        }

        const originalEmbed = interaction.message.embeds[0];
        let scriptContent = null;

        // Check attachment first (if using SCRIPT_IN_ATTACHMENT_PLACEHOLDER)
        if (interaction.message.attachments.size > 0) {
            const attachment = interaction.message.attachments.first();
            if (attachment.name.endsWith('.lua')) {
                const response = await axios.get(attachment.url, { responseType: 'text' });
                scriptContent = response.data;
            }
        }
        
        // If not in attachment, try to extract from embed description
        if (!scriptContent && originalEmbed.description) {
            const scriptMatch = originalEmbed.description.match(/```lua\n([\s\S]*?)\n```/);
            if (scriptMatch && scriptMatch[1] && scriptMatch[1] !== SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) {
                scriptContent = scriptMatch[1];
            }
        }

        if (!scriptContent || scriptContent.trim() === '') {
            return interaction.reply({ content: "No script content found in this log.", ephemeral: true });
        }

        if (scriptContent.length > 1900) { // Discord message limit is 2000
            const attachment = new AttachmentBuilder(Buffer.from(scriptContent, 'utf-8'), { name: 'retrieved_script.lua' });
            await interaction.reply({ content: "Retrieved script (attached due to length):", files: [attachment], ephemeral: true });
        } else {
            await interaction.reply({ content: `Retrieved script:\n\`\`\`lua\n${scriptContent}\n\`\`\``, ephemeral: true });
        }
        await sendActionLogToDiscord('Script Retrieved via Log', `Script content retrieved by ${interaction.user.tag} from a log message.`, interaction, 0x00FF00);

    } catch (error) {
        console.error("Error in handleGetAssetOrScript:", error);
        await sendActionLogToDiscord('Asset/Script Retrieval Error', `Error: ${error.message}`, interaction, 0xFF0000);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error retrieving script/asset.', ephemeral: true });
        else if(interaction.deferred) await interaction.editReply({ content: 'Error retrieving script/asset.' });
    }
}


discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === 'blacklist_user_from_log') await handleBlacklist(interaction);
    else if (interaction.customId === 'get_asset_script_from_log') await handleGetAssetOrScript(interaction);
  } catch (error) {
    console.error('Main Interaction error catcher:', error);
    await sendActionLogToDiscord( 'Main Interaction Catcher Error', `Error: ${error.message}\n\`\`\`${error.stack ? error.stack.substring(0,1000) : "No stack"}\n\`\`\``, interaction, 0xFF0000);
    if (interaction.isRepliable()) {
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'An unhandled error occurred. Admins notified.', ephemeral: true }).catch(e => console.error("Error sending fallback reply:", e));
        else if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: 'An unhandled error occurred. Admins notified.', ephemeral: true }).catch(e => console.error("Error sending fallback editReply:", e));
    }
  }
});

discordClient.on('ready', () => {
  console.log(`Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists & Scripts', { type: ActivityType.Watching }); 
  updateGameStatsAndVoiceChannels(); // Initial update when bot starts
});

// --- Error Handlers & Startup ---
process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection:', r, p));
process.on('uncaughtException', e => console.error('Uncaught Exception:', e));

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => {
        console.log(`API on http://localhost:${config.PORT}, Bot connected.`);
        console.log(`Discord OAuth Redirect URI should be: ${config.DISCORD_CALLBACK_URL}`);
        console.log(`Executor available at: http://localhost:${config.PORT}/executor (after login)`);
    });
  } catch (error) { console.error('Startup failed:', error); process.exit(1); }
}

startServer();
