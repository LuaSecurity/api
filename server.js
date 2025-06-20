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
  LOG_CHANNEL_ID: '1373755001234657320', // Ensure this is a string
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'LuaSecurity',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064', // Ensure these are strings
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  PORT: process.env.PORT || 3000,
  SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT: 100, // Make sure this is suitable (e.g., 1900 to fit Discord embed description limits with other text)
  STAFF_LOG_WEBHOOK_URL_1: process.env.RUBYHUBWEBHOOK,
  STAFF_LOG_WEBHOOK_URL_2: process.env.MYWEBHOOK,
  LUA_MENU_CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  WHITELIST_CACHE_TTL_MS: 2 * 60 * 1000 // NEW: Cache whitelist for 2 minutes
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

// NEW: Whitelist Cache
let whitelistCache = {
    data: null,
    lastFetched: 0,
    etag: null // For GitHub conditional requests
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
            .setDescription(description.substring(0, 4090)) // Discord description limit
            .setTimestamp();

        if (interaction && interaction.user) {
            logEmbed.addFields({ name: 'Action Initiated By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true });
            if (interaction.guild && interaction.channel) {
                 logEmbed.addFields({ name: 'Context', value: `Guild: ${interaction.guild.name}\nChannel: ${interaction.channel.name}`, inline: true });
            }
        }
        for (const field of additionalFields) {
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23) { // Embed field limit is 25
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

// MODIFIED: getWhitelistFromGitHub with caching
async function getWhitelistFromGitHub(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && whitelistCache.data && (now - whitelistCache.lastFetched < config.WHITELIST_CACHE_TTL_MS)) {
        console.log("[INFO] Serving whitelist from cache.");
        return whitelistCache.data;
    }

    console.log(`[INFO] Attempting to fetch whitelist from GitHub: ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`);
    let rawDataContent;
    try {
        const requestHeaders = {
            'Accept': 'application/vnd.github.v3.raw',
            'Cache-Control': 'no-cache, no-store, must-revalidate' // Ask GitHub for fresh data
        };
        if (!forceRefresh && whitelistCache.etag && whitelistCache.data) { // Only use ETag if we have cached data to serve on 304
            requestHeaders['If-None-Match'] = whitelistCache.etag;
        }

        const response = await octokit.rest.repos.getContent({
            owner: config.GITHUB_REPO_OWNER,
            repo: config.GITHUB_REPO_NAME,
            path: config.WHITELIST_PATH,
            ref: config.GITHUB_BRANCH,
            headers: requestHeaders
        });

        // If GitHub returns 304 Not Modified, it means our cached version (ETag) is still current.
        // Octokit sometimes throws an error for 304, sometimes returns it in status.
        // This check is for when it returns a response object with status 304.
        if (response.status === StatusCodes.NOT_MODIFIED) {
            console.log("[INFO] Whitelist not modified on GitHub (304). Using cached version.");
            whitelistCache.lastFetched = now; // Update lastFetched time for the cache
            return whitelistCache.data; // Return existing cached data
        }

        if (response.status !== StatusCodes.OK) {
            console.warn(`[WARN] GitHub API returned status ${response.status} for getWhitelistFromGitHub.`);
            throw new Error(`GitHub API request failed with status ${response.status}`);
        }

        rawDataContent = response.data; // This is the raw string content

        // Store the ETag from the response for future conditional requests
        if (response.headers && response.headers.etag) {
            whitelistCache.etag = response.headers.etag;
        }

        if (typeof rawDataContent !== 'string') {
            console.warn(`[WARN] getWhitelistFromGitHub: Expected raw string content, got type ${typeof rawDataContent}.`);
            throw new Error('Unexpected GitHub response format for whitelist (not a string).');
        }

        if (rawDataContent.trim() === "") {
            console.warn("[WARN] getWhitelistFromGitHub: Whitelist file is empty. Caching empty array.");
            whitelistCache.data = [];
            whitelistCache.lastFetched = now;
            return [];
        }

        const parsedWhitelist = JSON.parse(rawDataContent);

        if (!Array.isArray(parsedWhitelist)) {
            console.warn(`[WARN] getWhitelistFromGitHub: Parsed whitelist is not an array.`);
            throw new Error('Parsed whitelist data from GitHub is not an array.');
        }

        console.log(`[INFO] Whitelist successfully fetched/updated. ${parsedWhitelist.length} entries. Caching.`);
        whitelistCache.data = parsedWhitelist;
        whitelistCache.lastFetched = now;
        return parsedWhitelist;

    } catch (error) {
        // Octokit can throw an error for 304 Not Modified if not handled gracefully by its internals or if request settings expect full data.
        if (error.status === StatusCodes.NOT_MODIFIED && whitelistCache.data) {
            console.log("[INFO] Whitelist not modified on GitHub (304 via error). Using cached version.");
            whitelistCache.lastFetched = now; // Update timestamp of cache use
            return whitelistCache.data;
        }

        const errorMessage = `Failed to get/parse whitelist from ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME}/${config.WHITELIST_PATH}`;
        console.error(`[ERROR] ${errorMessage}: ${error.message}`, error.response ? JSON.stringify(error.response.data) : '');
        const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,200) : (rawDataContent ? String(rawDataContent).substring(0, 200) : "N/A");
        await sendActionLogToDiscord(
            'GitHub Whitelist Fetch/Parse Error',
            `${errorMessage}\n**Error:** ${error.message}\n**Raw Data Preview (type ${typeof rawDataContent}):** \`\`\`${rawDataPreview}\`\`\``,
            null, 0xFF0000
        );
        // If fetch fails but we have stale cache, we might choose to return stale data or throw. Here, we throw.
        // Consider if serving stale data (and logging it) is preferable to outright failure for /verify route.
        const newError = new Error(`${errorMessage}. Original: ${error.message}`);
        newError.cause = error;
        throw newError;
    }
}


// MODIFIED: updateWhitelistOnGitHub to invalidate cache
async function updateWhitelistOnGitHub(newWhitelist, actionMessage = 'Update whitelist via API') {
  console.log("[INFO] Attempting to update whitelist on GitHub...");
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH, ref: config.GITHUB_BRANCH,
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } // Ensure we get latest SHA
    });

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.GITHUB_REPO_OWNER, repo: config.GITHUB_REPO_NAME,
      path: config.WHITELIST_PATH,
      message: `${actionMessage} - ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64'),
      sha: fileData.sha,
      branch: config.GITHUB_BRANCH
    });
    console.log("[INFO] Whitelist updated successfully on GitHub. Invalidating server cache.");
    // Invalidate cache
    whitelistCache.data = null;
    whitelistCache.lastFetched = 0;
    whitelistCache.etag = null; // Crucial for next fetch to not use old ETag
    // Optionally: await getWhitelistFromGitHub(true); // To immediately refresh cache
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

// No change needed in sendToDiscordChannel's signature, it already expects a single embed object for `embedData`
async function sendToDiscordChannel(embedData, fullScriptContent = null) {
  try {
    const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) throw new Error(`Log channel not found or not text-based. ID: ${config.LOG_CHANNEL_ID}`);

    // embedData here is a single embed object due to changes in /send/scriptlogs
    const embed = new EmbedBuilder(embedData);
    const messageOptions = { embeds: [embed], components: [] };
    let scriptToLogForButton = fullScriptContent; // For button disabled state

    if (fullScriptContent && typeof fullScriptContent === 'string' && fullScriptContent.trim().length > 0) {
      if (fullScriptContent.length > config.SCRIPT_LENGTH_THRESHOLD_FOR_ATTACHMENT) {
        // Modify the description of the embed being sent
        if (embed.data.description) { // Check if embed has a description to modify
            embed.setDescription(embed.data.description.replace(/```lua\n([\s\S]*?)\n```/, SCRIPT_IN_ATTACHMENT_PLACEHOLDER));
        } else { // If no original description, just set it to the placeholder
            embed.setDescription(SCRIPT_IN_ATTACHMENT_PLACEHOLDER);
        }
        messageOptions.files = [new AttachmentBuilder(Buffer.from(fullScriptContent, 'utf-8'), { name: `script_log_${generateLogId()}.lua` })];
        scriptToLogForButton = SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT; // So button is disabled
      }
    }

    messageOptions.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('blacklist_user_from_log').setLabel('Blacklist User').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('get_asset_script_from_log')
        .setLabel('Download Found Assets') // This might be mislabeled if it's meant to download the executed script
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!scriptToLogForButton || scriptToLogForButton === SCRIPT_IN_ATTACHMENT_PLACEHOLDER_TEXT) // Disable if no script or it's an attachment placeholder
    ));

    return channel.send(messageOptions);
  } catch (error) {
      console.error('[ERROR] Discord sendToDiscordChannel (script log) error:', error.message, error.stack);
      // Avoid crashing the main request flow if Discord logging fails
  }
}

async function handleBlacklist(interaction) {
  await interaction.reply({ content: 'Blacklist functionality is not yet implemented.', ephemeral: true });
}
async function handleGetAssetOrScript(interaction) {
  // If this button is meant to give the *executed script* (especially if it was attached):
  // You would need to access the original message (interaction.message) and its attachments,
  // or store/retrieve the script content associated with the log message.
  // For now, it seems like a general placeholder.
  await interaction.reply({ content: 'Asset/Script download from log is not yet implemented.', ephemeral: true });
}

app.get('/', (req, res) => res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Access Denied.' }));

// NEW: Optional /ping endpoint for Render Cron Job / Uptime Monitor
app.get('/ping', (req, res) => {
    res.status(StatusCodes.OK).json({ status: 'success', message: 'Pong!' });
});

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Username required.' });

  try {
    const whitelist = await getWhitelistFromGitHub(); // Will use cache
    const foundUser = whitelist.find(user => user && typeof user.User === 'string' && user.User.toLowerCase() === username.toLowerCase());

    if (!foundUser) {
      console.log(`[INFO] /verify/${username}: User not found in whitelist.`);
      return res.status(StatusCodes.NOT_FOUND).json({ status: 'error', message: "User not found in whitelist." });
    }
    console.log(`[INFO] /verify/${username}: User found in whitelist (served from cache: ${Date.now() - whitelistCache.lastFetched < config.WHITELIST_CACHE_TTL_MS && whitelistCache.data ? 'yes' : 'no'}).`);
    res.json({ status: 'success', data: { username: foundUser.User, discordId: foundUser.Discord, tier: foundUser.Whitelist }});
  } catch (error) {
    console.error(`[ERROR] Verify route error for ${username}: ${error.message}`, error.stack);
    // Avoid sending action log if it's a known whitelist fetch/parse error already logged by getWhitelistFromGitHub
    if (!(error.message.includes("Failed to get/parse whitelist") || error.message.includes("GitHub API request failed"))) {
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

// MODIFIED: /send/scriptlogs
app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(StatusCodes.FORBIDDEN).json({ status: 'error', message: 'Roblox access only.' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(StatusCodes.UNAUTHORIZED).json({ status: 'error', message: 'Invalid API key.' });
  
  // Ensure req.body.embeds is an array and has at least one element.
  // The Lua script sends { embeds: [ { /* embed object */ } ] }
  if (!req.body || !Array.isArray(req.body.embeds) || req.body.embeds.length === 0 || !req.body.embeds[0]) {
    return res.status(StatusCodes.BAD_REQUEST).json({ status: 'error', message: 'Invalid or missing embed data. Expected `embeds` array with one embed object.' });
  }

  try {
    const firstEmbedData = req.body.embeds[0]; // Get the single embed object
    let fullScript = null;

    // Extract script content from the description of the *first* embed
    if (firstEmbedData && typeof firstEmbedData.description === 'string') {
        const scriptMatch = firstEmbedData.description.match(/```lua\n([\s\S]*?)\n```/);
        if (scriptMatch && scriptMatch[1]) {
            fullScript = scriptMatch[1];
        }
    }
    
    // Pass the single embed object (firstEmbedData) and the extracted script
    await sendToDiscordChannel(firstEmbedData, fullScript); 
    res.status(StatusCodes.OK).json({ status: 'success', message: 'Log received and processed.', logId: generateLogId() });
  } catch (error) {
      console.error('[ERROR] Error in /send/scriptlogs:', error.message, error.stack);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ status: 'error', message: "Processing script log failed on server." });
  }
});


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
        headers: { 'User-Agent': 'LuaWhitelistServer/2.0.1_Optimized' } // Minor version bump for UA
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
      // Attempt to serve cached content if available, even if stale, on error
      if (luaMenuCache.content) {
          console.warn('[WARN] Serving stale LuaMenu from cache due to fetch error.');
          return res.set({
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store', // Indicate it's stale
              'X-Content-Type-Options': 'nosniff'
          }).send(luaMenuCache.content);
      }
      res.status(status).json({ status: 'error', message: 'Failed to load LuaMenu script.' });
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  console.log(`[DEBUG] Button interaction received: ${interaction.customId} from ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}, channel ${interaction.channelId}`);

  try {
    if (interaction.customId === 'blacklist_user_from_log') {
      await handleBlacklist(interaction);
    } else if (interaction.customId === 'get_asset_script_from_log') {
      await handleGetAssetOrScript(interaction);
    } else {
      console.log(`[WARN] Unhandled button interaction: ${interaction.customId}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'This button is not configured for a specific response.', ephemeral: true });
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

