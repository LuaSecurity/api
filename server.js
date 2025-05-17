require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits } = require('discord.js');

const config = {
  API_KEY: process.env.API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
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
        scope: 'identify email guilds guilds.members.read'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const memberRes = await axios.get(`https://discord.com/api/users/@me/guilds/${config.SERVER_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const hasAccess = memberRes.data.roles.some(role => Object.values(config.ROLES).includes(role));
    if (!hasAccess) return res.status(403).send('Access denied: You do not have the required role in the server.');

    res.cookie('discord_id', userRes.data.id, { httpOnly: true, maxAge: 86400000 });
    res.redirect('/executor');
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth2 authentication failed');
  }
});

app.get('/executor', async (req, res) => {
  const discordId = req.cookies.discord_id;
  if (!discordId) return res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${config.BOT_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.REDIRECT_URI)}&response_type=code&scope=identify%20email%20guilds%20guilds.members.read`);

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
      <title>Lua Control Panel</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        body, html { margin: 0; padding: 0; font-family: 'Inter', sans-serif; background: #101010; color: white; height: 100%; }
        .container { display: flex; height: 100vh; }
        .sidebar {
          background: linear-gradient(180deg, #2d0a52, #1a1a1a);
          width: 240px;
          padding: 30px 20px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
        }
        .sidebar h1 { font-size: 24px; margin-bottom: 30px; color: white; }
        .nav-link { margin-bottom: 20px; text-decoration: none; color: #bbb; font-weight: 600; font-size: 16px; }
        .nav-link:hover, .nav-link.active { color: #fff; }
        .content { flex: 1; padding: 30px; display: flex; flex-direction: column; }
        .tabs { display: none; height: 100%; }
        .tabs.active { display: flex; flex-direction: column; height: 100%; }
        select, button {
          font-size: 16px; padding: 12px; border-radius: 6px; border: none;
          margin: 10px 0; background: #222; color: white;
        }
        #editor { flex: 1; min-height: 400px; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
        button { background: linear-gradient(90deg, #8e2de2, #4a00e0); cursor: pointer; font-weight: bold; }
        #response { margin-top: 15px; color: lime; font-size: 14px; white-space: pre-wrap; }
      </style>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs/loader.min.js"></script>
    </head>
    <body>
      <div class="container">
        <div class="sidebar">
          <h1>Lua Panel</h1>
          <a class="nav-link active" href="#" onclick="showTab('dashboard')">Dashboard</a>
          <a class="nav-link" href="#" onclick="showTab('executor')">Executor</a>
          <a class="nav-link" href="#" onclick="showTab('scripthub')">Script Hub</a>
          <a class="nav-link" href="#" onclick="showTab('pricing')">Pricing</a>
        </div>
        <div class="content">
          <div id="dashboard" class="tabs active">
            <h2>Welcome, ${username}</h2>
            <p>This is your dashboard. Use the sidebar to access the executor or scripts.</p>
          </div>

          <div id="executor" class="tabs">
            <div id="editor"></div>
            <button onclick="executeScript()">Execute</button>
            <div id="response"></div>
          </div>

          <div id="scripthub" class="tabs">
            <h2>Script Hub</h2>
            <select id="hub" onchange="loadScript(this.value)">
              <option value="">-- Choose a script --</option>
              ${scriptOptions}
            </select>
          </div>

          <div id="pricing" class="tabs">
            <h2>Pricing Tiers</h2>
            <p><strong>Standard:</strong> Basic access to community features.</p>
            <p><strong>Premium:</strong> Unlock premium hubs and exclusive scripts.</p>
            <p><strong>Ultimate:</strong> Full access, all scripts, priority support.</p>
          </div>
        </div>
      </div>
      <script>
        let editor;
        require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.1/min/vs' }});
        require(["vs/editor/editor.main"], function () {
          editor = monaco.editor.create(document.getElementById("editor"), {
            value: "-- Select or write your Lua script here",
            language: "lua",
            theme: "vs-dark",
            fontSize: 16,
            automaticLayout: true
          });
        });

        function loadScript(code) {
          if (editor) editor.setValue(code);
        }

        function executeScript() {
          const script = editor.getValue();
          fetch('/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script })
          })
          .then(r => r.json())
          .then(d => document.getElementById('response').innerText = d.message);
        }

        function showTab(tabId) {
          document.querySelectorAll('.tabs').forEach(tab => tab.classList.remove('active'));
          document.getElementById(tabId).classList.add('active');
          document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
          event.target.classList.add('active');
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
