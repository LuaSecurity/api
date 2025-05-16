require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { Client, GatewayIntentBits } = require('discord.js');

// Configurações do ambiente
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

// Inicialização dos serviços
const app = express();
const octokit = new Octokit({ 
  auth: config.GITHUB_TOKEN,
  request: { timeout: 5000 }
});
const discordClient = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ] 
});

// Armazenamento em memória para scripts
const scriptQueues = new Map();

// Middleware
app.use(cors());  // Permitir acessos externos (Vercel ou outro domínio)
app.use(bodyParser.json({ limit: '10mb' }));

// Função para gerar ID de log
function generateLogId() {
  return crypto.randomBytes(8).toString('hex');
}

// Verificar se a requisição é proveniente do Roblox
function isFromRoblox(req) {
  const userAgent = req.headers['user-agent'] || '';
  return userAgent.includes('Roblox');
}

// Recuperar lista de permissões do GitHub
async function getWhitelistFromGitHub() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.GITHUB_REPO.split('/')[0],
      repo: config.GITHUB_REPO.split('/')[1],
      path: config.WHITELIST_PATH,
      ref: config.GITHUB_BRANCH,
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch (error) {
    console.error('Erro ao obter whitelist:', error.message);
    throw error;
  }
}

// Rota para executar o script
app.post('/submit', async (req, res) => {
  const { username, script } = req.body;

  if (!username || !script) {
    return res.status(400).json({ status: 'error', message: 'Usuário ou script ausente' });
  }

  try {
    const response = await axios.post(`https://luaserverside.onrender.com/queue/${username}`, { script });
    if (response.status === 200) {
      res.json({ status: 'success', message: 'Script enviado com sucesso!' });
    } else {
      res.status(500).json({ status: 'error', message: 'Falha ao enviar script para o servidor' });
    }
  } catch (error) {
    console.error('Erro ao enviar script:', error.message);
    res.status(500).json({ status: 'error', message: 'Erro interno ao enviar script' });
  }
});

// Rota para verificar o usuário
app.get('/verify/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();

  try {
    const whitelist = await getWhitelistFromGitHub();
    const foundUser = whitelist.find(user => user.User.toLowerCase() === username);

    if (!foundUser) {
      return res.status(404).json({ status: 'error', message: 'Usuário não encontrado na whitelist' });
    }

    res.json({ status: 'success', data: foundUser });
  } catch (error) {
    console.error('Erro na verificação:', error.message);
    res.status(500).json({ status: 'error', message: 'Erro interno ao verificar usuário' });
  }
});

// Rota para baixar arquivo
app.get('/download/:assetId', (req, res) => {
  const assetId = req.params.assetId;
  if (!/^\d+$/.test(assetId)) {
    return res.status(400).json({ status: 'error', message: 'ID de ativo inválido' });
  }

  const fileName = `${assetId}.rbxm`;
  const content = `-- Roblox model reference: ${assetId}`;

  res.set({
    'Content-Type': 'text/plain',
    'Content-Disposition': `attachment; filename="${fileName}"`
  }).send(content);
});

// Rota raiz
app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'API do Lua Executor está ativa!' });
});

// Evento de inicialização do Discord
discordClient.on('ready', () => {
  console.log(`Bot conectado como ${discordClient.user.tag}`);
  discordClient.user.setActivity('Whitelist Manager', { type: 'WATCHING' });
});

// Tratamento de erros gerais
process.on('unhandledRejection', error => {
  console.error('Erro não tratado:', error.message);
});

process.on('uncaughtException', error => {
  console.error('Exceção não capturada:', error.message);
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Login no Discord
discordClient.login(config.DISCORD_BOT_TOKEN)
  .then(() => console.log('Bot conectado com sucesso'))
  .catch(error => {
    console.error('Erro ao conectar o bot:', error.message);
    process.exit(1);
  });