// Remove empty messageCreate listener if not used
// discordClient.on('messageCreate', async message => {
// });

discordClient.on('ready', async () => {
  console.log(`[INFO] Bot logged in as ${discordClient.user.tag}.`);
  console.log(`[INFO] Monitoring ${discordClient.guilds.cache.size} guild(s).`);
  discordClient.user.setStatus('dnd'); // 'online', 'idle', 'dnd', 'invisible'
  discordClient.user.setActivity('Managing Whitelists & Logs', { type: ActivityType.Watching }); // Playing, Streaming, Listening, Watching, Competing
  console.log('[INFO] Discord Bot is ready. Core services initialized.');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason instanceof Error ? `${reason.message}\n${reason.stack}` : reason);
  // Potentially add more robust logging or alert for unhandled rejections
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message, `\nStack: ${error.stack}`);
  console.error('Application will attempt to log to Discord and then exit due to uncaught exception.');
  sendActionLogToDiscord(
    "FATAL Uncaught Exception",
    `Error: ${error.message}\nStack:\n\`\`\`${error.stack}\`\`\``,
    null,
    0xFF0000 // Bright Red
  ).catch(e => {
    console.error("[ERROR] Failed to send FATAL uncaught exception log to Discord:", e);
  }).finally(() => {
    // Graceful shutdown attempt here is tricky because state is unknown
    // process.exit(1) is probably safest after logging.
    if (discordClient && discordClient.token) {
        discordClient.destroy().catch(destroyErr => console.error("Error destroying discord client during uncaughtException: ", destroyErr));
    }
    process.exit(1);
  });
});

