require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
// const crypto = require('crypto'); // Não será mais usado diretamente se generateLogId for removido
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ChannelType } = require('discord.js');
// Octokit, Passport, Session, etc., removidos pois eram do executor/auth

// Config from environment variables
const config = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1331021897735081984', 
  PORT: process.env.PORT || 3000,

  WEBHOOK_GAMELOGS_2_9: process.env.WEBHOOK_GAMELOGS_2_9,
  WEBHOOK_GAMELOGS_10_49: process.env.WEBHOOK_GAMELOGS_10_49,
  WEBHOOK_GAMELOGS_50_200: process.env.WEBHOOK_GAMELOGS_50_200,
  WEBHOOK_GAMELOGS_PREMIUM: process.env.WEBHOOK_GAMELOGS_PREMIUM,

  GAME_STATS_CURRENT_ACTIVE_VC_ID: process.env.GAME_STATS_CURRENT_ACTIVE_VC_ID || '1373732957910470699',
  GAME_STATS_TOTAL_GAMES_VC_ID: process.env.GAME_STATS_TOTAL_GAMES_VC_ID || '1373733192229720225',
};

// --- VALIDAÇÕES DE CONFIGURAÇÃO ESSENCIAL ---
if (!config.DISCORD_BOT_TOKEN) {
  console.error('FATAL ERROR: Missing DISCORD_BOT_TOKEN. Please check your .env file.');
  process.exit(1);
}
if (!config.WEBHOOK_GAMELOGS_2_9 || !config.WEBHOOK_GAMELOGS_10_49 || !config.WEBHOOK_GAMELOGS_50_200 || !config.WEBHOOK_GAMELOGS_PREMIUM) {
    console.warn("Warning: One or more WEBHOOK_GAMELOGS URLs are not set. The /send/gamelogs feature might not work correctly.");
}
if (!config.GAME_STATS_CURRENT_ACTIVE_VC_ID || !config.GAME_STATS_TOTAL_GAMES_VC_ID){
    console.warn("Warning: One or both GAME_STATS voice channel IDs are not set. Stats display may fail.");
} else if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID === config.GAME_STATS_TOTAL_GAMES_VC_ID && config.GAME_STATS_TOTAL_GAMES_VC_ID) {
    console.warn(`Warning: GAME_STATS_CURRENT_ACTIVE_VC_ID and GAME_STATS_TOTAL_GAMES_VC_ID are the same. Only one statistic will be effectively displayed.`);
}

const app = express();
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // GatewayIntentBits.GuildMessages, // Não estritamente necessário se não houver comandos de chat
    // GatewayIntentBits.MessageContent, // Mesma razão acima
    // GatewayIntentBits.GuildMembers // Necessário se você for buscar membros para algo, mas removido com executor
  ]
});

const gameStats = new Map(); // Key: gameId, Value: { ..., lastUpdate: timestamp }
const GAME_DATA_EXPIRY_MS = 30 * 60 * 1000; // 30 minutos

// Debounce para atualização dos nomes dos canais de voz
let voiceChannelUpdateTimeout = null;
const VOICE_CHANNEL_UPDATE_DEBOUNCE_MS = 5 * 60 * 1000; // Reduzido para 5 minutos para testes, ajuste conforme necessário (era 10min)


app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// --- FUNÇÕES HELPER PARA GAMELOGS E ESTATÍSTICAS ---

async function sendAdminNotification(title, description, color = 0xFF0000, additionalFields = []) {
    try {
        if (!config.LOG_CHANNEL_ID || !discordClient.isReady()) {
            console.warn(`AdminNotification: LOG_CHANNEL_ID (${config.LOG_CHANNEL_ID}) not configured or client not ready. Skipping notification: ${title}`);
            return;
        }
        const logChannel = await discordClient.channels.fetch(config.LOG_CHANNEL_ID).catch(err => {
            console.error(`AdminNotification: Failed to fetch log channel. Error: ${err.message}`);
            return null;
        });
        if (!logChannel) return;

        const logEmbed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.substring(0, 4000)).setTimestamp();
        additionalFields.forEach(field => { if (logEmbed.data.fields && logEmbed.data.fields.length < 24) logEmbed.addFields(field);});
        
        await logChannel.send({ embeds: [logEmbed] });
    } catch (logSendError) {
        console.error(`CRITICAL: Failed to send admin notification to Discord: ${logSendError.message}`);
    }
}


