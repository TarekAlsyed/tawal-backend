/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 3.2.0 (FINAL COMPLETE: Admin Reply + Fixes)
 * =================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');

// إصلاح مشاكل التوقيت في Postgres
types.setTypeParser(1114, (stringValue) => stringValue);
types.setTypeParser(1184, (stringValue) => stringValue);

const app = express();
const PORT = process.env.PORT || 3001;

const corsOptions = {
    origin: ['https://tarekalsyed.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'],
    optionsSuccessStatus: 200,
    credentials: true
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 🔥 هام جداً: منع الكاش نهائياً
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------------------------------
// 1. تهيئة قاعدة البيانات
// ---------------------------------------------------------------------------------
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Checking tables...');
        
        // الجداول الأساسية
        await client.query(`CREATE TABLE IF NOT EXISTS students (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, isBlocked BOOLEAN DEFAULT FALSE)`);
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_results (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), quizName TEXT NOT NULL, subjectId TEXT, score INTEGER NOT NULL, totalQuestions INTEGER NOT NULL, correctAnswers INTEGER NOT NULL, completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        try { await client.query('ALTER TABLE quiz_results ADD COLUMN IF NOT EXISTS subjectId TEXT'); } catch (e) { }
        try { await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE'); } catch (e) { }
        
        // ✅ جدول الرسائل (مع عمود الرد الجديد)
        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), content TEXT NOT NULL, adminReply TEXT, isRead BOOLEAN DEFAULT FALSE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        try { await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS adminReply TEXT'); } catch (e) { }

        // باقي الجداول
        await client.query(`CREATE TABLE IF NOT EXISTS login_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, logoutTime TIMESTAMPTZ)`);
        await client.query(`CREATE TABLE IF NOT EXISTS activity_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), activityType TEXT NOT NULL, subjectName TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS student_fingerprints (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), fingerprint TEXT NOT NULL, lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, UNIQUE(studentId, fingerprint))`);
        await client.query(`CREATE TABLE IF NOT EXISTS blocked_fingerprints (id SERIAL PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, reason TEXT, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_status (id SERIAL PRIMARY KEY, subjectId TEXT UNIQUE NOT NULL, locked BOOLEAN DEFAULT FALSE, message TEXT, updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        console.log('✅ [DB] Database Ready.');
    } catch (err) { console.error('❌ [DB] Error:', err); } finally { client.release(); }
}

// ---------------------------------------------------------------------------------
// 2. إدارة الطلاب (Auth)
// ---------------------------------------------------------------------------------
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'بيانات ناقصة' });

    if (fingerprint) {
        try {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'جهاز محظور' });
        } catch (e) {}
    }

    try {
        const result = await pool.query('INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
        const newStudent = result.rows[0];
        if (fingerprint) await pool.query('INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)', [newStudent.id, fingerprint]);
        res.json(newStudent);
    } catch (err) {
        if (err.code === '23505') {
            const existing = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
            if (existing.rows[0].isblocked) return res.status(403).json({ error: 'حساب محظور' });
            if (fingerprint) await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen=CURRENT_TIMESTAMP`, [existing.rows[0].id, fingerprint]);
            return res.json(existing.rows[0]);
        }
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    try {
        if (fingerprint) {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'جهاز محظور' });
            await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen=CURRENT_TIMESTAMP`, [studentId, fingerprint]);
        }
        const result = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
        res.json({ logId: result.rows[0].id });
    } catch (e) { res.status(500).json({ error: 'Login Error' }); }
});

app.get('/api/students/:id', async (req, res) => {
    try {
        const resDb = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
        if (!resDb.rows.length) return res.status(404).json({ error: 'Not Found' });
        res.json(resDb.rows[0]);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------------------------------
// 3. نظام الرسائل والردود (Messaging System)
// ---------------------------------------------------------------------------------
app.post('/api/messages', async (req, res) => {
    try {
        await pool.query('INSERT INTO messages (studentId, content) VALUES ($1, $2)', [req.body.studentId, req.body.message]);
        res.json({ message: 'Sent' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ✅ جلب أرشيف رسائل الطالب
app.get('/api/students/:id/messages', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages WHERE studentId = $1 ORDER BY createdAt DESC LIMIT 20', [req.params.id]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ✅ جلب الرسائل للأدمن (مع إصلاح الاسم)
app.get('/api/admin/messages', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.id, m.content, m.adminReply, m.createdAt, s.name as "studentName"
            FROM messages m
            JOIN students s ON m.studentId = s.id
            ORDER BY m.createdAt DESC
            LIMIT 100
        `);
        res.json(result.rows || []);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error fetching messages' }); }
});

