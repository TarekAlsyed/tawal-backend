/*
 * =================================================================================
 * SERVER.JS - Version 23.0.0 (Email Authentication & Redis OTP)
 * =================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const compression = require('compression'); 
const hpp = require('hpp'); 
const xss = require('xss'); 
const { pool, initializeDatabase } = require('./database'); 
const { validateRequest, schemas } = require('./validation'); 
const redisClient = require('./cache'); 
const { sendOTP } = require('./email'); // 🔥 Email Service Module (NEW)

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

// 🔥 DATA SECURITY ACTIVATION 🔥
app.use(hpp());

app.use((req, res, next) => {
    if (req.body) {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                req.body[key] = xss(req.body[key]);
            }
        });
    }
    next();
});

// Rate Limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 1000, 
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const loginLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 20, 
    message: { error: 'Too many login attempts, please try again later.' }
});

// 🔥 OTP Limiter (Prevent Email Spam)
const otpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 Hour
    max: 5, // Allow max 5 OTP requests per hour per IP
    message: { error: 'Too many OTP requests, please wait an hour.' }
});

app.use('/api/', generalLimiter);
app.use('/api/admin/login', loginLimiter); 
app.use('/api/auth/send-otp', otpLimiter); // Apply limiter to OTP endpoint

// Initialize Database
initializeDatabase();

// Admin Authentication Middleware
function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        if (user.role !== 'admin' && user.role !== 'superadmin') return res.status(403).json({ error: 'Admin only' });
        req.user = user;
        next();
    });
}

// ================= API ENDPOINTS =================

// 🔥 REQUEST OTP (New Endpoint)
app.post('/api/auth/send-otp', validateRequest(schemas.otpRequest), async (req, res) => {
    const { email } = req.body;

    try {
        // 1. Check if student already exists (Optional - depends on logic)
        // For now, we allow OTP for everyone to support Registration & Login flows
        
        // 2. Generate Random 6-digit Code
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        // 3. Save to Redis (Expires in 10 minutes = 600 seconds)
        // Key format: "otp:user@email.com"
        await redisClient.setEx(`otp:${email}`, 600, otpCode);

        // 4. Send Email
        const sent = await sendOTP(email, otpCode);

        if (sent) {
            res.json({ message: 'OTP sent successfully', email });
        } else {
            res.status(500).json({ error: 'Failed to send email' });
        }
    } catch (e) {
        console.error('OTP Error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public Stats (Cached)
app.get('/api/public-stats', async (req, res) => {
    try {
        const cachedData = await redisClient.get('public_stats');
        if (cachedData) return res.json(JSON.parse(cachedData));

        const s = await pool.query('SELECT COUNT(*) as t FROM students');
        const q = await pool.query('SELECT COUNT(*) as t FROM quiz_results');
        
        const data = {
            totalStudents: parseInt(s.rows[0].t),
            totalQuizzes: parseInt(q.rows[0].t)
        };

        await redisClient.setEx('public_stats', 600, JSON.stringify(data));
        res.json(data);
    } catch (e) {
        console.error('Stats Error:', e);
        res.json({ totalStudents: 0, totalQuizzes: 0 });
    }
});

// Admin Login
app.post('/api/admin/login', validateRequest(schemas.adminLogin), async (req, res) => {
    const { username, password } = req.body;
    const userToFind = username || 'admin'; 

    try {
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [userToFind]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];
        const match = await bcrypt.compare(password, admin.password_hash);

        if (match) {
            const token = jwt.sign(
                { id: admin.id, role: admin.role, username: admin.username }, 
                process.env.JWT_SECRET, 
                { expiresIn: '24h' }
            );
            res.json({ token });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (e) {
        console.error('Admin Login Error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Fingerprint Verification
app.post('/api/verify-fingerprint', validateRequest(schemas.fingerprintCheck), async (req, res) => {
    const { fingerprint } = req.body;
    try {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ ok: false, message: 'Device Blocked' });
        res.json({ ok: true });
    } catch (e) { 
        res.status(500).json({ ok: false }); 
    }
});

// 🔥 Student Registration (NOW SECURED WITH OTP)
app.post('/api/students/register', validateRequest(schemas.studentRegister), async (req, res) => {
    const { name, email, fingerprint, otp } = req.body;

    // 1. Verify OTP from Redis
    try {
        const cachedOtp = await redisClient.get(`otp:${email}`);
        
        if (!cachedOtp) {
            return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
        }

        if (cachedOtp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP code.' });
        }

        // 2. OTP is valid! Delete it to prevent reuse
        await redisClient.del(`otp:${email}`);

        // 3. Proceed with Registration (Existing Logic)
        if (fingerprint) {
            const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blocked.rows.length > 0) return res.status(403).json({ error: 'Device Blocked' });
        }
        
        const result = await pool.query('INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
        const newStudent = result.rows[0];
        
        await redisClient.del('public_stats');

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
        console.error('Register Error:', err);
        res.status(500).json({ error: 'Error during registration' });
    }
});

// Messages
app.post('/api/messages', validateRequest(schemas.message), async (req, res) => {
    const { studentId, message } = req.body;
    
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

// Logout
app.post('/api/logout', async (req, res) => {
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json({ error: 'Missing studentId' });
    
    try {
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

// Activity Logger
app.post('/api/log-activity', validateRequest(schemas.activityLog), async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;

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

// Quiz Results
app.post('/api/quiz-results', validateRequest(schemas.quizResult), async (req, res) => {
    const { studentId, quizName, subjectId, score, totalQuestions, correctAnswers } = req.body;
    
    try { 
        await pool.query(`
            INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [studentId, quizName, subjectId || 'unknown', score, totalQuestions || 0, correctAnswers || 0]);
        
        await redisClient.del('public_stats');

        try {
            await pool.query(`
                INSERT INTO activity_logs (studentId, activityType, subjectName, score, timestamp) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [studentId, 'quiz_completed', quizName, score]);
        } catch (logErr) {
            console.error('⚠️ [Activity] Failed to save activity log:', logErr.message);
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

// Get Student Activity Logs
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
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Error fetching activity' });
    }
});

// Get Student Login Logs
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
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Error fetching logs' });
    }
});

// Quiz Status (Cached)
app.get('/api/quiz-status', async (req, res) => { 
    try {
        const cached = await redisClient.get('quiz_status');
        if (cached) return res.json(JSON.parse(cached));

        const r = await pool.query('SELECT * FROM quiz_status'); 
        const map = {}; 
        r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message }); 
        
        await redisClient.setEx('quiz_status', 60, JSON.stringify(map));
        res.json(map); 
    } catch (e) { 
        res.json({}); 
    } 
});

// ================= ADMIN ROUTES =================

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
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
});

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

app.post('/api/admin/students/:id/block-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        if (!fp.rows.length) return res.status(404).json({ error: 'No device found for this student' }); 
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']); 
        res.json({ message: 'Blocked' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

app.post('/api/admin/students/:id/unblock-fingerprint', authenticateAdmin, async (req, res) => { 
    try { 
        const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); 
        if (!fp.rows.length) return res.status(404).json({ error: 'No device found' }); 
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]); 
        res.json({ message: 'Unblocked' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

app.post('/api/admin/quiz-status/:subjectId', authenticateAdmin, async (req, res) => { 
    try { 
        await pool.query(`
            INSERT INTO quiz_status (subjectId, locked, message, updatedAt) 
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
            ON CONFLICT (subjectId) 
            DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP
        `, [req.params.subjectId, req.body.locked, req.body.message]); 
        
        await redisClient.del('quiz_status');

        res.json({ message: 'Updated' }); 
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    } 
});

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

app.delete('/api/admin/students/:id', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const studentId = req.params.id;
        await client.query('DELETE FROM student_fingerprints WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM quiz_results WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM messages WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM login_logs WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM activity_logs WHERE studentId = $1', [studentId]);
        await client.query('DELETE FROM active_sessions WHERE studentId = $1', [studentId]); 
        const result = await client.query('DELETE FROM students WHERE id = $1 RETURNING *', [studentId]);
        if (result.rowCount === 0) { 
            await client.query('ROLLBACK'); 
            return res.status(404).json({ error: 'Student not found' }); 
        }
        
        await redisClient.del('public_stats');

        await client.query('COMMIT');
        res.json({ message: 'Deleted' });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error' });
    } finally { 
        client.release(); 
    }
});

// Health Check
app.get('/api/health', (req, res) => res.json({ 
    status: 'OK', 
    version: '23.0.0', 
    security: 'FULL ARMORED (DB Split + HPP + XSS + Joi) ✅',
    performance: 'REDIS CACHING ENABLED 🚀',
    auth: 'EMAIL OTP ENABLED 🔐',
    timestamp: new Date().toISOString()
}));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Version 23.0.0 - Authentication System Online!`);
});
