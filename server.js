require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder
} = require('discord.js');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  GITHUB_LUA_MENU_URL: process.env.GITHUB_LUA_MENU_URL,
  LOG_CHANNEL_ID: '1331021897735081984',
  GITHUB_REPO: 'RelaxxxX-Lab/Lua-things',
  GITHUB_BRANCH: 'main',
  WHITELIST_PATH: 'Whitelist.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  }
};

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN, request: { timeout: 5000 } });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

app.use(bodyParser.json({ limit: '10mb' }));

const generateLogId = () => crypto.randomBytes(8).toString('hex');
const isFromRoblox = req => (req.headers['user-agent'] || '').includes('Roblox');

const getWhitelistFromGitHub = async () => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.WHITELIST_PATH,
    ref: config.GITHUB_BRANCH,
    headers: { Accept: 'application/vnd.github.v3.raw' }
  });

  if (typeof data === 'string') return JSON.parse(data);
  if (data.content) return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));

  throw new Error('Unexpected GitHub response format');
};

const updateWhitelistOnGitHub = async newWhitelist => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.WHITELIST_PATH,
    ref: config.GITHUB_BRANCH
  });

  const content = Buffer.from(JSON.stringify(newWhitelist, null, 2)).toString('base64');

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.WHITELIST_PATH,
    message: 'Update whitelist (blacklist action)',
    content,
    sha: data.sha,
    branch: config.GITHUB_BRANCH
  });

  return response.status === 200;
};

const sendToDiscordChannel = async (embedData, scriptContent = null) => {
  const channel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
  if (!channel) throw new Error('Channel not found');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('download_script').setLabel('Download Script').setStyle(ButtonStyle.Primary)
  );

  const messageOptions = { embeds: [embedData], components: [row] };

  if (scriptContent?.trim()) {
    const buffer = Buffer.from(scriptContent, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: 'script.lua' });
    messageOptions.files = [attachment];

    if (scriptContent.length > 100) {
      embedData.description = embedData.description.replace(
        /```lua\n[\s\S]*?\n```/,
        '```lua\n[Script content available in attached file]\n```'
      );
    }
  }

  return channel.send(messageOptions);
};

const handleBlacklist = async interaction => {
  await interaction.deferReply({ ephemeral: true });
  const embed = interaction.message.embeds[0];
  if (!embed?.description) return interaction.editReply({ content: 'No user information found' });

  const discordIdMatch = embed.description.match(/Discord: <@(\d+)>/);
  const targetUserId = discordIdMatch?.[1];
  if (!targetUserId) return interaction.editReply({ content: 'User ID not found' });

  const robloxUsername = embed.description.match(/Username: (.+?)\n/)?.[1] || 'Unknown';
  const whitelist = await getWhitelistFromGitHub();
  const targetEntry = whitelist.find(entry => entry.Discord === targetUserId);
  if (!targetEntry) return interaction.editReply({ content: 'User not in whitelist' });

  const newWhitelist = whitelist.filter(entry => entry.Discord !== targetUserId);
  await updateWhitelistOnGitHub(newWhitelist);

  try {
    const member = await interaction.guild.members.fetch(targetUserId);
    const rolesToRemove = Object.values(config.ROLES)
      .map(id => interaction.guild.roles.cache.get(id))
      .filter(Boolean);
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove);
  } catch {}

  try {
    const user = await discordClient.users.fetch(targetUserId);
    const blacklistEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle('🚨 You have been blacklisted')
      .setDescription('You are no longer allowed to access the services.')
      .addFields(
        { name: 'Roblox Username', value: targetEntry.User, inline: true },
        { name: 'Whitelist Rank', value: targetEntry.Whitelist, inline: true },
        { name: 'Staff Member', value: interaction.user.tag, inline: false }
      );
    await user.send({ embeds: [blacklistEmbed] });
  } catch {}

  await interaction.editReply({ content: `Blacklisted ${robloxUsername} (${targetUserId}) successfully.` });

  const logEmbed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('User Blacklisted')
    .addFields(
      { name: 'User', value: `<@${targetUserId}>`, inline: true },
      { name: 'Roblox Username', value: targetEntry.User, inline: true },
      { name: 'Rank', value: targetEntry.Whitelist, inline: true },
      { name: 'By', value: interaction.user.toString(), inline: false }
    )
    .setTimestamp();
  const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID);
  await logChannel.send({ embeds: [logEmbed] });
};

const handleScriptDownload = async interaction => {
  await interaction.deferReply({ ephemeral: true });
  const attachment = interaction.message.attachments.first();
  if (!attachment) return interaction.editReply({ content: 'Script not found' });

  try {
    const buffer = await axios.get(attachment.url, { responseType: 'arraybuffer' });
    const file = new AttachmentBuilder(Buffer.from(buffer.data), { name: attachment.name || 'script.lua' });
    await interaction.editReply({ content: 'Here is your script:', files: [file] });
  } catch {
    await interaction.editReply({ content: 'Could not send script. Check your DMs or contact support.' });
  }
};

app.get('/', (req, res) => res.status(403).json({ status: 'error', message: 'Access denied' }));

app.get('/verify/:username', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  try {
    const whitelist = await getWhitelistFromGitHub();
    const user = whitelist.find(u => u.User.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', data: { username: user.User, discordId: user.Discord, tier: user.Whitelist } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message || 'Internal server error' });
  }
});

app.get('/download/:assetId', (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) return res.status(400).json({ status: 'error', message: 'Invalid asset ID' });
  res.set({
    'Content-Type': 'text/plain',
    'Content-Disposition': `attachment; filename="${assetId}.rbxm"`
  }).send(`-- Roblox model reference: ${assetId}`);
});

app.post('/send/scriptlogs', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  if (req.headers['authorization'] !== config.API_KEY) return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  if (!req.body?.embeds?.length) return res.status(400).json({ status: 'error', message: 'Invalid embed data' });

  try {
    const embed = req.body.embeds[0];
    const scriptContent = embed.description?.match(/```lua\n([\s\S]*?)\n```/)?.[1] || '';
    await sendToDiscordChannel(embed, scriptContent);
    res.status(200).json({ status: 'success', message: 'Log sent to Discord', logId: generateLogId() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message || 'Processing failed' });
  }
});

app.get('/scripts/LuaMenu', async (req, res) => {
  if (!isFromRoblox(req)) return res.status(403).json({ status: 'error', message: 'Roblox access only' });
  try {
    const response = await axios.get(config.GITHUB_LUA_MENU_URL, {
      timeout: 5000,
      headers: { 'User-Agent': 'LuaWhitelistServer/1.0' }
    });
    res.set({
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff'
    }).send(response.data);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message || 'Failed to load script' });
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === 'blacklist') await handleBlacklist(interaction);
    if (interaction.customId === 'download_script') await handleScriptDownload(interaction);
  } catch (e) {
    const replyMethod = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
    await interaction[replyMethod]({ content: 'An error occurred while processing your request', ephemeral: true });
  }
});

discordClient.on('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}`);
  discordClient.user.setStatus('dnd');
  discordClient.user.setActivity('Whitelist Manager', { type: 'WATCHING' });
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

const port = process.env.PORT;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});

discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