function parseGameDataFromEmbed(description) {
    if (!description) return null;
    const parseNumeric = (str) => {
        if (!str) return 0;
        const cleaned = String(str).replace(/[^\d,]/g, '').replace(',', ''); 
        const num = parseInt(cleaned, 10);
        return isNaN(num) ? 0 : num;
    };
    const gameIdMatch = description.match(/games\/(\d+)/);
    const gameNameMatch = description.match(/\*\*Game Name\*\*: (.*?)\n/);
    const activePlayersMatch = description.match(/\*\*Active Players\*\*: `%?([\d,]+)%?`/);
    const visitsMatch = description.match(/\*\*Visits\*\*: `%?([\d,]+)%?`/);

    return {
        gameId: gameIdMatch ? gameIdMatch[1] : null,
        gameName: gameNameMatch ? gameNameMatch[1].trim() : "Unknown Game",
        activePlayers: activePlayersMatch ? parseNumeric(activePlayersMatch[1]) : 0,
        visits: visitsMatch ? parseNumeric(visitsMatch[1]) : 0,
    };
}

async function actualUpdateDiscordVoiceChannelNames() {
    if (!discordClient.isReady()) {
        console.warn("[VoiceUpdate] Discord client not ready. Skipping.");
        return;
    }
    const now = Date.now();
    let totalActivePlayers = 0;
    const uniqueActiveGamesForPlayerCount = new Map();

    for (const [gameId, data] of gameStats.entries()) {
        if (now - data.lastUpdate > GAME_DATA_EXPIRY_MS) {
            gameStats.delete(gameId);
        } else {
            if (!uniqueActiveGamesForPlayerCount.has(gameId) || data.activePlayers > uniqueActiveGamesForPlayerCount.get(gameId)) {
                uniqueActiveGamesForPlayerCount.set(gameId, data.activePlayers);
            }
        }
    }
    uniqueActiveGamesForPlayerCount.forEach(players => totalActivePlayers += players);
    const totalUniqueGames = gameStats.size;
    console.log(`[VoiceUpdate] Calculated: Active Players = ${totalActivePlayers}, Total Games = ${totalUniqueGames}`);
    const formatNumber = (num) => num.toLocaleString('en-US');

    if (config.GAME_STATS_CURRENT_ACTIVE_VC_ID) {
        try {
            const channel = await discordClient.channels.fetch(config.GAME_STATS_CURRENT_ACTIVE_VC_ID);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const newName = `Current active: ${formatNumber(totalActivePlayers)}`;
                if (channel.name !== newName) {
                    await channel.setName(newName, 'Updating game statistics');
                    console.log(`[VoiceUpdate] 'Current active' VC updated to: ${newName}`);
                }
            } else { console.warn(`[VoiceUpdate] Active players VC (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID}) not found/not voice.`); }
        } catch (error) { console.error(`[VoiceUpdate] Error updating 'Current active' VC:`, error.message); }
    }
    if (config.GAME_STATS_TOTAL_GAMES_VC_ID) {
        try {
            const channel = await discordClient.channels.fetch(config.GAME_STATS_TOTAL_GAMES_VC_ID);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const newName = `Total Games: ${formatNumber(totalUniqueGames)}`;
                if (channel.name !== newName) {
                    await channel.setName(newName, 'Updating game statistics');
                    console.log(`[VoiceUpdate] 'Total Games' VC updated to: ${newName}`);
                }
            } else { console.warn(`[VoiceUpdate] Total games VC (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID}) not found/not voice.`);}
        } catch (error) { console.error(`[VoiceUpdate] Error updating 'Total Games' VC:`, error.message); }
    }
}

function scheduleVoiceChannelUpdate() {
    if (voiceChannelUpdateTimeout) {
        clearTimeout(voiceChannelUpdateTimeout);
    }
    voiceChannelUpdateTimeout = setTimeout(async () => {
        console.log("[VoiceUpdateDebounce] Debounce time reached. Executing voice channel name updates.");
        try {
            await actualUpdateDiscordVoiceChannelNames();
        } catch (error) {
            console.error("[VoiceUpdateDebounce] Error during debounced execution:", error);
        }
        voiceChannelUpdateTimeout = null; 
    }, VOICE_CHANNEL_UPDATE_DEBOUNCE_MS);
}

