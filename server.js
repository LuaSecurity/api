require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
  SCRIPT_PATH: 'Scripts.json',
  ROLES: {
    STANDARD: '1330552089759191064',
    PREMIUM: '1333286640248029264',
    ULTIMATE: '1337177751202828300'
  },
  BOT_CLIENT_ID: process.env.BOT_CLIENT_ID,
  BOT_CLIENT_SECRET: process.env.BOT_CLIENT_SECRET,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SERVER_ID: process.env.SERVER_ID
};

const app = express();
const octokit = new Octokit({ auth: config.GITHUB_TOKEN });
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const userQueues = {};
app.use(cors());
app.use(cookieParser());
app.use(bodyParser.json({ limit: '100mb' }));

const getWhitelistFromGitHub = async () => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.WHITELIST_PATH,
    ref: config.GITHUB_BRANCH,
    headers: { Accept: 'application/vnd.github.v3.raw' }
  });
  if (typeof data === 'string') return JSON.parse(data);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
};

const getScriptsFromGitHub = async () => {
  const { data } = await octokit.rest.repos.getContent({
    owner: config.GITHUB_REPO.split('/')[0],
    repo: config.GITHUB_REPO.split('/')[1],
    path: config.SCRIPT_PATH,
    ref: config.GITHUB_BRANCH,
    headers: { Accept: 'application/vnd.github.v3.raw' }
  });
  if (typeof data === 'string') return JSON.parse(data);
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
};

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.BOT_CLIENT_ID,
        client_secret: config.BOT_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.REDIRECT_URI,
        scope: 'identify'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    res.cookie('discord_id', userRes.data.id, { httpOnly: true, maxAge: 86400000 });
    res.redirect('/executor');
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth2 authentication failed');
  }
});

app.get('/executor', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${config.BOT_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.REDIRECT_URI)}&response_type=code&scope=identify`);

  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).send('You are not whitelisted');

  const username = entry.User;
  const scripts = await getScriptsFromGitHub();
  const scriptOptions = scripts.map(s => `<option value="${s.Script.replace(/Username/g, username)}">${s.Name}</option>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lua Script Hub</title>
      <style>
        body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #0f0f10; color: #fff; }
        header { padding: 20px; background: #1e1e1f; text-align: center; font-size: 24px; font-weight: bold; }
        main { padding: 30px; max-width: 800px; margin: auto; }
        select, textarea, button { width: 100%; font-size: 16px; margin-top: 15px; border-radius: 6px; border: none; padding: 12px; }
        select, textarea { background: #1a1a1c; color: #fff; }
        button { background: #3b82f6; color: white; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #2563eb; }
        #response { margin-top: 20px; font-size: 14px; color: lime; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <header>Welcome, ${username}</header>
      <main>
        <label for="hub">Select a script:</label>
        <select id="hub" onchange="document.getElementById('script').value = this.value">
          <option value="">-- Choose --</option>
          ${scriptOptions}
        </select>
        <textarea id="script" placeholder="Lua script will appear here..."></textarea>
        <button onclick="executeScript()">Execute</button>
        <div id="response"></div>
      </main>
      <script>
        function executeScript() {
          const script = document.getElementById('script').value;
          if (!script) return alert("Please select or write a script.");
          fetch('/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script })
          })
          .then(r => r.json())
          .then(d => document.getElementById('response').innerText = d.message);
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/queue', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.status(401).json({ message: 'Not authenticated' });
  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).json({ message: 'You are not whitelisted' });

  const script = req.body?.script;
  if (!script) return res.status(400).json({ message: 'No script provided' });
  const username = entry.User;
  if (!userQueues[username]) userQueues[username] = [];
  userQueues[username].push({ script });
  res.status(200).json({ message: 'Script queued for ' + username });
});

app.get('/queue', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.status(401).type('text/plain').send('');
  const whitelist = await getWhitelistFromGitHub();
  const entry = whitelist.find(u => u.Discord === discordId);
  if (!entry) return res.status(403).type('text/plain').send('');
  const username = entry.User;
  const queue = userQueues[username];
  if (!queue || queue.length === 0) return res.type('text/plain').send('');
  const nextScript = queue.shift();
  if (queue.length === 0) delete userQueues[username];
  res.type('text/plain').send(nextScript.script);
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});

discordClient.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