let serverInstance;

async function startServer() {
  try {
    console.log('[INFO] Logging into Discord...');
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    // After Discord login success, start HTTP server
    serverInstance = app.listen(config.PORT, () => {
      console.log(`[INFO] API server listening on http://localhost:${config.PORT}.`);
      console.log('[INFO] Application started successfully.');
    });
  } catch (error) {
    console.error('[FATAL] Startup failed:', error.message, error.stack);
    if (discordClient && discordClient.token) { // Check if client has a token (might not if login itself failed early)
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
        exitCode = 1; // Indicate error during shutdown
      } else {
        console.log('[INFO] HTTP server closed.');
      }
      resolve(); // Ensure this always resolves
    }));
  } else {
    console.log("[INFO] HTTP server not started or already closed.");
  }

  if (discordClient && discordClient.isReady()) { // Check if client is actually logged in and ready
    console.log('[INFO] Destroying Discord client...');
    try {
        await discordClient.destroy();
        console.log('[INFO] Discord client destroyed.');
    } catch(err) {
        console.error('[ERROR] Error destroying Discord client:', err.message);
        exitCode = 1;
    }
  } else {
    console.log("[INFO] Discord client not ready or already destroyed.");
  }

  console.log(`[INFO] Graceful shutdown attempt finished. Exiting with code ${exitCode}.`);
  process.exit(exitCode);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();