// --- HANDLER DAS ROTAS DE GAMELOG (PÚBLICO, SEM COOLDOWNS INTERNOS DE ENVIO DE WEBHOOK) ---
async function gameLogRequestHandler(req, res, webhookUrl, tierName) {
    const sourceIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',').shift();
    // console.log(`[Gamelog:${tierName}] PUBLIC Request from IP: ${sourceIp}, Path: ${req.path}`);

    if (!req.body || !req.body.embeds || !req.body.embeds.length) {
        return res.status(400).json({ status: 'error', message: 'Dados de embed inválidos ou ausentes.' });
    }
    if (!webhookUrl) {
        console.error(`[Gamelog:${tierName}] CRITICAL: webhookUrl UNDEFINED for tier. Path: ${req.path}`);
        await sendAdminNotification("Config Error Gamelog", `Webhook URL for tier ${tierName} is missing. Request path: ${req.path}.`);
        return res.status(500).json({ status: 'error', message: 'Erro de config: URL de webhook ausente.' });
    }

    const embedData = req.body.embeds[0];
    
    // Tentativa de parsear dados do jogo para estatísticas locais
    if (embedData && embedData.description) {
        const gameData = parseGameDataFromEmbed(embedData.description);
        if (gameData && gameData.gameId) {
            const now = Date.now();
            // Prioriza dados existentes em gameStats e atualiza com novos.
            const existingEntry = gameStats.get(gameData.gameId) || {};
            const updatedEntry = { ...existingEntry, ...gameData, lastUpdate: now };
            gameStats.set(gameData.gameId, updatedEntry);
            // console.log(`[Gamelog:${tierName}] Stats locais atualizadas para GameID: ${gameData.gameId}`);
        } else {
            // console.warn(`[Gamelog:${tierName}] Não foi possível parsear gameId para stats. Desc: ${embedData.description.substring(0,100)}`);
        }
    } else {
        // console.warn(`[Gamelog:${tierName}] Embed ou descrição ausentes. Não é possível atualizar stats locais.`);
    }
    
    // TENTA ENVIAR PARA O WEBHOOK PROVIDER (EX: webhook.lewisakura.moe) IMEDIATAMENTE
    // console.warn(`[Gamelog:${tierName}] SEM COOLDOWN INTERNO! Tentando encaminhar para ${webhookUrl.substring(0,50)} GameID: ${embedData?.description?.match(/games\/(\d+)/)?.[1] || 'N/A'}`);
    try {
        await axios.post(webhookUrl, req.body, { // req.body aqui é o payload JSON completo da requisição original
            headers: { 
                'Content-Type': 'application/json',
                // O User-Agent é definido automaticamente pelo Axios, mas pode ser sobrescrito se necessário:
                // 'User-Agent': 'MinhaAplicacaoCustomizada/1.0 (+http://meusite.com/bot-info)'
            }, 
            timeout: 10000 // Timeout de 10 segundos para a requisição do webhook
        });
        
        // console.log(`[Gamelog:${tierName}] Encaminhado com sucesso para ${webhookUrl.substring(0,50)}.`);
        res.status(200).json({ status: 'success', message: 'Game log recebido e encaminhado.' });
    
    } catch (error) {
        let errorDetail = error.message;
        let responseStatus = "N/A";
        let responseDataPreview = "N/A";

        if (error.response) {
            responseStatus = error.response.status;
            errorDetail = `Webhook externo respondeu com Status ${responseStatus}`;
            responseDataPreview = typeof error.response.data === 'string' ? error.response.data.substring(0, 200) : JSON.stringify(error.response.data).substring(0, 200);
            console.error(`[Gamelog:${tierName}] Erro no Webhook Externo: Status ${responseStatus}, Data: ${responseDataPreview}, URL: ${webhookUrl.substring(0,70)}`);

            if (responseStatus === 403) { // Erro "Forbidden" do provedor do webhook (ex: Cloudflare)
                await sendAdminNotification(
                    `Webhook Bloqueado (403) - Tier ${tierName}`,
                    `O webhook para o tier ${tierName} (${webhookUrl.substring(0,70)}...) está retornando 403 (Forbidden).`+
                    `Isso geralmente significa que um sistema de segurança (como Cloudflare) no lado do provedor do webhook está bloqueando as requisições deste servidor. `+
                    `Verifique as configurações de firewall/WAF do provedor do webhook ou entre em contato com o administrador dele.`,
                    0xFFA500, // Laranja
                    [
                        {name: "Webhook URL", value: webhookUrl},
                        {name: "IP de Origem (Aproximado)", value: sourceIp},
                        {name: "Resposta do Webhook (Preview)", value: `\`\`\`html\n${responseDataPreview}\n\`\`\``}
                    ]
                );
            } else if (responseStatus === 429) { // Erro "Too Many Requests" do provedor do webhook
                 await sendAdminNotification(
                    `Webhook Rate Limited (429) - Tier ${tierName}`,
                    `O webhook para o tier ${tierName} (${webhookUrl.substring(0,70)}...) está retornando 429 (Too Many Requests). `+
                    `O provedor do webhook está limitando a taxa das requisições. Reduza a frequência de envio ou contate o administrador do webhook.`,
                    0xFFD700, // Amarelo/Ouro
                    [
                        {name: "Webhook URL", value: webhookUrl},
                        {name: "IP de Origem (Aproximado)", value: sourceIp},
                    ]
                );
            }

        } else { // Erros de rede, timeout, etc.
            console.error(`[Gamelog:${tierName}] Erro de encaminhamento de rede/timeout: ${errorDetail}, URL: ${webhookUrl.substring(0,70)}`);
        }
        res.status(502).json({ status: 'error', message: `Falha ao encaminhar: ${errorDetail} (Status: ${responseStatus})` });
    }
    scheduleVoiceChannelUpdate(); // Agendar atualização dos canais de voz
}


