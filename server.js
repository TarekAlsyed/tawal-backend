/*
 * =================================================================================
 * SERVER.JS - Version 10.0.0 (GOLDEN EDITION: Final Fixes & Clean Dates)
 * =================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// إعداد التطبيق
const app = express();
const PORT = process.env.PORT || 3001;

// 1. إعدادات الأمان (Security Headers)
app.use(helmet());

// 2. إعدادات CORS (السماح بالوصول من النطاقات المحددة)
const allowedOrigins = [
    'https://tarekalsyed.github.io', 
    'http://localhost:3000', 
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        // السماح بالطلبات التي ليس لها مصدر (مثل تطبيقات الموبايل أو Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            // السماح مؤقتاً للجميع لتجنب مشاكل الحظر أثناء التطوير
            callback(null, true);
        }
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 3. معالجة البيانات (Body Parser)
app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// 4. الاتصال بقاعدة البيانات (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 5. نظام الحد من الطلبات (Rate Limiting) - موسع لـ 2000 طلب
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 2000, // 2000 طلب لكل IP
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', generalLimiter);

// =================================================================
// دالة تهيئة قاعدة البيانات (إنشاء الجداول)
// =================================================================
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Checking tables & connection...');
        
        // جداول الطلاب والنتائج
        await client.query(`CREATE TABLE IF NOT EXISTS students (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, isBlocked BOOLEAN DEFAULT FALSE)`);
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_results (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), quizName TEXT NOT NULL, subjectId TEXT, score INTEGER NOT NULL, totalQuestions INTEGER NOT NULL, correctAnswers INTEGER NOT NULL, completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جدول الرسائل
        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), content TEXT NOT NULL, adminReply TEXT, isRead BOOLEAN DEFAULT FALSE, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جداول السجلات
        await client.query(`CREATE TABLE IF NOT EXISTS login_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, logoutTime TIMESTAMPTZ)`);
        await client.query(`CREATE TABLE IF NOT EXISTS activity_logs (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), activityType TEXT NOT NULL, subjectName TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        
        // جداول الحماية والبصمة
        await client.query(`CREATE TABLE IF NOT EXISTS student_fingerprints (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), fingerprint TEXT NOT NULL, lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, UNIQUE(studentId, fingerprint))`);
        await client.query(`CREATE TABLE IF NOT EXISTS blocked_fingerprints (id SERIAL PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, reason TEXT, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS quiz_status (id SERIAL PRIMARY KEY, subjectId TEXT UNIQUE NOT NULL, locked BOOLEAN DEFAULT FALSE, message TEXT, updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);

        console.log('✅ [DB] Database Ready & Secured.');
    } catch (err) { 
        console.error('❌ [DB] Error:', err); 
    } finally { 
        client.release(); 
    }
}

// =================================================================
// Middleware: التحقق من صلاحيات الأدمن (JWT)
// =================================================================
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

// =================================================================
// API Endpoints
// =================================================================

// 1. تسجيل دخول الأدمن
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminHash) return res.status(500).json({ error: 'Server Config Error: Hash missing' });

    const isMatch = await bcrypt.compare(password, adminHash);
    if (isMatch) {
        // صلاحية التوكن 24 ساعة
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, message: 'Login successful' });
    } else {
        res.status(401).json({ error: 'Incorrect password' });
    }
});

// 2. التحقق من البصمة (Fingerprint Check)
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
            return res.json(existing.rows[0]);
        }
        res.status(500).json({ error: 'Server Error' });
    }
});

// 4. نظام الرسائل (مع إصلاح العد والحذف)
app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;
    if (!studentId || !message) return res.status(400).json({ error: 'Missing data' });

    try {
        // حساب عدد الرسائل لهذا الطالب "اليوم"
        const countQuery = await pool.query(
            "SELECT COUNT(*) FROM messages WHERE studentId = $1 AND createdAt >= CURRENT_DATE",
            [studentId]
        );
        const count = parseInt(countQuery.rows[0].count);
        
        if (count >= 3) {
            return res.status(429).json({ 
                error: 'عفواً، لقد استنفذت رصيد الرسائل اليومي (3 رسائل).',
                remaining: 0
            });
        }

        await pool.query('INSERT INTO messages (studentId, content) VALUES ($1, $2)', [studentId, message]);
        
        res.json({ 
            message: 'Sent', 
            remaining: 2 - count
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error sending message' });
    }
});

app.get('/api/students/:id/messages', async (req, res) => {
    try { 
        const r = await pool.query('SELECT * FROM messages WHERE studentId = $1 ORDER BY createdAt DESC', [req.params.id]); 
        
        // حساب المتبقي من رسائل اليوم (للتأكد من تطابق الواجهة)
        const now = new Date();
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
        const todayCount = r.rows.filter(m => new Date(m.createdat) >= new Date(startOfDay)).length;

        res.json({
            messages: r.rows,
            remaining: Math.max(0, 3 - todayCount)
        });
    } catch(e) { res.status(500).json([]); }
});

// 5. تسجيل الدخول (تسجيل Logs)
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    try {
        if (fingerprint) {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
            await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen=CURRENT_TIMESTAMP`, [studentId, fingerprint]);
        }
        await pool.query('INSERT INTO login_logs (studentId) VALUES ($1)', [studentId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Login Error' }); }
});

// 6. حفظ نتائج الاختبارات (النقاط + النسبة)
app.post('/api/quiz-results', async (req, res) => {
    try { 
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)', 
            [req.body.studentId, req.body.quizName, req.body.subjectId, req.body.score, req.body.totalQuestions, req.body.correctAnswers]
        ); 
        res.json({ message: 'Saved' }); 
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Error' }); 
    }
});

// 7. جلب بيانات الطالب ونتائجه
app.get('/api/students/:id', async (req, res) => { 
    try { 
        const r = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]); 
        res.json(r.rows[0] || {}); 
    } catch(e) { res.status(500).json({}); } 
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

// 8. حالة الاختبارات (Public)
app.get('/api/quiz-status', async (req, res) => { 
    try { 
        const r = await pool.query('SELECT * FROM quiz_status'); 
        const map = {}; 
        r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message }); 
        res.json(map); 
    } catch (e) { res.json({}); } 
});

// =================================================================
// وظائف الأدمن (محمية بـ authenticateAdmin)
// =================================================================

// إدارة الرسائل
app.get('/api/admin/messages', authenticateAdmin, async (req, res) => {
    try { 
        const r = await pool.query(`SELECT m.id, m.content, m.adminReply, m.createdAt, s.name as "studentName" FROM messages m JOIN students s ON m.studentId = s.id ORDER BY m.createdAt DESC LIMIT 100`); 
        res.json(r.rows); 
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/messages/:id/reply', authenticateAdmin, async (req, res) => {
    try { await pool.query('UPDATE messages SET adminReply = $1 WHERE id = $2', [req.body.reply, req.params.id]); res.json({ message: 'Replied' }); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/admin/messages/:id', authenticateAdmin, async (req, res) => {
    try { await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]); res.json({ message: 'Deleted' }); } 
    catch (e) { res.status(500).json({ error: 'Error' }); }
});

// إحصائيات عامة
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => { 
    try { 
        const s = await pool.query('SELECT COUNT(*) as t FROM students'); 
        const q = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results'); 
        res.json({ 
            totalStudents: parseInt(s.rows[0].t), 
            totalQuizzes: parseInt(q.rows[0].t), 
            averageScore: Math.round(q.rows[0].a || 0) 
        }); 
    } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

// إدارة الطلاب والحظر
app.get('/api/admin/students', authenticateAdmin, async (req, res) => { 
    try { const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC'); res.json(r.rows); } 
    catch (e) { res.status(500).json({ error: 'Error' }); } 
});

app.post('/api/admin/students/:id/status', authenticateAdmin, async (req, res) => { 
    try { await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [req.body.isblocked, req.params.id]); res.json({ message: 'Updated' }); } 
    catch (e) { res.status(500).json({ error: 'Error' }); } 
});

app.post('/api/admin/students/:id/block-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        if (!fp.rows.length) return res.status(404).json({ error: 'No device' }); 
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']); 
        res.json({ message: 'Blocked' }); 
    } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

app.post('/api/admin/students/:id/unblock-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        if (!fp.rows.length) return res.status(404).json({ error: 'No device' }); 
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]); 
        res.json({ message: 'Unblocked' }); 
    } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

// التحكم في الأقفال
app.post('/api/admin/quiz-status/:subjectId', authenticateAdmin, async (req, res) => { 
    try { 
        await pool.query(`INSERT INTO quiz_status (subjectId, locked, message, updatedAt) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (subjectId) DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP`, [req.params.subjectId, req.body.locked, req.body.message]); 
        res.json({ message: 'Updated' }); 
    } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

// سجلات الدخول
app.get('/api/admin/login-logs', authenticateAdmin, async (req, res) => { 
    try { 
        const r = await pool.query(`SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime FROM login_logs ll JOIN students s ON ll.studentId = s.id ORDER BY ll.loginTime DESC LIMIT 50`); 
        res.json(r.rows); 
    } catch (e) { res.status(500).json({ error: 'Error' }); } 
});

// فحص الصحة (Health Check)
app.get('/api/health', (req, res) => res.json({ status: 'OK', version: '10.0.0' }));

// بدء تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    initializeDatabase();
});
