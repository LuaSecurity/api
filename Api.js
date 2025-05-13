const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Rota para verificar o username
app.get('/Verify/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        // URL do arquivo JSON no GitHub
        const githubUrl = 'https://raw.githubusercontent.com/RelaxxxX-Lab/Lua-things/main/Whitelist.json';
        
        // Buscar o arquivo JSON do GitHub
        const response = await axios.get(githubUrl);
        const users = response.data;
        
        // Verificar se o username existe
        const userData = users.find(user => user.user.toLowerCase() === username.toLowerCase());
        
        if (userData) {
            // Se encontrado, retorna os dados
            res.json({
                status: 'success',
                user: userData.user,
                discord: userData.discord, // Note que no JSON está "discord" (com typo)
                whitelist: userData.whitelist
            });
        } else {
            // Se não encontrado
            res.status(404).json({
                status: 'error',
                message: 'Username not found in whitelist'
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({
            status: 'error',
            message: 'Internal server error'
        });
    }
});

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
