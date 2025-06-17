const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
const { StatusCodes } = require('http-status-codes');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1373755001234657320',
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'LuaSecurity',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100,
  STAFF_LOG_WEBHOOK_URL_1: process.env.RUBYHUBWEBHOOK,
  STAFF_LOG_WEBHOOK_URL_2: process.env.MYWEBHOOK,
  LUA_MENU_CACHE_TTL_MS: 5 * 60 * 1000
};

if (!config.API_KEY || !config.GITHUB_TOKEN || !config.DISCORD_BOT_TOKEN || !config.GITHUB_LUA_MENU_URL) {
  console.error('FATAL ERROR: Missing essential environment variables. API_KEY, GITHUB_TOKEN, DISCORD_BOT_TOKEN, GITHUB_LUA_MENU_URL are required. Check your .env file or environment configuration.');
  process.exit(1);
}

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '500mb' }));

let luaMenuCache = {
    content: null,
    lastFetched: 0
};

function generateLogId() { return crypto.randomBytes(8).toString('hex'); }
function isFromRoblox(req) { return (req.headers['user-agent'] || '').includes('Roblox'); }

async function sendActionLogToDiscord(title, description, interaction, color = 0x0099FF, additionalFields = []) {
    try {
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased()) {
            console.error(`[ERROR] Failed to fetch log channel or it's not a text channel. Channel ID: ${config.LOG_CHANNEL_ID}`);
            return;
        }
        const logEmbed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(description.substring(0, 4090))
            .setTimestamp();

        if (interaction && interaction.user) {
            logEmbed.addFields({ name: 'Action Initiated By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true });
            if (interaction.guild && interaction.channel) {
                 logEmbed.addFields({ name: 'Context', value: `Guild: ${interaction.guild.name}\nChannel: ${interaction.channel.name}`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23) {
                logEmbed.addFields({name: "Details Truncated", value: "Too many fields for one embed."});
                break;
            }
            logEmbed.addFields(field);
        }
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) {
        console.error("[ERROR] CRITICAL: Failed to send action log to Discord:", logSendError.message, logSendError.stack);
    }
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

    if (response.status !== StatusCodes.OK) {
        console.warn(`[WARN] GitHub API returned status ${response.status} for getWhitelistFromGitHub.`);
        throw new Error(`GitHub API request failed with status ${response.status}`);
    }

    if (typeof rawDataContent !== 'string') {
      console.warn(`[WARN] getWhitelistFromGitHub: Expected raw string content from GitHub, but received type: ${typeof rawDataContent}. Data (partial): ${String(rawDataContent).substring(0, 500)}`);
      throw new Error('Unexpected GitHub response format for whitelist content. Expected raw string.');
    }

    if (rawDataContent.trim() === "") {
        console.warn("[WARN] getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
        return [];
    }

    const parsedWhitelist = JSON.parse(rawDataContent);

    if (!Array.isArray(parsedWhitelist)) {
        console.warn(`[WARN] getWhitelistFromGitHub: Parsed whitelist is not an array. Type: ${typeof parsedWhitelist}. Content (partial): ${JSON.stringify(parsedWhitelist).substring(0,500)}`);
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    console.log(`[INFO] Whitelist successfully fetched and parsed. Found ${parsedWhitelist.length} entries.`);
    return parsedWhitelist;
  } catch (error) {
    const errorMessage = `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`;
    console.error(`[ERROR] ${errorMessage}: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,500) : (rawDataContent ? String(rawDataContent).substring(0, 500) : "N/A (Raw data unavailable or not a string)");
    await sendActionLogToDiscord(
        'GitHub Whitelist Fetch/Parse Error',
        `${errorMessage}\n**Error:** ${error.message}\n**Raw Data Preview (type ${typeof rawDataContent}):** \`\`\`${rawDataPreview}\`\`\``,
        null, 0xFF0000
    );
    const newError = new Error(`${errorMessage}. Original: ${error.message}`);
    newError.cause = error;
    throw newError;
  }
}

async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist via API') {
  console.log("[INFO] Attempting to update whitelist on GitHub...");
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
    const errorMessage = `GitHub API Error (updateWhitelist): Status ${error.status || 'N/A'}, Message: ${error.message}`;
    console.error(`[ERROR] ${errorMessage}`, error.stack);
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
    if (!channel || !channel.isTextBased()) throw new Error(`Log channel not found or not text-based. ID: ${config.LOG_CHANNEL_ID}`);

    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };
    let scriptToLog = fullScriptContent;

    if (fullScriptContent && typeof fullScriptContent === 'string' && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        if (embed.data.description) {
            embed.setDescription(embed.data.description.replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        } else {
            embed.setDescription(SCRIPT_IN_ATTACHMENT_PLACEHOLDER);
        }
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
        scriptToLog = SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT;
      }
    }

    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download Found Assets')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!scriptToLog || scriptToLog === SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT)
    ));

    return channel.send(messageOptions);
  } catch (error) {
      console.error('[ERROR] Discord sendToDiscordChannel (script log) error:', error.message, error.stack);
  }
}

