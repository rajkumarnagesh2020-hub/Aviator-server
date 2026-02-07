const admin = require("firebase-admin");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const serviceAccount = require("./serviceAccountKey.json");

// --- FIREBASE INITIALIZE ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://skill-test-44ab9-default-rtdb.firebaseio.com"
});

const db = admin.firestore();
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- CONFIGURATION ---
const WINGO_MODES = { "30s": 30, "1m": 60, "3m": 180, "5m": 300 };
const PLINKO_DURATION = 60;

// --- GAME STATES ---
let aviatorData = { state: "IDLE", multiplier: 1.00, crashPoint: 0 };
let aviatorInterval;

// --- 1. AVIATOR ENGINE ---
function startAviatorRound() {
    aviatorData.state = "IDLE";
    aviatorData.multiplier = 1.00;
    aviatorData.crashPoint = (Math.random() < 0.1) ? (2 + Math.random() * 15) : (1.1 + Math.random() * 2.5);
    
    io.emit("round_idle", { countdown: 5 });

    setTimeout(() => {
        aviatorData.state = "FLYING";
        let startTime = Date.now();
        
        aviatorInterval = setInterval(() => {
            let elapsed = (Date.now() - startTime) / 1000;
            aviatorData.multiplier = Math.pow(1.08, elapsed * 1.5); 

            if (aviatorData.multiplier >= aviatorData.crashPoint) {
                clearInterval(aviatorInterval);
                aviatorData.state = "CRASHED";
                const finalMult = aviatorData.multiplier.toFixed(2);
                io.emit("round_crash", { finalMult });
                
                db.collection("aviator_history").add({ 
                    mult: finalMult, 
                    time: admin.firestore.FieldValue.serverTimestamp() 
                });

                broadcastAviatorHistory();

                setTimeout(startAviatorRound, 4000); 
            } else {
                io.emit("multiplier_update", { mult: aviatorData.multiplier.toFixed(2) });
            }
        }, 100);
    }, 5000);
}

async function broadcastAviatorHistory() {
    const snap = await db.collection("aviator_history").orderBy("time", "desc").limit(15).get();
    const history = snap.docs.map(doc => parseFloat(doc.data().mult));
    io.emit("history", history.reverse());
}

// --- 2. SETTLEMENT LOGIC ---
async function settleGame(mode, period, resultNum, type) {
    const colName = type === "wingo" ? "bets" : "plinko_bets";
    const bets = await db.collection(colName)
        .where("p", "==", period)
        .where("mode", "==", mode)
        .where("status", "==", "Pending").get();

    if (bets.empty) return;
    const batch = db.batch();

    bets.forEach(doc => {
        const bet = doc.data();
        let mult = 0;

        if (type === "wingo") {
            const isBig = resultNum >= 5;
            const colors = (resultNum === 0) ? ["Red", "Violet"] : (resultNum === 5) ? ["Green", "Violet"] : (resultNum % 2 === 0) ? ["Red"] : ["Green"];
            
            if (Number(bet.sel) === resultNum) mult = 9;
            else if (bet.sel === (isBig ? "Big" : "Small")) mult = 2;
            else if (colors.includes(bet.sel)) mult = (bet.sel === "Violet") ? 4.5 : 2;
        } else {
            const isRed = [0,2,4,6,8].includes(resultNum);
            if (Number(bet.target) === resultNum) mult = 9;
            else if (bet.target === (isRed ? "Red" : "Green")) mult = 2;
        }

        if (mult > 0) {
            batch.update(db.collection("users").doc(bet.uid), { balance: admin.firestore.FieldValue.increment(bet.amt * mult) });
            batch.update(doc.ref, { status: "Win", winAmt: bet.amt * mult });
        } else {
            batch.update(doc.ref, { status: "Loss" });
        }
    });
    await batch.commit();
}

// --- 3. SOCKET CONNECTIONS ---
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    broadcastAviatorHistory();
    socket.on("disconnect", () => console.log("Client disconnected"));
});

// --- 4. MAIN GAME TICK (1 Second Loop) ---
setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);

    // --- WinGo Loop ---
    for (const [mode, duration] of Object.entries(WINGO_MODES)) {
        const timeLeft = duration - (now % duration);
        io.emit(`timer_${mode}`, { timeLeft });

        // FIX: timeLeft === 1 पर रिजल्ट एमिट होगा ताकि ट्रांजिशन स्मूथ रहे
        if (timeLeft === 1) {
            const res = Math.floor(Math.random() * 10);
            
            // Period calculation (इसी वक्त का पीरियड जो खत्म होने वाला है)
            const date = new Date(now * 1000);
            const period = date.toISOString().slice(0,10).replace(/-/g,'') + Math.floor(now/duration).toString().slice(-5);
            
            const resultData = {
                p: period, n: res, s: res >= 5 ? "Big" : "Small",
                c: (res === 0) ? "Red+Violet" : (res === 5) ? "Green+Violet" : (res % 2 === 0) ? "Red" : "Green",
                time: admin.firestore.FieldValue.serverTimestamp()
            };

            // तुरंत एमिट करें (डेटाबेस सेव होने का इंतज़ार न करें)
            io.emit(`result_${mode}`, resultData);
            
            // डेटाबेस सेव और सेटलमेंट बैकग्राउंड में होगा
            db.collection("game_results").doc(mode).collection("history").add(resultData);
            settleGame(mode, period, res, "wingo");
        }
    }

    // --- Plinko Loop ---
    const pTimeLeft = PLINKO_DURATION - (now % PLINKO_DURATION);
    io.emit("plinko_timer", { timeLeft: pTimeLeft });

    if (pTimeLeft === 1) {
        const pRes = Math.floor(Math.random() * 10);
        
        const lastPTime = now;
        const pPeriod = new Date(lastPTime * 1000).toISOString().slice(0,10).replace(/-/g,'') + Math.floor(lastPTime/60).toString().slice(-5);
        
        await db.collection("game_state").doc("plinko").set({ 
            timeLeft: PLINKO_DURATION, 
            isDropping: true, 
            result: pRes,
            period: pPeriod
        }, { merge: true });

        io.emit("plinko_result", { result: pRes, period: pPeriod });
        
        settleGame("plinko", pPeriod, pRes, "plinko");
    }
}, 1000);

// Server Start
startAviatorRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- Server Running on Port ${PORT} ---`);
    console.log(`Aviator, WinGo, and Plinko Engines are Active.`);
});