const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const PORT = 8080;
const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

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

// ===== Normalize (dedupe key) =====
function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ===== Build a single question (shuffled choices) =====
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

// ===== Pick unique questions (no duplicates in exam) =====
function pickUnique(pool, count, usedSet) {
  const picked = [];
  const localSeen = new Set();
  for (const q of shuffle(pool)) {
    if (picked.length >= count) break;
    const key = normalize(q.q);
    if (usedSet.has(key)) continue;   // exam တစ်ခုလုံးမှာ သုံးပြီး
    if (localSeen.has(key)) continue; // ဒီ category အတွင်း ထပ်
    localSeen.add(key);
    picked.push(q);
  }
  return picked;
}

// ===== Generate exam (no duplicate questions) =====
function generateExam() {
  const categories = ['Hardware', 'Software', 'Basic Usage'];
  const exam = [];
  const used = new Set();  // တစ်ခုလုံး exam အတွင်း ထပ်မပါအောင်
  let id = 1;

  // ၁။ category အလိုက် ၅ ခု
  for (const cat of categories) {
    const pool = questions[cat] || [];
    const picked = pickUnique(pool, 5, used);
    for (const q of picked) {
      used.add(normalize(q.q));
      exam.push({ id: id++, ...buildQ(q, cat) });
    }
  }

  // ၂။ mixed ၅ ခု — category ၃ ခုလုံးမှ (used ထဲက ကျော်)
  const allPool = [
    ...(questions.Hardware || []),
    ...(questions.Software || []),
    ...(questions['Basic Usage'] || [])
  ];
  const extra = pickUnique(allPool, 5, used);
  for (const q of extra) {
    used.add(normalize(q.q));
    exam.push({ id: id++, ...buildQ(q, 'Mixed') });
  }

  return shuffle(exam);
}

// ===== Exam sessions (server-side answers) =====
const examSessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function createSession() {
  const exam = generateExam();
  const sessionId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const answerKey = {};
  const clientQuestions = exam.map(q => {
    answerKey[q.id] = q.answer;
    return {
      id: q.id,
      category: q.category,
      question: q.question,
      choices: q.choices
    };
  });

  examSessions.set(sessionId, {
    answerKey,
    createdAt: Date.now()
  });

  // cleanup expired sessions
  for (const [sid, s] of examSessions) {
    if (Date.now() - s.createdAt > SESSION_TTL_MS) examSessions.delete(sid);
  }

  return { sessionId, questions: clientQuestions };
}

// ===== Helpers =====
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// ===== HTTP Server =====
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    url = req.url.split('?')[0];
  }

  // ---- API: create exam session (answers hidden) ----
  if (url === '/api/exam' && req.method === 'GET') {
    const { sessionId, questions: qs } = createSession();
    sendJSON(res, 200, { sessionId, questions: qs });
    return;
  }

  // ---- API: submit answers ----
  if (url === '/api/submit' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const { sessionId, answers } = payload;

      const session = examSessions.get(sessionId);
      if (!session) {
        sendJSON(res, 404, { error: 'Session expired or not found' });
        return;
      }

      const answerKey = session.answerKey;
      const results = [];
      let correct = 0;
      let total = 0;

      for (const idStr of Object.keys(answerKey)) {
        const id = Number(idStr);
        total++;
        const expected = answerKey[id];
        const given = answers ? answers[id] : undefined;
        const isCorrect = given === expected;
        if (isCorrect) correct++;
        results.push({ id, expected, given: given ?? null, isCorrect });
      }

      const score = total ? Math.round((correct / total) * 100) : 0;

      // session ကို တစ်ခါပဲ သုံးလို့ရအောင် ဖျက်
      examSessions.delete(sessionId);

      sendJSON(res, 200, { correct, total, score, results });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  // ---- API: QR info ----
  if (url === '/api/qr' && req.method === 'GET') {
    try {
      const dataUrl = await QRCode.toDataURL(EXAM_URL, {
        width: 400,
        margin: 2,
        color: { dark: '#4338ca', light: '#ffffff' }
      });
      sendJSON(res, 200, {
        url: EXAM_URL,
        ip: SERVER_IP,
        port: PORT,
        qr: dataUrl
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ---- Static files (public/static/...) ----
  if (url.startsWith('/static/')) {
    const rel = url.slice('/static/'.length);
    const baseDir = path.join(__dirname, 'public');
    const filePath = path.resolve(baseDir, rel);
    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    serveFile(res, filePath, types[ext] || 'application/octet-stream');
    return;
  }

  // ---- Admin / QR page ----
  if (url === '/admin' || url === '/qr') {
    serveFile(
      res,
      path.join(__dirname, 'public', 'admin.html'),
      'text/html; charset=utf-8'
    );
    return;
  }

  // ---- Exam page ----
  if (url === '/' || url === '/index.html') {
    serveFile(
      res,
      path.join(__dirname, 'public', 'index.html'),
      'text/html; charset=utf-8'
    );
    return;
  }

  // ---- 404 ----
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// ===== Graceful shutdown =====
process.on('SIGINT', () => {
  console.log('\n\n  👋 Server ပိတ်နေသည်...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

// ===== Start =====
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
