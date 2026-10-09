const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const PORT = 8080;
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// ===== LAN IP Auto-detect =====
function getLocalIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  const preferred = candidates.find(ip =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')
  );
  return preferred || candidates[0] || '127.0.0.1';
}

const SERVER_IP = getLocalIP();
const EXAM_URL = `http://${SERVER_IP}:${PORT}/`;

// ===== Shuffle =====
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQ(q, category) {
  const indexed = q.choices.map((c, i) => ({ text: c, isCorrect: i === q.answer }));
  const shuffled = shuffle(indexed);
  return {
    category,
    question: q.q,
    choices: shuffled.map(x => x.text),
    answer: shuffled.findIndex(x => x.isCorrect)
  };
}

function generateExam() {
  const categories = ['Hardware', 'Software', 'Basic Usage'];
  const exam = [];
  let id = 1;
  for (const cat of categories) {
    const pool = questions[cat] || [];
    const picked = shuffle(pool).slice(0, 5);
    for (const q of picked) exam.push({ id: id++, ...buildQ(q, cat) });
  }
  const allPool = [...questions.Hardware, ...questions.Software, ...questions['Basic Usage']];
  const extra = shuffle(allPool).slice(0, 5);
  for (const q of extra) exam.push({ id: id++, ...buildQ(q, 'Mixed') });
  return shuffle(exam);
}

// ===== HTTP Server =====
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // ---- API: exam questions ----
  if (url === '/api/exam' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(generateExam()));
    return;
  }

  // ---- API: QR info (JSON) ----
  if (url === '/api/qr' && req.method === 'GET') {
    try {
      const dataUrl = await QRCode.toDataURL(EXAM_URL, {
        width: 400,
        margin: 2,
        color: { dark: '#4338ca', light: '#ffffff' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: EXAM_URL, ip: SERVER_IP, port: PORT, qr: dataUrl }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- Admin / QR landing page ----
  if (url === '/admin' || url === '/qr') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ---- Exam page ----
  if (url === '/' || url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║      💻 COMPUTER BASIC MCQ EXAM SERVER       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🎛  Admin (QR):   http://${SERVER_IP}:${PORT}/admin`);
  console.log(`  📝 Exam page:    ${EXAM_URL}`);
  console.log('');
  console.log('  ➜ Admin page ကိုဖွင့်ပြီး QR ကို ဖုန်းများနဲ့ scan ပါ');
  console.log('');
});
