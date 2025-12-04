/*
 * =================================================================================
 * SERVER.JS - Version 20.0.0 (Added Public Stats Endpoint for Real Data)
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
const compression = require('compression'); 

const app = express();
const PORT = process.env.PORT || 3001;

// Security & Middleware
app.use(helmet());
app.use(compression());

app.use(cors({
    origin: [
        'https://tarekalsyed.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '50kb' })); 
app.use(bodyParser.urlencoded({ extended: true }));

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Rate Limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 3000, 
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', generalLimiter);

// Database Initialization
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Checking tables & connection...');
        
        // Students table
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY, 
                name TEXT NOT NULL, 
                email TEXT UNIQUE, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                isBlocked BOOLEAN DEFAULT FALSE
            )
        `);
        
        // Quiz results table
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_results (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id), 
                quizName TEXT NOT NULL, 
                subjectId TEXT, 
                score INTEGER NOT NULL, 
                totalQuestions INTEGER NOT NULL, 
                correctAnswers INTEGER NOT NULL, 
                completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Messages table
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id), 
                content TEXT NOT NULL, 
                adminReply TEXT, 
                isRead BOOLEAN DEFAULT FALSE, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Login logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id), 
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                logoutTime TIMESTAMPTZ
            )
        `);
        
        // 🔥 Activity logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id), 
                activityType TEXT NOT NULL, 
                subjectName TEXT, 
                score INTEGER,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Student fingerprints table
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id), 
                fingerprint TEXT NOT NULL, 
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                UNIQUE(studentId, fingerprint)
            )
        `);
        
        // Blocked fingerprints table
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY, 
                fingerprint TEXT UNIQUE NOT NULL, 
                reason TEXT, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Quiz status table
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_status (
                id SERIAL PRIMARY KEY, 
                subjectId TEXT UNIQUE NOT NULL, 
                locked BOOLEAN DEFAULT FALSE, 
                message TEXT, 
                updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ [DB] Database Ready & Secured.');
    } catch (err) { 
        console.error('❌ [DB] Critical Error:', err); 
    } finally { 
        client.release(); 
    }
}

// Admin Authentication Middleware
function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        req.user = user;
        next();
    });
}

// ================= API ENDPOINTS =================

// 🔥🔥🔥 NEW ENDPOINT: Public Stats (For Homepage) 🔥🔥🔥
// هذا هو الكود الجديد الذي يسمح للصفحة الرئيسية بجلب الأرقام الحقيقية
app.get('/api/public-stats', async (req, res) => {
    try {
        const s = await pool.query('SELECT COUNT(*) as t FROM students');
        const q = await pool.query('SELECT COUNT(*) as t FROM quiz_results');
        
        res.json({
            totalStudents: parseInt(s.rows[0].t),
            totalQuizzes: parseInt(q.rows[0].t)
        });
    } catch (e) {
        // في حالة الخطأ نعيد أصفار
        console.error('Stats Error:', e);
        res.json({ totalStudents: 0, totalQuizzes: 0 });
    }
});
// 🔥🔥🔥 END NEW ENDPOINT 🔥🔥🔥

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    if (!adminHash) return res.status(500).json({ error: 'Config Error' });
    if (await bcrypt.compare(password, adminHash)) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Wrong password' });
    }
});

// Fingerprint Verification
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

// Student Registration
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing data' });
    
    if (fingerprint) {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
    }
    
    try {
        const result = await pool.query('INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
        const newStudent = result.rows[0];
        
        if (fingerprint) {
            await pool.query('INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)', [newStudent.id, fingerprint]);
        }
        
        res.json(newStudent);
    } catch (err) {
        if (err.code === '23505') {
            const existing = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
            if (existing.rows[0].isblocked) return res.status(403).json({ error: 'Account Blocked' });
            return res.json(existing.rows[0]);
        }
        res.status(500).json({ error: 'Error' });
    }
});

// Messages
app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;
    if (!studentId || !message) return res.status(400).json({ error: 'Missing data' });
    
    try {
        const countQuery = await pool.query(
            "SELECT COUNT(*) FROM messages WHERE studentId = $1 AND createdAt >= CURRENT_DATE", 
            [studentId]
        );
        
        if (parseInt(countQuery.rows[0].count) >= 3) {
            return res.status(429).json({ error: 'Limit reached', remaining: 0 });
        }
        
        await pool.query('INSERT INTO messages (studentId, content) VALUES ($1, $2)', [studentId, message]);
        
        res.json({ 
            message: 'Sent', 
            remaining: 3 - (parseInt(countQuery.rows[0].count) + 1) 
        });
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

app.get('/api/students/:id/messages', async (req, res) => {
    try { 
        const r = await pool.query('SELECT * FROM messages WHERE studentId = $1 ORDER BY createdAt DESC', [req.params.id]); 
        const now = new Date();
        const todayCount = r.rows.filter(m => new Date(m.createdat) >= new Date(now.setHours(0,0,0,0))).length;
        res.json({ messages: r.rows, remaining: Math.max(0, 3 - todayCount) });
    } catch(e) { 
        res.status(500).json([]); 
    }
});

// Login Tracking
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    
    try {
        if (fingerprint) {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
            
            await pool.query(`
                INSERT INTO student_fingerprints (studentId, fingerprint) 
                VALUES ($1, $2) 
                ON CONFLICT (studentId, fingerprint) 
                DO UPDATE SET lastSeen=CURRENT_TIMESTAMP
            `, [studentId, fingerprint]);
        }
        
        await pool.query('INSERT INTO login_logs (studentId) VALUES ($1)', [studentId]);
        
        res.json({ success: true });
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

// 🔥🔥🔥 نقطة اتصال تسجيل الخروج الجديدة 🔥🔥🔥
app.post('/api/logout', async (req, res) => {
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json({ error: 'Missing studentId' });
    
    try {
        // تحديث آخر سجل دخول لم يتم تسجيل خروجه بعد
        await pool.query(`
            UPDATE login_logs 
            SET logoutTime = CURRENT_TIMESTAMP 
            WHERE id = (
                SELECT id FROM login_logs 
                WHERE studentId = $1 
                ORDER BY loginTime DESC 
                LIMIT 1
            )
        `, [studentId]);
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (e) {
        console.error('Logout Error:', e);
        res.status(500).json({ error: 'Logout failed' });
    }
});

// Endpoint new activity logger
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    if (!studentId || !activityType) return res.status(400).json({ error: 'Missing data' });

    try {
        await pool.query(`
            INSERT INTO activity_logs (studentId, activityType, subjectName, timestamp) 
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, [studentId, activityType, subjectName || '-']);
        console.log(`📡 [Activity] Logged: ${activityType} for Student ${studentId}`);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ [Activity Error]', e);
        res.status(500).json({ error: 'Failed' });
    }
});

// Quiz Results (حفظ النتيجة + تسجيل النشاط)
app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, subjectId, score, totalQuestions, correctAnswers } = req.body;
    
    console.log('📝 [Quiz Result] Received:', { studentId, quizName, subjectId, score });
    
    if (!studentId || !quizName || score === undefined) {
        console.error('❌ [Quiz Result] Missing required fields');
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try { 
        // 1. حفظ النتيجة
        await pool.query(`
            INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [studentId, quizName, subjectId || 'unknown', score, totalQuestions || 0, correctAnswers || 0]);
        
        console.log('✅ [Quiz Result] Saved to quiz_results table');
        
        // 2. 🔥 تسجيل النشاط (مع التأكد من وجود الجدول والأعمدة)
        try {
            await pool.query(`
                INSERT INTO activity_logs (studentId, activityType, subjectName, score, timestamp) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [studentId, 'quiz_completed', quizName, score]);
            
            console.log('✅ [Activity] Saved to activity_logs table');
        } catch (logErr) {
            console.error('⚠️ [Activity] Failed to save activity log:', logErr.message);
            // لا نفشل الطلب الأساسي
        }
        
        res.json({ message: 'Saved successfully' }); 
    } catch (e) { 
        console.error('❌ [Quiz Result] Database error:', e.message);
        res.status(500).json({ error: 'Failed to save result' }); 
    }
});

// Get Student Info
app.get('/api/students/:id', async (req, res) => { 
    try { 
        const r = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]); 
        res.json(r.rows[0] || {}); 
    } catch(e) { 
        res.status(500).json({}); 
    } 
});

// Get Student Quiz Results
app.get('/api/students/:id/results', async (req, res) => { 
    try { 
        const query = `
            SELECT 
                quizname as "quizName", 
                score, 
                subjectid as "subjectId",
                completedat as "completedAt"
            FROM quiz_results 
            WHERE studentid = $1 
            ORDER BY completedat DESC
        `;
        const r = await pool.query(query, [req.params.id]); 
        res.json(r.rows); 
    } catch (e) { 
        res.status(500).json({ error: 'Error fetching results' }); 
    } 
});

// Get Student Statistics
app.get('/api/students/:id/stats', async (req, res) => { 
    try { 
        const r = await pool.query('SELECT score FROM quiz_results WHERE studentId = $1', [req.params.id]); 
        const rs = r.rows; 
        
        if (!rs.length) {
            return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0 }); 
        }
        
        const avg = Math.round(rs.reduce((sum, row) => sum + row.score, 0) / rs.length);
        const best = Math.max(...rs.map(r => r.score));
        
        res.json({ 
            totalQuizzes: rs.length, 
            averageScore: avg, 
            bestScore: best 
        }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// 🔥 Get Student Activity Logs
app.get('/api/students/:id/activity', async (req, res) => {
    try {
        const query = `
            SELECT 
                activityType as "activityType",
                subjectName as "subjectName",
                score,
                timestamp
            FROM activity_logs
            WHERE studentId = $1
            ORDER BY timestamp DESC
            LIMIT 50
        `;
        
        const result = await pool.query(query, [req.params.id]);
        
        console.log(`✅ [Activity] Fetched ${result.rows.length} activities for student ${req.params.id}`);
        
        res.json(result.rows);
    } catch (e) {
        console.error('❌ [Activity] Error:', e);
        res.status(500).json({ error: 'Error fetching activity' });
    }
});

// 🔥 Get Student Login Logs
app.get('/api/students/:id/logs', async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                logintime as "loginTime",
                logouttime as "logoutTime"
            FROM login_logs
            WHERE studentid = $1
            ORDER BY logintime DESC
            LIMIT 50
        `;
        
        const result = await pool.query(query, [req.params.id]);
        
        console.log(`✅ [Logs] Fetched ${result.rows.length} logs for student ${req.params.id}`);
        
        res.json(result.rows);
    } catch (e) {
        console.error('❌ [Logs] Error:', e);
        res.status(500).json({ error: 'Error fetching logs' });
    }
});

// Quiz Status
app.get('/api/quiz-status', async (req, res) => { 
    try { 
        const r = await pool.query('SELECT * FROM quiz_status'); 
        const map = {}; 
        r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message }); 
        res.json(map); 
    } catch (e) { 
        res.json({}); 
    } 
});

// ================= ADMIN ROUTES =================

// 🔥 Get Recent Activity (All Students)
app.get('/api/admin/activity-logs', authenticateAdmin, async (req, res) => {
    try {
        const query = `
            SELECT 
                s.name as "studentName",
                al.activityType,
                al.subjectName,
                al.score,
                al.timestamp as "date"
            FROM activity_logs al
            JOIN students s ON al.studentId = s.id
            ORDER BY al.timestamp DESC
            LIMIT 20
        `;
        
        const result = await pool.query(query);
        
        console.log(`✅ [Admin Activity] Fetched ${result.rows.length} recent activities`);
        
        res.json(result.rows);
    } catch (e) {
        console.error('❌ [Admin Activity] Error:', e);
        res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
});

// Messages Management
app.get('/api/admin/messages', authenticateAdmin, async (req, res) => {
    try { 
        const r = await pool.query(`
            SELECT m.id, m.content, m.adminReply, m.createdAt, s.name as "studentName" 
            FROM messages m 
            JOIN students s ON m.studentId = s.id 
            ORDER BY m.createdAt DESC 
            LIMIT 100
        `); 
        res.json(r.rows); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

app.post('/api/admin/messages/:id/reply', authenticateAdmin, async (req, res) => {
    try { 
        await pool.query('UPDATE messages SET adminReply = $1 WHERE id = $2', [req.body.reply, req.params.id]); 
        res.json({ message: 'Replied' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

app.delete('/api/admin/messages/:id', authenticateAdmin, async (req, res) => {
    try { 
        await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]); 
        res.json({ message: 'Deleted' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});

// Statistics
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => { 
    try { 
        const s = await pool.query('SELECT COUNT(*) as t FROM students'); 
        const q = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results'); 
        
        res.json({ 
            totalStudents: parseInt(s.rows[0].t), 
            totalQuizzes: parseInt(q.rows[0].t), 
            averageScore: Math.round(q.rows[0].a || 0) 
        }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// Students Management
app.get('/api/admin/students', authenticateAdmin, async (req, res) => { 
    try { 
        const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC'); 
        res.json(r.rows); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

app.post('/api/admin/students/:id/status', authenticateAdmin, async (req, res) => { 
    try { 
        await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [req.body.isblocked, req.params.id]); 
        res.json({ message: 'Updated' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// Fingerprint Management
app.post('/api/admin/students/:id/block-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        
        if (!fp.rows.length) {
            return res.status(404).json({ error: 'No device found for this student' }); 
        }
        
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']); 
        
        res.json({ message: 'Blocked' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

app.post('/api/admin/students/:id/unblock-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        
        if (!fp.rows.length) {
            return res.status(404).json({ error: 'No device found' }); 
        }
        
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]); 
        
        res.json({ message: 'Unblocked' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// Quiz Lock Management
app.post('/api/admin/quiz-status/:subjectId', authenticateAdmin, async (req, res) => { 
    try { 
        await pool.query(`
            INSERT INTO quiz_status (subjectId, locked, message, updatedAt) 
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
            ON CONFLICT (subjectId) 
            DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP
        `, [req.params.subjectId, req.body.locked, req.body.message]); 
        
        res.json({ message: 'Updated' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// Login Logs
app.get('/api/admin/login-logs', authenticateAdmin, async (req, res) => { 
    try { 
        const r = await pool.query(`
            SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
            FROM login_logs ll 
            JOIN students s ON ll.studentId = s.id 
            ORDER BY ll.loginTime DESC 
            LIMIT 50
        `); 
        res.json(r.rows); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

// Delete Student (Complete Removal)
app.delete('/api/admin/students/:id', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const studentId = req.params.id;
        
        // Delete all related data
        await client.query('DELETE FROM student_fingerprints WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM quiz_results WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM messages WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM login_logs WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM activity_logs WHERE studentId = $1', [studentId]);
        
        // Delete student
        const result = await client.query('DELETE FROM students WHERE id = $1 RETURNING *', [studentId]);
        
        if (result.rowCount === 0) { 
            await client.query('ROLLBACK'); 
            return res.status(404).json({ error: 'Student not found' }); 
        }
        
        await client.query('COMMIT');
        res.json({ message: 'Deleted' });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ error: 'Error' });
    } finally { 
        client.release(); 
    }
});

// Health Check
app.get('/api/health', (req, res) => res.json({ 
    status: 'OK', 
    version: '20.0.0', 
    compression: true,
    activityTracking: 'FULLY FIXED ✅',
    publicStats: 'ENABLED ✅',
    logoutFeature: 'ENABLED ✅',
    timestamp: new Date().toISOString()
}));

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Version 20.0.0 - Activity tracking & Public Stats fully functional!`);
    initializeDatabase();
});
