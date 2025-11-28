/*
 * =================================================================================
 * SERVER.JS - Version 5.0.0 (SECURE EDITION)
 * =================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// إصلاح توقيت قاعدة البيانات
types.setTypeParser(1114, (stringValue) => stringValue);
types.setTypeParser(1184, (stringValue) => stringValue);

const app = express();
const PORT = process.env.PORT || 3001;

// 1. إعدادات الأمان الأساسية (Helmet)
app.use(helmet());

// 2. إعداد CORS (السماح فقط للنطاقات الموثوقة)
const allowedOrigins = [
    'https://tarekalsyed.github.io', 
    'http://localhost:3000', 
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS Policy'));
        }
    },
    credentials: false, // تم التعطيل لزيادة الأمان كما في التقرير
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({ limit: '10kb' })); // تحديد حجم البيانات
app.use(bodyParser.urlencoded({ extended: true }));

// 3. الاتصال بقاعدة البيانات
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 4. Rate Limiting (الحماية من الهجمات)
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 100, // حد أقصى 100 طلب
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // ساعة
    max: 5, // 5 محاولات فقط
    message: { error: 'Too many login attempts, please try again in an hour.' }
});

// ================== تهيئة قاعدة البيانات ==================
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Checking tables...');
        
        // جداول الطلاب
        await client.query(`CREATE TABLE IF NOT EXISTS students (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, isBlocked BOOLEAN DEFAULT FALSE)`);
        
        // جداول النتائج
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_results (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), quizName TEXT NOT NULL, subjectId TEXT, score INTEGER NOT NULL, totalQuestions INTEGER NOT NULL, correctAnswers INTEGER NOT NULL, completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جداول الرسائل
        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), content TEXT NOT NULL, adminReply TEXT, isRead BOOLEAN DEFAULT FALSE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جداول السجلات
        await client.query(`CREATE TABLE IF NOT EXISTS login_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, logoutTime TIMESTAMPTZ)`);
        await client.query(`CREATE TABLE IF NOT EXISTS activity_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), activityType TEXT NOT NULL, subjectName TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جداول الحماية والبصمة
        await client.query(`CREATE TABLE IF NOT EXISTS student_fingerprints (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), fingerprint TEXT NOT NULL, lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, UNIQUE(studentId, fingerprint))`);
        await client.query(`CREATE TABLE IF NOT EXISTS blocked_fingerprints (id SERIAL PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, reason TEXT, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_status (id SERIAL PRIMARY KEY, subjectId TEXT UNIQUE NOT NULL, locked BOOLEAN DEFAULT FALSE, message TEXT, updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);

        console.log('✅ [DB] Database Ready and Secure.');
    } catch (err) { console.error('❌ [DB] Error:', err); } finally { client.release(); }
}

// ================== Middleware للمصادقة ==================
function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden: Invalid token' });
        if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden: Not admin' });
        req.user = user;
        next();
    });
}

// ================== الـ API Endpoints ==================

// 1. تسجيل دخول الأدمن (Secure)
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { password } = req.body;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminHash) return res.status(500).json({ error: 'Server Config Error: Hash missing' });

    const isMatch = await bcrypt.compare(password, adminHash);
    if (isMatch) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, message: 'Login successful' });
    } else {
        res.status(401).json({ error: 'Incorrect password' });
    }
});

// 2. التحقق من البصمة (Secure)
app.post('/api/verify-fingerprint', async (req, res) => {
    const { fingerprint } = req.body;
    if (!fingerprint) return res.status(400).json({ ok: false });

    try {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ ok: false, message: 'Device Blocked' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

// 3. تسجيل الطلاب
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing data' });

    // التحقق من الحظر قبل التسجيل
    if (fingerprint) {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
    }

    try {
        const result = await pool.query('INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
        const newStudent = result.rows[0];
        if (fingerprint) await pool.query('INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)', [newStudent.id, fingerprint]);
        res.json(newStudent);
    } catch (err) {
        if (err.code === '23505') { // تكرار الإيميل
            const existing = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
            if (existing.rows[0].isblocked) return res.status(403).json({ error: 'Account Blocked' });
            if (fingerprint) {
                await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen=CURRENT_TIMESTAMP`, [existing.rows[0].id, fingerprint]);
            }
            return res.json(existing.rows[0]);
        }
        res.status(500).json({ error: 'Server Error' });
    }
});

// 4. نظام الرسائل (مع الحد اليومي 3 رسائل)
app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;
    if (!studentId || !message) return res.status(400).json({ error: 'Missing data' });

    try {
        // التحقق من عدد الرسائل اليوم (PostgreSQL)
        const todayCount = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE studentId = $1 AND createdat >= CURRENT_DATE',
            [studentId]
        );

        const count = parseInt(todayCount.rows[0].count);
        if (count >= 3) {
            return res.status(429).json({ 
                error: 'لقد استنفذت رصيد الرسائل اليومي (3 رسائل).',
                remaining: 0 
            });
        }

        await pool.query('INSERT INTO messages (studentId, content) VALUES ($1, $2)', [studentId, message]);
        res.json({ message: 'Sent', remaining: 2 - count });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error sending message' });
    }
});

// باقي الـ Endpoints (تم تأمينها أو تركها كما هي إذا كانت عامة)

app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    try {
        if (fingerprint) {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
            await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen=CURRENT_TIMESTAMP`, [studentId, fingerprint]);
        }
        const result = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
        res.json({ logId: result.rows[0].id });
    } catch (e) { res.status(500).json({ error: 'Login Error' }); }
});

// --- وظائف عامة (Public) ---
app.get('/api/students/:id', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]); res.json(r.rows[0] || {}); } catch(e) { res.status(500).json({}); }
});

app.get('/api/students/:id/messages', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM messages WHERE studentId = $1 ORDER BY createdAt DESC LIMIT 20', [req.params.id]); res.json(r.rows); } catch(e) { res.status(500).json([]); }
});

app.post('/api/quiz-results', async (req, res) => {
    try { await pool.query('INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)', [req.body.studentId, req.body.quizName, req.body.subjectId, req.body.score, req.body.totalQuestions, req.body.correctAnswers]); res.json({ message: 'Saved' }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/students/:id/results', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [req.params.id]); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/students/:id/stats', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]); const rs = r.rows; if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0 }); res.json({ totalQuizzes: rs.length, averageScore: Math.round(rs.reduce((a, b) => a + b.score, 0) / rs.length), bestScore: Math.max(...rs.map(x => x.score)) }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/quiz-status', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM quiz_status'); const map = {}; r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message }); res.json(map); } catch (e) { res.json({}); }
});

app.get('/api/health', (req, res) => res.json({ status: 'OK', security: 'Enabled' }));

// --- وظائف الإدارة (Admin Only - Protected by JWT) ---

// جلب الرسائل
app.get('/api/admin/messages', authenticateAdmin, async (req, res) => {
    try { const r = await pool.query(`SELECT m.id, m.content, m.adminReply, m.createdAt, s.name as "studentName" FROM messages m JOIN students s ON m.studentId = s.id ORDER BY m.createdAt DESC LIMIT 100`); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// الرد على الرسائل
app.post('/api/admin/messages/:id/reply', authenticateAdmin, async (req, res) => {
    try { await pool.query('UPDATE messages SET adminReply = $1 WHERE id = $2', [req.body.reply, req.params.id]); res.json({ message: 'Replied' }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/admin/messages/:id', authenticateAdmin, async (req, res) => {
    try { await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]); res.json({ message: 'Deleted' }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/quiz-status/:subjectId', authenticateAdmin, async (req, res) => {
    try { await pool.query(`INSERT INTO quiz_status (subjectId, locked, message, updatedAt) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (subjectId) DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP`, [req.params.subjectId, req.body.locked, req.body.message]); res.json({ message: 'Updated' }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/students', authenticateAdmin, async (req, res) => {
    try { const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC'); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try { const s = await pool.query('SELECT COUNT(*) as t FROM students'); const q = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results'); res.json({ totalStudents: parseInt(s.rows[0].t), totalQuizzes: parseInt(q.rows[0].t), averageScore: Math.round(q.rows[0].a || 0) }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/activity-logs', authenticateAdmin, async (req, res) => {
    try { const r = await pool.query(`SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp FROM activity_logs act JOIN students s ON act.studentId = s.id ORDER BY act.timestamp DESC LIMIT 50`); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/login-logs', authenticateAdmin, async (req, res) => {
    try { const r = await pool.query(`SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime FROM login_logs ll JOIN students s ON ll.studentId = s.id ORDER BY ll.loginTime DESC LIMIT 50`); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// حظر الطالب
app.post('/api/admin/students/:id/status', authenticateAdmin, async (req, res) => {
    try { await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [req.body.isblocked, req.params.id]); res.json({ message: 'Updated' }); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// حظر البصمة
app.post('/api/admin/students/:id/block-fingerprint', authenticateAdmin, async (req, res) => {
    try {
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]);
        if (!fp.rows.length) return res.status(404).json({ error: 'No device found for this student' });
        
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']);
        res.json({ message: 'Device Blocked' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/unblock-fingerprint', authenticateAdmin, async (req, res) => {
    try {
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]);
        if (!fp.rows.length) return res.status(404).json({ error: 'No device found' });
        
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]);
        res.json({ message: 'Device Unblocked' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.listen(PORT, () => {
    console.log(`🚀 Secure Server running on port ${PORT}`);
    initializeDatabase();
});