async function handleBlacklist(interaction) {
  await interaction.reply({ content: 'Blacklist functionality is not yet implemented.', ephemeral: true });
}
async function handleGetAssetOrScript(interaction) {
  await interaction.reply({ content: 'Asset/Script download from log is not yet implemented.', ephemeral: true });
}

app.get('/', (req, res) => res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Access Denied.' }));

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Username required.' });

  try {
    const whitelist = await getWhitelistFromGitHub();
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());

    if (!foundUser) {
      console.log(`[INFO] /verify/${username}: User not found in whitelist.`);
      return res.status(StatusCodes.NOT_FOUND).json({ status: 'error', message: "User not found in whitelist." });
    }
    console.log(`[INFO] /verify/${username}: User found.`);
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`[ERROR] Verify route error for ${username}: ${error.message}`, error.stack);
    if (!(error.message.includes("Failed to get/parse whitelist") || error.message.includes("Failed to fetch or parse whitelist"))) {
        await sendActionLogToDiscord('Whitelist Verification Route Error', `Unexpected error during /verify/${username}: ${error.message}`, null, 0xFF0000);
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ status: 'error', message: "Internal server error during verification." });
  }
});

app.get('/download/:assetId', (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Invalid asset ID format.' });

  const placeholderRbxmContent = `-- Roblox Asset ID: ${assetId}\n-- This is a placeholder for asset download functionality.\nprint("Placeholder for Asset ID: ${assetId}")`;
  res.set({
    'Content-Type': 'application/rbxm',
    'Content-Disposition': `attachment; filename="asset_${assetId}.rbxm"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }).send(placeholderRbxmContent);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(StatusCodes.UNAUTHORIZED).json({ status: 'error', message: 'Invalid API key.' });
  if (!req.body?.embeds?.length || !req.body.embeds) return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Invalid or missing embed data.' });

  try {
    const embedData = req.body.embeds; // This is the embed object from your Lua script
    const scriptMatch = (embedData.description || '').match(/```lua\n([\s\S]*?)\n```/);
    const fullScript = scriptMatch && scriptMatch ? scriptMatch : null;

    // This function formats and sends the log to your Discord channel
    await sendToDiscordChannel(embedData, fullScript);
    res.status(StatusCodes.OK).json({ status: 'success', message: 'Log received and processed.', logId: generateLogId() });
  } catch (error) {
      console.error('[ERROR] Error in /send/scriptlogs:', error.message, error.stack);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ status: 'error', message: "Processing script log failed on server." });
  }
});

// The function that sends data to Discord
async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) throw new Error(`Log channel not found or not text-based. ID: ${config.LOG_CHANNEL_ID}`);

    const embed = new EmbedBuilder(embedData); // Creates a Discord.js embed from the Lua payload
    const messageOptions = { embeds: [embed], components: [] };
    let scriptToLog = fullScriptContent; // Variable for button disable logic

    if (fullScriptContent && typeof fullScriptContent === 'string' && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        // If script is too long, replace in description and add as attachment
        if (embed.data.description) {
            embed.setDescription(embed.data.description.replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        } else {
            embed.setDescription(SCRIPT_IN_ATTACHMENT_PLACEHOLDER);
        }
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
        scriptToLog = SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT; // Update for button state
      }
    }

    // Add buttons (blacklist, download asset - though download might refer to something else here)
    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log') // This button's utility might need review in context of a logged script
        .setLabel('Download Found Assets') // Label might be confusing, could be "View Full Script" if placeholder used
        .setStyle(ButtonStyle.Primary)
        // Disable button if there's no script or it's just the placeholder text in the log itself.
        // It's mainly useful when an attachment ISN'T present (script is short and in embed) or
        // if you implement functionality for it to download the attachment.
        .setDisabled(!scriptToLog || scriptToLog === SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT)
    ));

    return channel.send(messageOptions);
  } catch (error) {
      console.error('[ERROR] Discord sendToDiscordChannel (script log) error:', error.message, error.stack);
      // Avoid sending error response to the client (Roblox) for Discord internal errors here
  }
}

// Helper: SCRIPT_IN_ATTACHMENT_PLACEHOLDER and SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT should be defined as in your original code
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT = '[Full script content attached as a .lua file due to length.]';
const SCRIPT_IN_ATTACHMENT_PLACEHOLDER = '```lua\n' + SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT + '\n```';

app.post('/send/stafflogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });

  const payload = req.body;
  if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0 && payload.constructor === Object)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Request body cannot be empty.' });
  }

  const webhookTasks = [];
  if (config.STAFF_LOG_WEBHOOK_URL_1) webhookTasks.push({ name: "Staff Webhook 1 (RUBYHUBWEBHOOK)", url: config.STAFF_LOG_WEBHOOK_URL_1 });
  if (config.STAFF_LOG_WEBHOOK_URL_2) webhookTasks.push({ name: "Staff Webhook 2 (MYWEBHOOK)", url: config.STAFF_LOG_WEBHOOK_URL_2 });

  if (webhookTasks.length === 0) {
    console.warn('[WARN] /send/stafflogs: No staff log webhook URLs configured or URLs are empty. Log not forwarded.');
    return res.status(StatusCodes.OK).json({ status: 'success', message: 'Request processed, but no staff log webhooks are configured.' });
  }

  try {
    const promises = webhookTasks.map(wh =>
      axios.post(wh.url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 })
    );
    const results = await Promise.allSettled(promises);

    let successCount = 0;
    const errors = [];

    results.forEach((result, index) => {
      const webhookName = webhookTasks[index].name;
      if (result.status === 'fulfilled') {
        successCount++;
        console.log(`[INFO] Successfully sent to ${webhookName}. Status: ${result.value.status}`);
      } else {
        const reason = result.reason;
        let errorMessage = 'Unknown error during webhook send.';
        if (reason.isAxiosError) {
          errorMessage = `AxiosError: ${reason.message}`;
          if (reason.response) {
            errorMessage += ` (Status: ${reason.response.status}, Data: ${JSON.stringify(reason.response.data).substring(0,100)}...)`;
          }
        } else if (reason instanceof Error) {
          errorMessage = reason.message;
        } else if (typeof reason === 'string') {
          errorMessage = reason;
        }
        console.error(`[ERROR] Failed to send to ${webhookName}: ${errorMessage}`, reason.stack ? `\nStack: ${reason.stack}` : '');
        errors.push(`${webhookName}: ${errorMessage}`);
      }
    });

    if (successCount === webhookTasks.length) {
      res.status(StatusCodes.OK).json({ status: 'success', message: 'Payload forwarded to all staff webhooks.' });
    } else if (successCount > 0) {
      res.status(StatusCodes.MULTI_STATUS).json({ status: 'partial_success', message: `Payload forwarded to ${successCount}/${webhookTasks.length} staff webhooks.`, errors });
    } else {
      res.status(StatusCodes.BAD_GATEWAY).json({ status: 'error', message: 'Failed to forward payload to any staff webhooks.', errors });
    }
  } catch (error) {
    console.error('[ERROR] Error in /send/stafflogs general processing:', error.message, error.stack);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ status: 'error', message: 'Server error during staff log forwarding process.' });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });

  if (luaMenuCache.content && (Date.now() - luaMenuCache.lastFetched < config.LUA_MENU_CACHE_TTL_MS)) {
    console.log('[INFO] Serving LuaMenu from cache.');
    return res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': `public, max-age=${Math.round((config.LUA_MENU_CACHE_TTL_MS - (Date.now() - luaMenuCache.lastFetched)) / 1000)}`,
        'X-Content-Type-Options': 'nosniff'
    }).send(luaMenuCache.content);
  }

  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
        timeout: 8000,
        headers: { 'User-Agent': 'LuaWhitelistServer/2.0.0_Optimized' }
    });

    luaMenuCache.content = response.data;
    luaMenuCache.lastFetched = Date.now();
    console.log('[INFO] Fetched and cached LuaMenu script from GitHub.');

    res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': `public, max-age=${Math.round(config.LUA_MENU_CACHE_TTL_MS / 1000)}`,
        'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (error) {
      const status = error.response?.status || StatusCodes.INTERNAL_SERVER_ERROR;
      const errorMessage = error.isAxiosError ? `${error.message} (Axios Error, Status: ${error.response?.status})` : error.message;
      console.error(`[ERROR] Error fetching /scripts/LuaMenu: ${errorMessage}`, error.stack);
      res.status(status).json({ status: 'error', message: 'Failed to load LuaMenu script.' });
  }
});

// MODIFIED ROUTES START HERE

app.get('/module/id', (req, res) => {
  // Redirect if the method is not GET (which is inherently true for app.get handlers)
  // OR if the request is not from Roblox.
  if (req.method !== 'GET' || !isFromRoblox(req)) {
    return res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
  // If it's a GET request from Roblox, send the text.
  const rawText = '119529617692199';
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  }).send(rawText);
});

app.get('/module/id-uhqdjkkajskncajwdghajdakwfkawofqweudajfdoa', (req, res) => {
  if (req.method !== 'GET' || !isFromRoblox(req)) {
    return res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
  const rawText = '998889275562590';
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  }).send(rawText);
});

app.get('/module/id-uhaiasdakdfjasdnzkcmasooefjssoawrjfdsllmwciwefowdfgwerjd', (req, res) => {
  if (req.method !== 'GET' || !isFromRoblox(req)) {
    return res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
  const rawText = '0';
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  }).send(rawText);
});

// MODIFIED ROUTES END HERE

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  console.log(`[DEBUG] Button interaction received: ${interaction.customId} from ${interaction.user.tag} (${interaction.user.id})`);

  try {
    if (interaction.customId === 'blacklist_user_from_log') {
      await handleBlacklist(interaction);
    } else if (interaction.customId === 'get_asset_script_from_log') {
      await handleGetAssetOrScript(interaction);
    } else {
      console.log(`[WARN] Unhandled button interaction: ${interaction.customId}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'This button is not configured for a response.', ephemeral: true });
      }
    }
  } catch (error) {
    console.error(`[ERROR] Failed to handle button interaction ${interaction.customId}:`, error.message, error.stack);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: 'An error occurred while processing this action.', ephemeral: true });
      } catch (replyError) {
        console.error('[ERROR] Failed to send error reply to interaction:', replyError.message);
      }
    }
  }
});

