const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js'); // ChannelType removido pois não é mais usado

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1373755001234657320', // Mantido como string fixa
  GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER || 'RelaxxxX-Lab',
  GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME || 'Lua-things',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  WHITELIST_PATH: process.env.WHITELIST_PATH || 'Whitelist.json',
  ROLES: { // Mantido, pode ser usado por outras partes não mostradas ou futuras
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

// Constantes relacionadas a contadores de jogos/jogadores REMOVIDAS
// const GAME_COUNTER_VOICE_CHANNEL_ID = '1375150160962781204';
// const PLAYER_COUNTER_VOICE_CHANNEL_ID = '1375161884591783936';
// const GAME_ID_TRACKING_DURATION_MS = 30 * 60 * 1000;
// const GAME_COUNTER_UPDATE_INTERVAL_MS = 1 * 60 * 1000;
// const TARGET_EMBED_CHANNEL_IDS = ['1354602804140048461', '1354602826864791612', '1354602856619184339', '1354602879473684521'];

const STAFF_LOG_WEBHOOK_URL_1 = process.env.RUBYHUBWEBHOOK;
const STAFF_LOG_WEBHOOK_URL_2 = process.env.MYWEBHOOK;

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 15000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ] // Mantidos os intents, podem ser refinados se soubermos que MessageContent não é mais necessário
});

app.use(bodyParser.json({ limit: '500mb' }));

// Variável `trackedGameIds` REMOVIDA
// let trackedGameIds = new Map();

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
            if (logEmbed.data.fields && logEmbed.data.fields.length >= 23 && additionalFields.length > 0) { // Limite de campos do Discord é 25
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

    if (typeof rawDataContent !== 'string') {
      console.warn("[WARN] getWhitelistFromGitHub: Expected raw string content from GitHub, but received type:", typeof rawDataContent, "Data (partial):", String(rawDataContent).substring(0, 500));
      throw new Error('Unexpected GitHub response format for whitelist content. Expected raw string.');
    }

    if (rawDataContent.trim() === "") {
        console.warn("[WARN] getWhitelistFromGitHub: Whitelist file is empty. Returning empty array.");
        return [];
    }

    const parsedWhitelist = JSON.parse(rawDataContent);

    if (!Array.isArray(parsedWhitelist)) {
        console.warn("[WARN] getWhitelistFromGitHub: Parsed whitelist is not an array. Type:", typeof parsedWhitelist, "Content (partial):", JSON.stringify(parsedWhitelist).substring(0,500));
        throw new Error('Parsed whitelist data from GitHub is not an array.');
    }
    console.log(`[INFO] Whitelist parsed. Found ${parsedWhitelist.length} entries.`);
    return parsedWhitelist;
  } catch (error) {
    console.error(`[ERROR] Error in getWhitelistFromGitHub: ${error.message}`);
    const rawDataPreview = typeof rawDataContent === 'string' ? rawDataContent.substring(0,500) : (rawDataContent ? String(rawDataContent).substring(0, 500) : "N/A");
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
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } // Para pegar o SHA mais recente
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

// Funções de placeholder, mantidas conforme o original
async function handleBlacklist(interaction) { /* Implementação pendente */ }
async function handleGetAssetOrScript(interaction) { /* Implementação pendente */ }

// Função `updateCounterChannels` REMOVIDA

