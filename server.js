const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType, ChannelType } = require('discord.js');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1373755001234657320',
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100
};

if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables. Check your .env file.');
  process.exit(1);
}

const GAME_COUNTER_VOICE_CHANNEL_ID = '1375150160962781204';
const PLAYER_COUNTER_VOICE_CHANNEL_ID = '1375161884591783936';
const GAME_ID_TRACKING_DURATION_MS = 30 * 60 * 1000;
const GAME_COUNTER_UPDATE_INTERVAL_MS = 1 * 60 * 1000;
const TARGET_EMBED_CHANNEL_IDS = ['1354602804140048461', '1354602826864791612', '1354602856619184339', '1354602879473684521'];

const STAFF_LOG_WEBHOOK_URL_1 = process.env.RUBYHUBWEBHOOK;
const STAFF_LOG_WEBHOOK_URL_2 = process.env.MYWEBHOOK;

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '500mb' }));

let trackedGameIds = new Map();

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interaction, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel) {
            console.error("[ERROR] Failed to fetch log channel for reporting. Channel ID:", config.LOG_CHANNEL_ID);
            return;
        }
        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        if (interaction) {
            logEmbed.addFields({ name: 'Action Initiated By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true });
            if (interaction.guild) {
                 logEmbed.addFields({ name: 'Context', value: `Guild: ${interaction.guild.name}\nChannel: ${interaction.channel.name}`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23 && additionalFields.length > 0) {
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."}); break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) { console.error("[ERROR] CRITICAL: Failed to send action log to Discord:", logSendError); }
}

async function getWhitelistFromGitHub() {
  console.log(`[INFO] Fetching whitelist: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
  let rawDataContent;
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw', 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });
    rawDataContent = response.data;
    if (response.status !== 200) {
        console.warn(`[WARN] GitHub API returned status ${response.status} for getWhitelistFromGitHub.`);
        throw new Error(`GitHub API request failed with status ${response.status}`);
    }
    let parsedWhitelist;
    if (typeof rawDataContent === 'string') {
      if (rawDataContent.trim() === "") {
          console.warn("[WARN] getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(rawDataContent);
    } else if (rawDataContent && typeof rawDataContent.content === 'string') {
      console.warn("[WARN] getWhitelistFromGitHub: Received object with 'content' field, expected raw string. Attempting base64 decode.");
      const decodedContent = Buffer.from(rawDataContent.content, 'base64').toString('utf-8');
      if (decodedContent.trim() === "") {
          console.warn("[WARN] getWhitelistFromGitHub: Decoded whitelist file content is empty. Returning empty array.");
          return [];
      }
      parsedWhitelist = JSON.parse(decodedContent);
    } else if (typeof rawDataContent === 'object' && rawDataContent !== null && Array.isArray(rawDataContent)) {
      parsedWhitelist = rawDataContent;
    } else {
      console.warn("[WARN] getWhitelistFromGitHub: Received data was not a string, an object with 'content', or an array. Data (partial):", JSON.stringify(rawDataContent).substring(0, 500));
      throw new Error('Unexpected GitHub response format for whitelist content.');
    }
    if (!Array.isArray(parsedWhitelist)) {
        console.warn("[WARN] getWhitelistFromGitHub: Parsed whitelist is not an array. Type:", typeof parsedWhitelist, "Content (partial):", JSON.stringify(parsedWhitelist).substring(0,500));
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    console.log(`[INFO] Whitelist parsed. Found ${parsedWhitelist.length} entries.`);
    return parsedWhitelist;
  } catch (error) {
    console.error(`[ERROR] Error in getWhitelistFromGitHub: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,500) : (rawDataContent ? JSON.stringify(rawDataContent).substring(0, 500) : "N/A");
    await sendActionLogToDiscord(
        'GitHub Whitelist Fetch/Parse Error',
        `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}:\n**Error:** ${error.message}\n**Raw Data Preview (type ${typeof rawDataContent}):** \`\`\`${rawDataPreview}\`\`\``,
        null, 0xFF0000
    );
    const newError = new Error(`Failed to fetch or parse whitelist from GitHub. Path: ${config.WHITELIST_PATH}. Original: ${error.message}`);
    newError.cause = error;
    throw newError;
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist') {
  console.log("[INFO] Updating whitelist on GitHub...");
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
      sha: fileData.sha,
      branch: config.GITHUB_BRANCH
    });
    console.log("[INFO] Whitelist updated successfully on GitHub.");
    return true;
  } catch (error) {
    console.error(`[ERROR] GitHub API Error (updateWhitelist): Status ${error.status || 'N/A'}, Message: ${error.message}`);
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
    if (!channel) throw new Error(`Log channel not found for script log. ID: ${config.LOG_CHANNEL_ID}`);
    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };
    if (fullScriptContent && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        embed.setDescription((embed.data.description || '').replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
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
  } catch (error) {
      console.error('[ERROR] Discord sendToDiscordChannel (script log) error:', error);
  }
}

async function handleBlacklist(interaction) { }
async function handleGetAssetOrScript(interaction) { }

async function updateCounterChannels() {
    if (!discordClient || !discordClient.isReady()) {
        console.log("[DEBUG] updateCounterChannels: Bot not ready, skipping update.");
        return;
    }
    console.log("[DEBUG] updateCounterChannels: Running update cycle.");
    const now = Date.now();
    let activeGameCount = 0;
    let totalPlayerCount = 0;
    const idsToRemove = [];

    console.log("[DEBUG] Current trackedGameIds before cleanup:", new Map(trackedGameIds));

    for (const [gameId, data] of trackedGameIds.entries()) {
        if (data.expiryTimestamp < now) {
            idsToRemove.push(gameId);
            console.log(`[DEBUG] Game ID ${gameId} marked for expiration (Expired at: ${new Date(data.expiryTimestamp).toLocaleTimeString()}, Players: ${data.players}).`);
        } else {
            activeGameCount++;
            totalPlayerCount += (data.players || 0);
            console.log(`[DEBUG] Game ID ${gameId} is active. Players: ${data.players || 0}. Added to counts.`);
        }
    }

    if (idsToRemove.length > 0) {
        console.log(`[DEBUG] Removing ${idsToRemove.length} expired game IDs: ${idsToRemove.join(', ')}`);
        for (const id of idsToRemove) {
            trackedGameIds.delete(id);
        }
        console.log("[DEBUG] trackedGameIds after cleanup:", new Map(trackedGameIds));
    }

    console.log(`[DEBUG] Calculated counts - Active Games: ${activeGameCount}, Total Players: ${totalPlayerCount}`);

    try {
        console.log(`[DEBUG] Fetching game counter channel: ${GAME_COUNTER_VOICE_CHANNEL_ID}`);
        const gameChannel = await discordClient.channels.fetch(GAME_COUNTER_VOICE_CHANNEL_ID);
        if (gameChannel && gameChannel.type === ChannelType.GuildVoice) {
            const newGameChannelName = `Total Games: ${activeGameCount}`;
            console.log(`[DEBUG] Game Channel current name: "${gameChannel.name}", New target name: "${newGameChannelName}"`);
            if (gameChannel.name !== newGameChannelName) {
                console.log(`[DEBUG] Attempting to set Game Channel (${gameChannel.id}) name to: "${newGameChannelName}"`);
                await gameChannel.setName(newGameChannelName).catch(e => console.error(`[ERROR_SETNAME_GAME] Failed to set game channel name:`, e));
                console.log(`[SUCCESS_MAYBE] Updated game counter voice channel name to: "${newGameChannelName}" (or attempted)`);
            } else {
                console.log(`[DEBUG] Game Channel name is already up-to-date: "${newGameChannelName}"`);
            }
        } else if (gameChannel) {
            console.warn(`[WARN] Target channel ${GAME_COUNTER_VOICE_CHANNEL_ID} for games found, but it is not a GuildVoice channel. Actual Type: ${ChannelType[gameChannel.type]}`);
        } else {
             console.warn(`[WARN] Game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID} not found (fetch probably returned null).`);
        }
    } catch (error) {
        if (error.code === 10003) {
             console.warn(`[WARN] Game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID} does not exist or could not be fetched (Error 10003).`);
        } else if (error.name === 'DiscordAPIError' && error.status === 403) {
             console.error(`[ERROR] Missing permissions to update game counter voice channel ${GAME_COUNTER_VOICE_CHANNEL_ID}. Details: ${error.message}`);
        } else {
             console.error(`[ERROR] Error updating game counter voice channel name for ${GAME_COUNTER_VOICE_CHANNEL_ID}:`, error);
        }
    }

    try {
        console.log(`[DEBUG] Fetching player counter channel: ${PLAYER_COUNTER_VOICE_CHANNEL_ID}`);
        const playerChannel = await discordClient.channels.fetch(PLAYER_COUNTER_VOICE_CHANNEL_ID);
        if (playerChannel && playerChannel.type === ChannelType.GuildVoice) {
            const newPlayerChannelName = `Total Players: ${totalPlayerCount}`;
            console.log(`[DEBUG] Player Channel current name: "${playerChannel.name}", New target name: "${newPlayerChannelName}"`);
            if (playerChannel.name !== newPlayerChannelName) {
                console.log(`[DEBUG] Attempting to set Player Channel (${playerChannel.id}) name to: "${newPlayerChannelName}"`);
                await playerChannel.setName(newPlayerChannelName).catch(e => console.error(`[ERROR_SETNAME_PLAYER] Failed to set player channel name:`, e));
                console.log(`[SUCCESS_MAYBE] Updated player counter voice channel name to: "${newPlayerChannelName}" (or attempted)`);
            } else {
                console.log(`[DEBUG] Player Channel name is already up-to-date: "${newPlayerChannelName}"`);
            }
        } else if (playerChannel) {
            console.warn(`[WARN] Target channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} for players found, but it is not a GuildVoice channel. Actual Type: ${ChannelType[playerChannel.type]}`);
        } else {
            console.warn(`[WARN] Player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} not found (fetch probably returned null).`);
        }
    } catch (error) {
        if (error.code === 10003) {
            console.warn(`[WARN] Player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID} does not exist or could not be fetched (Error 10003).`);
        } else if (error.name === 'DiscordAPIError' && error.status === 403) {
            console.error(`[ERROR] Missing permissions to update player counter voice channel ${PLAYER_COUNTER_VOICE_CHANNEL_ID}. Details: ${error.message}`);
        } else {
            console.error(`[ERROR] Error updating player counter voice channel name for ${PLAYER_COUNTER_VOICE_CHANNEL_ID}:`, error);
        }
    }
}

app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access Denied.' }));

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  try {
    const whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) {
        console.error(`[ERROR] Verify error for ${username}: Whitelist data was not an array.`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array.`, null, 0xFF0000);
        return res.status(500).json({ status: 'error', message: "Internal server error: Whitelist data malformed." });
    }
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());
    if (!foundUser) {
      console.log(`[INFO] /verify/${username}: User not found in whitelist.`);
      return res.status(404).json({ status: 'error', message: "User not found in whitelist." });
    }
    console.log(`[INFO] /verify/${username}: User found.`);
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`[ERROR] Verify error for ${username} (route): ${error.message}`);
    if (!(error.message.includes("Failed to fetch or parse whitelist from GitHub"))) {
        await sendActionLogToDiscord('Whitelist Verification Route Error', `Unexpected error during /verify/${username}: ${error.message}`, null, 0xFF0000);
    }
    res.status(500).json({ status: 'error', message: "Internal server error during verification." });
  }
});

app.get('/download/:assetId', async (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID.' });
  const placeholderRbxmContent = `-- Roblox Asset: ${assetId}\n-- This is a placeholder file.\nprint("Asset ID: ${assetId}")`;
  res.set({ 'Content-Type': 'application/rbxm', 'Content-Disposition': `attachment; filename="${assetId}.rbxm"` }).send(placeholderRbxmContent);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length || !req.body.embeds[0]) return res.status(400).json({ status: 'error', message: 'Invalid or missing embed data.' });
  try {
    const embedData = req.body.embeds[0];
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    const fullScript = scriptMatch && scriptMatch[1] ? scriptMatch[1] : null;
    await sendToDiscordChannel(embedData, fullScript);
    res.status(200).json({ status: 'success', message: 'Log received.', logId: generateLogId() });
  } catch (error) {
      console.error('[ERROR] Error in /send/scriptlogs:', error.message);
      res.status(500).json({ status: 'error', message: "Processing script log failed on server." });
  }
});

app.post('/send/stafflogs', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  }
  const payload = req.body;
  if (!payload || (Object.keys(payload).length === 0 && payload.constructor === Object)) {
    return res.status(400).json({ status: 'error', message: 'Request body cannot be empty.' });
  }
  try {
    const promises = [
      axios.post(STAFF_LOG_WEBHOOK_URL_1, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }),
      axios.post(STAFF_LOG_WEBHOOK_URL_2, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 })
    ];
    const results = await Promise.allSettled(promises);
    let successCount = 0;
    let errors = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
        console.log(`[INFO] Successfully sent to staff webhook ${index + 1}`);
      } else {
        console.error(`[ERROR] Failed to send to staff webhook ${index + 1}:`, result.reason.message || result.reason);
        errors.push(`Webhook ${index + 1}: ${result.reason.message || 'Unknown error'}`);
      }
    });
    if (successCount === results.length) {
      res.status(200).json({ status: 'success', message: 'Payload forwarded to all staff webhooks.' });
    } else if (successCount > 0) {
      res.status(207).json({ status: 'partial_success', message: `Payload forwarded to ${successCount}/${results.length} staff webhooks.`, errors: errors });
    } else {
      res.status(500).json({ status: 'error', message: 'Failed to forward payload to any staff webhooks.', errors: errors });
    }
  } catch (error) {
    console.error('[ERROR] Error in /send/stafflogs general processing:', error.message);
    res.status(500).json({ status: 'error', message: 'Server error during staff log forwarding.' });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
        timeout: 8000,
        headers: { 'User-Agent': 'LuaWhitelistServer/1.9.2' }
    });
    res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (error) {
      console.error('[ERROR] Error /scripts/LuaMenu:', error.message);
      res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' });
  }
});

app.get('/module/id', async (req, res) => {
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  }
  try {
    const rawText = '119529617692199';
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).send(rawText);
  } catch (error) {
    console.error('[ERROR] Error /module/id:', error.message);
    res.status(500).json({ status: 'error', message: 'Failed to load data.' });
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  console.log(`[DEBUG] Button interaction received: ${interaction.customId} by ${interaction.user.tag}`);
});

discordClient.on('messageCreate', async message => {
    console.log(`[DEBUG] Message received in channel ID: ${message.channel.id} (Name: ${message.channel.name || 'N/A (DM?)'}) from user: ${message.author.tag}`);

    if (!TARGET_EMBED_CHANNEL_IDS.includes(message.channel.id)) {
        if (discordClient.user && message.author.id !== discordClient.user.id) {
        }
        return;
    }

    console.log(`[DEBUG] Message IS in a target channel: ${message.channel.id}`);

    if (!message.embeds || message.embeds.length === 0) {
        console.log("[DEBUG] Message has no embeds. Ignoring for counter purposes.");
        return;
    }
    console.log(`[DEBUG] Message has ${message.embeds.length} embed(s).`);

    let dataChangedThisMessage = false;
    const now = Date.now();
    const gameIdRegex = /Roblox\.GameLauncher\.joinGameInstance\(\s*(\d+)\s*,\s*"[^"]+"\s*\)/;
    const activePlayersRegex = /Active\s+Players\s*:\s*\`?(\d+)\`?/i;

    for (const embed of message.embeds) {
        console.log("[DEBUG] Embed Description (FULL for testing, might be long):", embed.description || "No description");

        if (!embed.description) {
            console.log("[DEBUG] Embed has no description. Skipping this embed.");
            continue;
        }

        const lowerDesc = embed.description.toLowerCase();
        const indexOfActivePlayers = lowerDesc.indexOf("active players");
        if (indexOfActivePlayers > -1) {
            const vicinityStart = Math.max(0, indexOfActivePlayers - 20);
            const vicinityEnd = Math.min(embed.description.length, indexOfActivePlayers + "active players".length + 20);
            const vicinity = embed.description.substring(vicinityStart, vicinityEnd);
            console.log(`[DEBUG_REGEX] Vicinity of 'Active Players' found by indexOf: "...${vicinity.replace(/\n/g, "\\n")}..."`);

            let charCodes = "";
            for(let i = 0; i < vicinity.length; i++) { charCodes += vicinity.charCodeAt(i) + " "; }
            console.log(`[DEBUG_REGEX] Char codes for vicinity: ${charCodes.trim()}`);
        } else {
            console.log("[DEBUG_REGEX] Substring 'active players' (lowercase) not found by indexOf in description.");
        }

        const gameIdMatch = embed.description.match(gameIdRegex);
        const playersMatch = embed.description.match(activePlayersRegex);

        console.log("[DEBUG] Game ID Match result:", gameIdMatch ? gameIdMatch[1] : "No match");
        console.log("[DEBUG] Players Match result:", playersMatch ? (playersMatch[1] + ` (full match: ${playersMatch[0]})`) : "No match");


        if (gameIdMatch && gameIdMatch[1]) {
            const gameId = gameIdMatch[1];
            const parsedPlayers = playersMatch && playersMatch[1] ? parseInt(playersMatch[1], 10) : NaN;
            const activePlayers = !isNaN(parsedPlayers) ? parsedPlayers : 0;

            console.log(`[DEBUG] For gameId ${gameId}: Parsed players string: "${playersMatch ? playersMatch[1] : 'N/A'}", Parsed int: ${parsedPlayers}, Final activePlayers: ${activePlayers}`);

            const currentGameData = trackedGameIds.get(gameId);
            const newExpiry = now + GAME_ID_TRACKING_DURATION_MS;

            console.log(`[DEBUG] For gameId ${gameId}: Current tracked data:`, currentGameData ? JSON.stringify(currentGameData) : "Not tracked yet");

            let gameIsNew = !currentGameData;
            let gameWasExpired = currentGameData && currentGameData.expiryTimestamp < now;
            let playerCountChangedForActiveGame = currentGameData && currentGameData.expiryTimestamp >= now && currentGameData.players !== activePlayers;

            if (gameIsNew) { console.log(`[DEBUG] Condition met: Game ${gameId} is NEW.`); }
            if (gameWasExpired) { console.log(`[DEBUG] Condition met: Game ${gameId} WAS EXPIRED.`); }
            if (playerCountChangedForActiveGame) { console.log(`[DEBUG] Condition met: Game ${gameId} PLAYER COUNT CHANGED.`); }

            if (gameIsNew || gameWasExpired || playerCountChangedForActiveGame) {
                dataChangedThisMessage = true;
                console.log(`[DEBUG] Change detected for game ${gameId}. Setting dataChangedThisMessage = true.`);
            }

            trackedGameIds.set(gameId, { expiryTimestamp: newExpiry, players: activePlayers });
        } else {
            console.log("[DEBUG] No gameId found in this embed's description. Skipping this embed for counter purposes.");
        }
    }

    if (dataChangedThisMessage) {
        console.log("[DEBUG] dataChangedThisMessage is TRUE. Calling updateCounterChannels() due to changes in this message.");
        await updateCounterChannels();
    } else {
        console.log("[DEBUG] dataChangedThisMessage is FALSE. No immediate channel update triggered by this specific message.");
    }
});

discordClient.on('ready', async () => {
  console.log(`[INFO] Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists', { type: ActivityType.Watching });

  console.log('[INFO] Bot ready, performing initial counter updates for games and players.');
  try {
      await updateCounterChannels();
      setInterval(updateCounterChannels, GAME_COUNTER_UPDATE_INTERVAL_MS);
      console.log(`[INFO] Game and Player counters initialized. Monitoring target embed channels: ${TARGET_EMBED_CHANNEL_IDS.join(', ')}. Updating 'Total Games' VC: ${GAME_COUNTER_VOICE_CHANNEL_ID}, 'Total Players' VC: ${PLAYER_COUNTER_VOICE_CHANNEL_ID}.`);
  } catch (initError) {
      console.error("[ERROR] Error during counter initialization in 'ready' event:", initError);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
});

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => console.log(`[INFO] API server listening on http://localhost:${config.PORT}. Discord Bot connected.`));
  } catch (error) {
    console.error('[FATAL] Startup failed:', error);
    process.exit(1);
  }
}

startServer();