discordClient.on('messageCreate', async message => {
});

discordClient.on('ready', async () => {
  console.log(`[INFO] Bot logged in as ${discordClient.user.tag}.`);
  console.log(`[INFO] Monitoring ${discordClient.guilds.cache.size} guild(s).`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists & Logs', { type: ActivityType.Watching });
  console.log('[INFO] Discord Bot is ready. Core services initialized.');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason instanceof Error ? `${reason.message}\n${reason.stack}` : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message, `\nStack: ${error.stack}`);
  console.error('Application will now exit due to uncaught exception.');
  sendActionLogToDiscord(
    "FATAL Uncaught Exception",
    `Error: ${error.message}\n\`\`\`${error.stack}\`\`\``,
    null,
    0xFF0000
  ).finally(() => {
    process.exit(1);
  });
});

let serverInstance;

async function startServer() {
  try {
    console.log('[INFO] Logging into Discord...');
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    serverInstance = app.listen(config.PORT, () => {
      console.log(`[INFO] API server listening on http://localhost:${config.PORT}.`);
      console.log('[INFO] Application started successfully.');
    });
  } catch (error) {
    console.error('[FATAL] Startup failed:', error.message, error.stack);
    if (discordClient && discordClient.token) {
        discordClient.destroy().catch(e => console.error("Error destroying discord client on startup fail", e));
    }
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`[INFO] Received ${signal}. Initiating graceful shutdown...`);
  let exitCode = 0;

  if (serverInstance) {
    console.log('[INFO] Closing HTTP server...');
    await new Promise(resolve => serverInstance.close(err => {
      if (err) {
        console.error('[ERROR] Error closing HTTP server:', err.message);
        exitCode = 1;
      } else {
        console.log('[INFO] HTTP server closed.');
      }
      resolve();
    }));
  }

  if (discordClient && discordClient.isReady()) {
    console.log('[INFO] Destroying Discord client...');
    try {
        await discordClient.destroy();
        console.log('[INFO] Discord client destroyed.');
    } catch(err) {
        console.error('[ERROR] Error destroying Discord client:', err.message);
        exitCode = 1;
    }
  }

  console.log('[INFO] Graceful shutdown complete. Exiting.');
  process.exit(exitCode);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();