// --- ROTAS DA APLICAÇÃO ---

// Rota raiz simples
app.get('/', (req, res) => {
    res.send('API de Gamelogs está funcionando. Use os endpoints /send/gamelogs/* para enviar dados.');
});

// Endpoints de Gamelog
app.post('/send/gamelogs/9', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_2_9, '2-9');
});
app.post('/send/gamelogs/49', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_10_49, '10-49');
});
app.post('/send/gamelogs/200', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_50_200, '50-200');
});
app.post('/send/gamelogs/Premium', (req, res) => {
    gameLogRequestHandler(req, res, config.WEBHOOK_GAMELOGS_PREMIUM, 'Premium');
});


// --- EVENTOS DO DISCORD ---
discordClient.on('ready', () => {
  console.log(`Bot Discord logado como ${discordClient.user.tag}.`);
  discordClient.user.setStatus('online'); // ou 'dnd', 'idle'
  discordClient.user.setActivity('Monitorando Gamelogs', { type: ActivityType.Watching }); 
  scheduleVoiceChannelUpdate(); // Agendar uma atualização inicial dos nomes dos canais
});

// Listener de interações simplificado (sem os botões do sistema de executor)
discordClient.on('interactionCreate', async interaction => { 
  if (!interaction.isButton()) return;
  
  // Se você tiver outros botões que não são do executor, adicione a lógica aqui.
  // Por enquanto, apenas um log de que um botão desconhecido foi pressionado.
  console.log(`[Interaction] Botão com ID '${interaction.customId}' pressionado por ${interaction.user.tag}.`);
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Interação recebida, mas nenhuma ação configurada para este botão.', ephemeral: true });
    }
  } catch (error) {
      console.error("[Interaction] Erro ao responder à interação de botão:", error);
  }
});


// --- HANDLERS DE ERRO DE PROCESSO ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  // Em vez de JSON.stringify(promise), que pode ser um objeto grande e complexo:
  sendAdminNotification('Unhandled Rejection no Servidor', `**Motivo:** ${reason}\n\nCheque os logs do servidor para mais detalhes.`, 0xCC0000)
    .catch(e => console.error("Falha ao enviar log de unhandledRejection:", e));
});
process.on('uncaughtException', (error, origin) => {
  console.error('Uncaught Exception:', error, 'Origem:', origin);
  sendAdminNotification('Uncaught Exception no Servidor', `**Erro:** ${error.message}\n**Origem:** ${origin}\n\nStack: \`\`\`\n${error.stack ? error.stack.substring(0,1000) : 'N/A'}\n\`\`\``, 0xCC0000)
   .catch(e => console.error("Falha ao enviar log de uncaughtException:", e));
  // Considerar encerrar o processo para exceções não tratadas realmente graves após logar,
  // pois o estado da aplicação pode estar corrompido. Render reiniciará o serviço.
  // setTimeout(() => process.exit(1), 2000); // Dá tempo para o log enviar
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
  try {
    await discordClient.login(config.DISCORD_BOT_TOKEN);
    app.listen(config.PORT, () => {
        console.log(`API de Gamelogs escutando na porta ${config.PORT}. Bot Discord conectado.`);
        console.log(`Canal de Admin Notificações (LOG_CHANNEL_ID): ${config.LOG_CHANNEL_ID || 'NÃO CONFIGURADO'}`);
        console.log(`Canais de Voz para Stats: Ativos (ID: ${config.GAME_STATS_CURRENT_ACTIVE_VC_ID || 'NÃO CONFIG.'}), Total (ID: ${config.GAME_STATS_TOTAL_GAMES_VC_ID || 'NÃO CONFIG.'})`);
    });
  } catch (error) {
    console.error('Falha Crítica na Inicialização do Servidor:', error);
    process.exit(1); // Encerra se não conseguir iniciar
  }
}

startServer();
