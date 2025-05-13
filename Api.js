const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Rota para verificar o username
app.get('/Verify/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        // URL do arquivo JSON no GitHub (usando raw.githubusercontent.com)
        const githubUrl = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';
        
        // Buscar o arquivo JSON do GitHub
        const response = await axios.get(githubUrl);
        const users = response.data;
        
        // Verificar se o username existe (comparação case-insensitive)
        const userData = users.find(user => 
            user.User.toLowerCase() === username.toLowerCase()
        );
        
        if (userData) {
            // Se encontrado, retorna os dados formatados
            res.json({
                status: 'success',
                user: userData.User,
                discord: userData.Discord,
                whitelist: userData.Whitelist
            });
        } else {
            // Se não encontrado
            res.status(404).json({
                status: 'error',
                message: 'Username not found in whitelist'
            });
        }
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            details: error.message
        });
    }
});

// Rota de teste para verificar se a API está online
app.get('/', (req, res) => {
    res.send('API de verificação de whitelist está online! Use /Verify/username');
});

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