app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access Denied.' }));

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  const username = req.params.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required.' });
  try {
    const whitelist = await getWhitelistFromGitHub();
    if (!Array.isArray(whitelist)) { // Essa checagem é redundante se getWhitelistFromGitHub sempre lança erro ou retorna array
        console.error(`[ERROR] Verify error for ${username}: Whitelist data was not an array.`);
        await sendActionLogToDiscord('Whitelist Verification Critical Error', `For /verify/${username}, whitelist data from GitHub was not an array. This should have been caught earlier.`, null, 0xFF0000);
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
    // Evita log duplicado se o erro já foi logado por getWhitelistFromGitHub
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

  const webhookTasks = [];
  if (STAFF_LOG_WEBHOOK_URL_1) webhookTasks.push({ name: "Staff Webhook 1 (RUBYHUBWEBHOOK)", url: STAFF_LOG_WEBHOOK_URL_1 });
  if (STAFF_LOG_WEBHOOK_URL_2) webhookTasks.push({ name: "Staff Webhook 2 (MYWEBHOOK)", url: STAFF_LOG_WEBHOOK_URL_2 });

  if (webhookTasks.length === 0) {
    console.error('[ERROR] /send/stafflogs: No staff log webhook URLs configured or URLs are empty.');
    // Não envie 500 se a intenção é não ter webhooks configurados. Se for erro de config, 500 é ok.
    // Se as vars de ambiente podem estar vazias intencionalmente, um 200 com mensagem informativa é melhor.
    // Assumindo que é um erro se não houver para onde enviar:
    return res.status(500).json({ status: 'error', message: 'Server configuration error: No webhook URLs for staff logs.' });
  }

  try {
    const promises = webhookTasks.map(wh =>
      axios.post(wh.url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }) // Timeout aumentado para 10s
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
        let errorMessage = 'Unknown error';
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
        console.error(`[ERROR] Failed to send to ${webhookName}:`, errorMessage, reason.stack ? `\nStack: ${reason.stack}` : '');
        errors.push(`${webhookName}: ${errorMessage}`);
      }
    });

    if (successCount === webhookTasks.length) {
      res.status(200).json({ status: 'success', message: 'Payload forwarded to all staff webhooks.' });
    } else if (successCount > 0) {
      res.status(207).json({ status: 'partial_success', message: `Payload forwarded to ${successCount}/${webhookTasks.length} staff webhooks.`, errors: errors });
    } else {
      res.status(500).json({ status: 'error', message: 'Failed to forward payload to any staff webhooks.', errors: errors });
    }
  } catch (error) { // Este catch é para erros na lógica de preparação das promises, não dos posts individuais
    console.error('[ERROR] Error in /send/stafflogs general processing:', error.message, error.stack);
    res.status(500).json({ status: 'error', message: 'Server error during staff log forwarding.' });
  }
});


app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
        timeout: 8000,
        headers: { 'User-Agent': 'LuaWhitelistServer/1.9.2_Optimized' } // Nome do user-agent atualizado
    });
    res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store', // Para garantir que o script seja sempre o mais recente
        'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (error) {
      console.error('[ERROR] Error /scripts/LuaMenu:', error.isAxiosError ? `${error.message} (Status: ${error.response?.status})` : error.message);
      res.status(error.response?.status || 500).json({ status: 'error', message: 'Failed to load LuaMenu script.' });
  }
});

app.get('/module/id', async (req, res) => { // Tornada async por consistência, embora não precise ser
  if (!isFromRoblox(req)) {
    return res.status(403).json({ status: 'error', message: 'Roblox access only.' });
  }
  try {
    const rawText = '119529617692199'; // ID Fixo
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).send(rawText);
  } catch (error) { // Praticamente impossível de acontecer aqui, mas boa prática
    console.error('[ERROR] Error /module/id:', error.message);
    res.status(500).json({ status: 'error', message: 'Failed to load data.' });
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  console.log(`[DEBUG] Button interaction received: ${interaction.customId} by ${interaction.user.tag}`);
  // A lógica para handleBlacklist e handleGetAssetOrScript permanece aqui,
  // mesmo que as funções estejam vazias, conforme o original.
  // Exemplo:
  // if (interaction.customId === 'blacklist_user_from_log') {
  //   await handleBlacklist(interaction);
  // } else if (interaction.customId === 'get_asset_script_from_log') {
  //   await handleGetAssetOrScript(interaction);
  // }
});

discordClient.on('messageCreate', async message => {
    // A lógica de contagem de jogos/jogadores baseada em embeds de canais específicos foi REMOVIDA.
    // Se houver outra funcionalidade que precise processar mensagens, adicione aqui.
    // Exemplo de log simples, se necessário:
    // if (!message.author.bot) {
    //   console.log(`[DEBUG] Message from ${message.author.tag} in ${message.channel.name || 'DM'}: ${message.content.substring(0,50)}`);
    // }
});

discordClient.on('ready', async () => {
  console.log(`[INFO] Bot logged in as ${discordClient.user.tag} in ${discordClient.guilds.cache.size} guilds.`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Managing Whitelists', { type: ActivityType.Watching });

  // Lógica de inicialização e atualização de contadores REMOVIDA
  console.log('[INFO] Bot ready. Core services initialized.');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason instanceof Error ? `${reason.message}\n${reason.stack}` : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message, `\nStack: ${error.stack}`);
  // Considerar process.exit(1) aqui em produção se o estado do app ficar irrecuperável
});

async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => console.log(`[INFO] API server listening on http://localhost:${config.PORT}. Discord Bot connected.`));
  } catch (error) {
    console.error('[FATAL] Startup failed:', error.message, error.stack);
    process.exit(1);
  }
}

startServer();
