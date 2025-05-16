require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
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

const userQueues = {}; // In-memory script queue
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// Serve Executor UI
app.get('/executor', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lua Script Executor</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root {
      --primary: #4CAF50;
      --primary-dark: #388E3C;
      --secondary: #2196F3;
      --danger: #F44336;
      --dark: #121212;
      --darker: #0D0D0D;
      --light: #F1F1F1;
      --gray: #2D2D2D;
      --light-gray: #424242;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: var(--dark);
      color: var(--light);
      line-height: 1.6;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--light-gray);
    }
    
    h1 {
      color: var(--primary);
      font-size: 2rem;
    }
    
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .logo i {
      color: var(--secondary);
      font-size: 1.8rem;
    }
    
    .card {
      background: var(--darker);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    }
    
    .form-group {
      margin-bottom: 1.5rem;
    }
    
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: var(--primary);
    }
    
    input, textarea, select {
      width: 100%;
      padding: 12px;
      background: var(--gray);
      border: 1px solid var(--light-gray);
      border-radius: 4px;
      color: var(--light);
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 14px;
      transition: border 0.3s;
    }
    
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--primary);
    }
    
    textarea {
      min-height: 300px;
      resize: vertical;
    }
    
    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 1rem;
    }
    
    button {
      padding: 12px 20px;
      border: none;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    button:hover {
      transform: translateY(-2px);
    }
    
    button:active {
      transform: translateY(0);
    }
    
    .btn-primary {
      background: var(--primary);
      color: white;
    }
    
    .btn-primary:hover {
      background: var(--primary-dark);
    }
    
    .btn-secondary {
      background: var(--secondary);
      color: white;
    }
    
    .btn-secondary:hover {
      background: #1976D2;
    }
    
    .btn-danger {
      background: var(--danger);
      color: white;
    }
    
    .btn-danger:hover {
      background: #D32F2F;
    }
    
    #response {
      margin-top: 1.5rem;
      padding: 15px;
      border-radius: 4px;
      background: var(--gray);
      font-family: 'Consolas', 'Courier New', monospace;
      white-space: pre-wrap;
      min-height: 100px;
      max-height: 400px;
      overflow-y: auto;
    }
    
    .status {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: bold;
      margin-left: 10px;
    }
    
    .status-success {
      background: var(--primary);
      color: white;
    }
    
    .status-error {
      background: var(--danger);
      color: white;
    }
    
    .history-item {
      padding: 10px;
      border-bottom: 1px solid var(--light-gray);
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .history-item:hover {
      background: var(--gray);
    }
    
    .history-item:last-child {
      border-bottom: none;
    }
    
    .history-item small {
      color: #aaa;
      font-size: 0.8rem;
    }
    
    .tabs {
      display: flex;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--light-gray);
    }
    
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border-bottom: 3px solid transparent;
    }
    
    .tab.active {
      border-bottom: 3px solid var(--primary);
      font-weight: bold;
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
    }
    
    .syntax-info {
      background: rgba(33, 150, 243, 0.1);
      border-left: 4px solid var(--secondary);
      padding: 10px;
      margin: 10px 0;
      font-size: 0.9rem;
    }
    
    @media (max-width: 768px) {
      body {
        padding: 10px;
      }
      
      .button-group {
        flex-direction: column;
      }
      
      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <i class="fas fa-code"></i>
      <h1>Lua Script Executor</h1>
    </div>
    <div id="connection-status">
      <span class="status status-success">Connected</span>
    </div>
  </header>

  <div class="tabs">
    <div class="tab active" data-tab="executor">Executor</div>
    <div class="tab" data-tab="history">History</div>
    <div class="tab" data-tab="docs">Documentation</div>
  </div>

  <div class="tab-content active" id="executor-tab">
    <div class="card">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" placeholder="Enter your username" value="HeatRelax">
      </div>
      
      <div class="form-group">
        <label for="script">Lua Script</label>
        <textarea id="script" placeholder="Write your Lua script here..."></textarea>
      </div>
      
      <div class="syntax-info">
        <i class="fas fa-info-circle"></i> Tip: Use print() to output results to the console.
      </div>
      
      <div class="button-group">
        <button class="btn-primary" onclick="sendScript()">
          <i class="fas fa-play"></i> Execute
        </button>
        <button class="btn-secondary" onclick="saveScript()">
          <i class="fas fa-save"></i> Save
        </button>
        <button class="btn-danger" onclick="clearScript()">
          <i class="fas fa-trash"></i> Clear
        </button>
      </div>
    </div>
    
    <div class="card">
      <label>Execution Results</label>
      <div id="response">Results will appear here...</div>
    </div>
  </div>

  <div class="tab-content" id="history-tab">
    <div class="card">
      <h3>Saved Scripts</h3>
      <div id="saved-scripts-list">
        <!-- Scripts will be loaded here -->
        <div class="history-item" onclick="loadSavedScript('Sample Script', 'print(\"Hello World\")')">
          <strong>Sample Script</strong><br>
          <small>print("Hello World")</small>
        </div>
      </div>
    </div>
  </div>

  <div class="tab-content" id="docs-tab">
    <div class="card">
      <h3>Lua Documentation</h3>
      <div class="syntax-info">
        <h4><i class="fas fa-book"></i> Basic Syntax</h4>
        <p>Lua is a lightweight, high-level scripting language. Here are some basic examples:</p>
        <pre>
-- Variables
local x = 10
local name = "John"

-- Conditional
if x > 5 then
  print("x is greater than 5")
else
  print("x is 5 or less")
end

-- Loops
for i = 1, 5 do
  print("Iteration", i)
end

-- Functions
function greet(name)
  return "Hello, " .. name
end

print(greet("Alice"))</pre>
      </div>
      
      <div class="syntax-info">
        <h4><i class="fas fa-exclamation-triangle"></i> Security Restrictions</h4>
        <p>The following Lua features are restricted for security reasons:</p>
        <ul>
          <li>File I/O operations</li>
          <li>OS commands execution</li>
          <li>Debug library functions</li>
          <li>Coroutines</li>
        </ul>
      </div>
    </div>
  </div>

  <script>
    // Tab switching functionality
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        // Remove active class from all tabs and contents
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding content
        tab.classList.add('active');
        const tabId = tab.getAttribute('data-tab');
        document.getElementById(`${tabId}-tab`).classList.add('active');
        
        // Load saved scripts when history tab is opened
        if (tabId === 'history') {
          loadSavedScripts();
        }
      });
    });
    
    // Load saved scripts from localStorage
    function loadSavedScripts() {
      const savedScripts = JSON.parse(localStorage.getItem('luaSavedScripts') || [];
      const scriptsList = document.getElementById('saved-scripts-list');
      
      scriptsList.innerHTML = '';
      
      if (savedScripts.length === 0) {
        scriptsList.innerHTML = '<p>No saved scripts found.</p>';
        return;
      }
      
      savedScripts.forEach(script => {
        const scriptElement = document.createElement('div');
        scriptElement.className = 'history-item';
        scriptElement.innerHTML = `
          <strong>${script.name}</strong><br>
          <small>${script.content.substring(0, 50)}${script.content.length > 50 ? '...' : ''}</small>
        `;
        scriptElement.onclick = () => loadSavedScript(script.name, script.content);
        scriptsList.appendChild(scriptElement);
      });
    }
    
    // Load a specific saved script into the editor
    function loadSavedScript(name, content) {
      document.getElementById('script').value = content;
      document.querySelector('.tab[data-tab="executor"]').click();
      document.getElementById('response').innerText = `Loaded script: ${name}`;
    }
    
    // Save script to localStorage
    function saveScript() {
      const script = document.getElementById('script').value.trim();
      if (!script) return alert("Please enter a script to save");
      
      const scriptName = prompt("Enter a name for this script:", "Untitled Script");
      if (!scriptName) return;
      
      const savedScripts = JSON.parse(localStorage.getItem('luaSavedScripts') || [];
      savedScripts.push({ name: scriptName, content: script });
      localStorage.setItem('luaSavedScripts', JSON.stringify(savedScripts));
      
      document.getElementById('response').innerText = `Script saved as: ${scriptName}`;
    }
    
    // Send script to server for execution
    async function sendScript() {
      const username = document.getElementById('username').value.trim();
      const script = document.getElementById('script').value.trim();
      
      if (!username) return alert("Please enter a username");
      if (!script) return alert("Please enter a script to execute");
      
      const responseElement = document.getElementById('response');
      responseElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executing script...';
      
      try {
        const response = await fetch('/queue/' + encodeURIComponent(username), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          responseElement.innerHTML = `<span class="status status-success">Success</span><br><br>${formatOutput(data.message || 'Script executed successfully')}`;
        } else {
          responseElement.innerHTML = `<span class="status status-error">Error</span><br><br>${formatOutput(data.error || 'An unknown error occurred')}`;
        }
      } catch (error) {
        responseElement.innerHTML = `<span class="status status-error">Connection Error</span><br><br>${formatOutput('Failed to connect to the server. Please try again later.')}`;
        console.error('Error:', error);
      }
    }
    
    // Format output with syntax highlighting for errors
    function formatOutput(text) {
      // Simple formatting - in a real app you might use a proper syntax highlighter
      return text
        .replace(/Error:/g, '<span style="color: #F44336">Error:</span>')
        .replace(/Warning:/g, '<span style="color: #FFC107">Warning:</span>')
        .replace(/Line \d+/g, '<span style="color: #2196F3">$&</span>');
    }
    
    // Clear the script editor
    function clearScript() {
      if (confirm("Are you sure you want to clear the script?")) {
        document.getElementById('script').value = '';
        document.getElementById('response').innerText = 'Editor cleared.';
      }
    }
    
    // Check connection status periodically
    function checkConnection() {
      fetch('/status')
        .then(response => {
          const statusElement = document.querySelector('#connection-status .status');
          if (response.ok) {
            statusElement.className = 'status status-success';
            statusElement.textContent = 'Connected';
          } else {
            statusElement.className = 'status status-error';
            statusElement.textContent = 'Disconnected';
          }
        })
        .catch(() => {
          const statusElement = document.querySelector('#connection-status .status');
          statusElement.className = 'status status-error';
          statusElement.textContent = 'Disconnected';
        });
    }
    
    // Initial load
    document.addEventListener('DOMContentLoaded', () => {
      // Check connection every 30 seconds
      checkConnection();
      setInterval(checkConnection, 30000);
      
      // Load any saved scripts
      loadSavedScripts();
    });
  </script>
</body>
</html>
  `);
});

// Queue API
app.post('/queue/:username', (req, res) => {
  const username = req.params.username;
  const script = req.body?.script;
  if (!script) return res.status(400).json({ status: 'error', message: 'No script provided' });

  if (!userQueues[username]) userQueues[username] = [];
  userQueues[username].push({ script });
  res.status(200).json({ status: 'success', message: 'Script added to queue' });
});

app.get('/queue/:username', (req, res) => {
  const username = req.params.username;
  const queue = userQueues[username];
  if (!queue || queue.length === 0) return res.json({ script: null });

  const nextScript = queue.shift();
  if (queue.length === 0) delete userQueues[username];
  res.json(nextScript);
});

// Your original APIs and bot logic below (unchanged)...
// ---------------------------------------
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

// Discord Bot
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

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});

discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