// ✅ الرد على الرسالة
app.post('/api/admin/messages/:id/reply', async (req, res) => {
    try {
        await pool.query('UPDATE messages SET adminReply = $1 WHERE id = $2', [req.body.reply, req.params.id]);
        res.json({ message: 'Reply Saved' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/admin/messages/:id', async (req, res) => {
    try { await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]); res.json({ message: 'Deleted' }); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------------------------------
// 4. النتائج والإحصائيات
// ---------------------------------------------------------------------------------
app.post('/api/quiz-results', async (req, res) => {
    try {
        await pool.query('INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)', 
            [req.body.studentId, req.body.quizName, req.body.subjectId, req.body.score, req.body.totalQuestions, req.body.correctAnswers]);
        res.json({ message: 'Saved' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/students/:id/results', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [req.params.id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/students/:id/stats', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
        const rs = r.rows;
        if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0 });
        res.json({
            totalQuizzes: rs.length,
            averageScore: Math.round(rs.reduce((a, b) => a + b.score, 0) / rs.length),
            bestScore: Math.max(...rs.map(x => x.score))
        });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------------------------------
// 5. نظام القفل
// ---------------------------------------------------------------------------------
app.get('/api/quiz-status', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM quiz_status');
        const map = {}; r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message });
        res.json(map);
    } catch (e) { res.json({}); }
});

app.post('/api/admin/quiz-status/:subjectId', async (req, res) => {
    try {
        await pool.query(`INSERT INTO quiz_status (subjectId, locked, message, updatedAt) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (subjectId) DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP`, 
            [req.params.subjectId, req.body.locked, req.body.message]);
        res.json({ message: 'Updated' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------------------------------
// 6. لوحة التحكم
// ---------------------------------------------------------------------------------
app.get('/api/admin/students', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC'); res.json(r.rows); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const s = await pool.query('SELECT COUNT(*) as t FROM students');
        const q = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results');
        res.json({ totalStudents: parseInt(s.rows[0].t), totalQuizzes: parseInt(q.rows[0].t), averageScore: Math.round(q.rows[0].a || 0) });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/activity-logs', async (req, res) => {
    try { const r = await pool.query(`SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp FROM activity_logs act JOIN students s ON act.studentId = s.id ORDER BY act.timestamp DESC LIMIT 50`); res.json(r.rows); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/login-logs', async (req, res) => {
    try { const r = await pool.query(`SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime FROM login_logs ll JOIN students s ON ll.studentId = s.id ORDER BY ll.loginTime DESC LIMIT 50`); res.json(r.rows); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

// حظر
app.post('/api/admin/students/:id/status', async (req, res) => {
    try { await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [req.body.isblocked, req.params.id]); res.json({ message: 'Updated' }); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    try {
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]);
        if (!fp.rows.length) return res.status(404).json({ error: 'No fingerprint' });
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']);
        res.json({ message: 'Blocked' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/unblock-fingerprint', async (req, res) => {
    try {
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]);
        if (!fp.rows.length) return res.status(404).json({ error: 'No fingerprint' });
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]);
        res.json({ message: 'Unblocked' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    initializeDatabase();
});
