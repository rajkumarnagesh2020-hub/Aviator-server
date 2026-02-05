const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gameState = 'IDLE'; 
let multiplier = 1.00;
let crashAt = 0;
let gameInterval;
let history = []; 
let totalRoundPool = 0; // इस राउंड में कुल कितना पैसा लगा है

// --- CONFIGURATION ---
const HOUSE_EDGE = 3; // 3% इंस्टेंट क्रैश (1.00x)
const PROFIT_GUARD_THRESHOLD = 5000; // अगर कुल दांव 5000 से ऊपर जाए, तो रिस्क कम करो

const RENDER_URL = "https://aviator-server-3cid.onrender.com/"; 

setInterval(() => {
    if (RENDER_URL.includes("onrender.com")) {
        https.get(RENDER_URL, (res) => {}).on('error', (e) => {});
    }
}, 10 * 60 * 1000); 

app.get('/', (req, res) => { res.send('Aviator Server: Anti-Cheat & Profit Guard Active'); });

// --- CORE LOGIC ---

function startNewRound() {
    gameState = 'IDLE';
    multiplier = 1.00;
    totalRoundPool = 0; // पूल रिसेट करें

    const r = Math.random() * 100;

    if (r < HOUSE_EDGE) {
        crashAt = 1.00;
    } else {
        let randomVal = Math.random() * 99; 
        crashAt = (99 / (100 - randomVal)).toFixed(2);

        // सुरक्षा: बहुत बड़े रैंडम नंबर को कंट्रोल करें
        if (parseFloat(crashAt) > 50) {
            crashAt = (10 + Math.random() * 15).toFixed(2);
        }
    }

    console.log(`Planned Crash: ${crashAt}`);
    io.emit('round_idle', { countdown: 5 });
    io.emit('history', history);

    setTimeout(launch, 5000);
}

function launch() {
    gameState = 'FLYING';
    let startTime = Date.now();
    
    gameInterval = setInterval(() => {
        let elapsed = (Date.now() - startTime) / 1000;
        multiplier = (1 + 0.08 * Math.pow(elapsed, 1.25)).toFixed(2);
        
        // --- ANTI-CHEAT / PROFIT GUARD ---
        // अगर बहुत ज्यादा पैसा दांव पर लगा है, तो गेम को 1.5x - 2.5x के बीच क्रैश कर दो
        if (totalRoundPool > PROFIT_GUARD_THRESHOLD && multiplier > 1.8) {
            console.log("Profit Guard Activated: Force Crashing...");
            crash();
            return;
        }

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
    
    history.push(parseFloat(multiplier));
    if (history.length > 15) history.shift();

    io.emit('round_crash', { finalMult: multiplier });
    setTimeout(startNewRound, 3000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.emit('history', history);

    // जब क्लाइंट दांव लगाए, तो सर्वर को सूचित करे (पूल अपडेट के लिए)
    socket.on('place_bet', (data) => {
        if (data.amount) {
            totalRoundPool += parseFloat(data.amount);
            console.log(`Current Round Pool: ₹${totalRoundPool}`);
        }
    });

    socket.on('get_history', () => {
        socket.emit('history', history);
    });
});

server.listen(PORT, () => {
    console.log(`Server running with Profit Guard on port ${PORT}`);
    startNewRound();
});
