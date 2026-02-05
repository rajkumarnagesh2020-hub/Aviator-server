const express = require('express');
const http = require('http');
const https = require('https'); // इनबिल्ट मॉड्यूल
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Render के लिए पोर्ट सेटिंग
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gameState = 'IDLE'; 
let multiplier = 1.00;
let crashAt = 0;
let gameInterval;

// --- RENDER SLEEP SOLUTION ---
// जब Render से लिंक मिल जाए, तो यहाँ अपना URL डाल देना
const RENDER_URL = "https://your-app-name.onrender.com"; 

setInterval(() => {
    if (RENDER_URL.includes("onrender.com")) {
        https.get(RENDER_URL, (res) => {
            console.log('Self-Ping: Server Awake');
        }).on('error', (e) => {
            console.error('Ping Error:', e.message);
        });
    }
}, 10 * 60 * 1000); // हर 10 मिनट में पिंग

app.get('/', (req, res) => {
    res.send('Aviator Server is Live 24/7');
});
// -----------------------------

function startNewRound() {
    gameState = 'IDLE';
    multiplier = 1.00;
    const r = Math.random();
    if (r < 0.1) crashAt = 1.00;
    else if (r < 0.3) crashAt = (1.1 + Math.random() * 0.5).toFixed(2);
    else crashAt = (1.5 + Math.pow(Math.random(), 2) * 20).toFixed(2);
    io.emit('round_idle', { countdown: 5 });
    setTimeout(launch, 5000);
}

function launch() {
    gameState = 'FLYING';
    let startTime = Date.now();
    gameInterval = setInterval(() => {
        let elapsed = (Date.now() - startTime) / 1000;
        multiplier = (1 + 0.08 * Math.pow(elapsed, 1.25)).toFixed(2);
        if (parseFloat(multiplier) >= parseFloat(crashAt)) {
            crash();
        } else {
            io.emit('multiplier_update', { mult: multiplier });
        }
    }, 100);
}

function crash() {
    clearInterval(gameInterval);
    gameState = 'CRASHED';
    io.emit('round_crash', { finalMult: multiplier });
    setTimeout(startNewRound, 3000);
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startNewRound();
});