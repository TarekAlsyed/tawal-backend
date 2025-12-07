/*
 * =================================================================================
 * SERVER.JS - Version 25.1.0 (UPDATED with Enhanced OTP & Register Logs)
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
const path = require('path'); 
const { pool, initializeDatabase } = require('./database'); 
const { validateRequest, schemas } = require('./validation'); 
const redisClient = require('./cache'); 
const { sendOTP } = require('./email'); 
const { upload, uploadToCloudinary } = require('./upload'); 

const app = express();

// إعداد الثقة في Proxy (ضروري لـ Railway)
app.set('trust proxy', 1); 

const PORT = process.env.PORT || 3001;

// ================= SECURITY & MIDDLEWARE =================

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" } 
}));
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

// Static Files
app.use('/static/images', express.static(path.join(__dirname, 'images')));
app.use('/static/pdf', express.static(path.join(__dirname, 'pdf')));

// Data Security
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

// ================= RATE LIMITING =================

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 1000, 
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: { error: 'Too many login attempts. Admin panel locked for 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
});

const otpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 10, 
    message: { error: 'Too many OTP requests, please wait an hour.' }
});

app.use('/api/', generalLimiter);
app.use('/api/admin/login', loginLimiter); 
app.use('/api/auth/send-otp', otpLimiter); 

initializeDatabase();

// ================= ADMIN AUTHENTICATION =================

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

// 1. Request OTP (Updated Logic)
app.post('/api/auth/send-otp', validateRequest(schemas.otpRequest), async (req, res) => {
    const { email } = req.body;

    try {
        // ضمان 6 أرقام دائماً (حتى لو بدأ بصفر)
        const otpCode = String(Math.floor(100000 + Math.random() * 900000));
        
        console.log(`🔐 [OTP] Generated for ${email}: ${otpCode}`);
        
        // حفظ OTP في Redis (10 دقائق = 600 ثانية)
        await redisClient.setEx(`otp:${email}`, 600, otpCode);
        console.log(`💾 [Redis] OTP saved for ${email} (expires in 10 min)`);
        
        // إرسال الكود عبر SendGrid
        const sent = await sendOTP(email, otpCode);

        if (sent) {
            res.json({ 
                message: 'OTP sent successfully', 
                email, 
                method: 'email' 
            });
        } else {
            // Fallback: في Dev Mode فقط، اعرض OTP في الرد
            if (process.env.NODE_ENV === 'development') {
                console.log(`⚠️ [DEV MODE] Email failed but OTP is: ${otpCode}`);
                res.json({ 
                    message: 'Dev Mode: Email failed, check console logs', 
                    email, 
                    method: 'console', 
                    otp: otpCode // للتطوير فقط
                });
            } else {
                // في Production: خطأ حقيقي
                res.status(500).json({ 
                    error: 'فشل إرسال رمز التحقق. يرجى المحاولة لاحقاً.' 
                });
            }
        }
    } catch (e) {
        console.error('❌ [OTP Error]:', e);
        res.status(500).json({ error: 'خطأ في السيرفر' });
    }
});

// 2. Student Registration (Updated Logic)
app.post('/api/students/register', validateRequest(schemas.studentRegister), async (req, res) => {
    const { name, email, fingerprint, otp } = req.body;

    try {
        // 1. جلب OTP المحفوظ من Redis
        const cachedOtp = await redisClient.get(`otp:${email}`);
        
        if (!cachedOtp) {
            console.warn(`⚠️ [OTP] Expired or not found for ${email}`);
            return res.status(400).json({ 
                error: 'رمز التحقق منتهي الصلاحية أو غير موجود. اطلب رمزاً جديداً.' 
            });
        }
        
        // 2. التحقق من صحة OTP
        if (cachedOtp !== otp) {
            console.warn(`⚠️ [OTP] Incorrect code for ${email}`);
            console.warn(`   Expected: ${cachedOtp}, Got: ${otp}`);
            return res.status(400).json({ 
                error: 'رمز التحقق خاطئ. تأكد من الأرقام وحاول مجدداً.' 
            });
        }

        console.log(`✅ [OTP] Verified successfully for ${email}`);
        
        // 3. حذف OTP بعد الاستخدام (One-Time Use)
        await redisClient.del(`otp:${email}`);

        // 4. فحص البصمة للحظر
        if (fingerprint) {
            const blocked = await pool.query(
                'SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', 
                [fingerprint]
            );
            if (blocked.rows.length > 0) {
                console.warn(`⚠️ [Security] Blocked fingerprint attempted: ${fingerprint}`);
                return res.status(403).json({ error: 'Device Blocked' });
            }
        }
        
        // 5. إنشاء حساب الطالب
        const result = await pool.query(
            'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', 
            [name, email]
        );
        const newStudent = result.rows[0];
        
        // 6. تحديث الكاش
        await redisClient.del('public_stats');

        // 7. حفظ البصمة
        if (fingerprint) {
            await pool.query(
                'INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)', 
                [newStudent.id, fingerprint]
            );
        }
        
        console.log(`✅ [Register] New student created: ${newStudent.name} (ID: ${newStudent.id})`);
        res.json(newStudent);
        
    } catch (err) {
        // معالجة خطأ الإيميل المكرر
        if (err.code === '23505') {
            console.log(`⚠️ [Register] Duplicate email: ${email}`);
            const existing = await pool.query(
                'SELECT * FROM students WHERE email = $1', 
                [email]
            );
            
            if (existing.rows[0].isblocked) {
                return res.status(403).json({ error: 'Account Blocked' });
            }
            
            // إرجاع الحساب الموجود
            return res.json(existing.rows[0]);
        }
        
        console.error('❌ [Register Error]:', err);
        res.status(500).json({ error: 'خطأ أثناء التسجيل' });
    }
});

// 3. Admin Login
app.post('/api/admin/login', validateRequest(schemas.adminLogin), async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Required fields missing' });

    try {
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const admin = result.rows[0];
        const match = await bcrypt.compare(password, admin.password_hash);

        if (match) {
            const token = jwt.sign({ id: admin.id, role: admin.role, username: admin.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
            res.json({ token });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. Public Stats
app.get('/api/public-stats', async (req, res) => {
    try {
        const cached = await redisClient.get('public_stats');
        if (cached) return res.json(JSON.parse(cached));
        const s = await pool.query('SELECT COUNT(*) as t FROM students');
        const q = await pool.query('SELECT COUNT(*) as t FROM quiz_results');
        const data = { totalStudents: parseInt(s.rows[0].t), totalQuizzes: parseInt(q.rows[0].t) };
        await redisClient.setEx('public_stats', 600, JSON.stringify(data));
        res.json(data);
    } catch (e) { res.json({ totalStudents: 0, totalQuizzes: 0 }); }
});

// 5. Student Login (Session Log)
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
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// 6. Logout
app.post('/api/logout', async (req, res) => {
    const { studentId } = req.body;
    try {
        await pool.query(`UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM login_logs WHERE studentId = $1 ORDER BY loginTime DESC LIMIT 1)`, [studentId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Logout failed' }); }
});

// 7. Activity Log
app.post('/api/log-activity', validateRequest(schemas.activityLog), async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    try {
        await pool.query(`INSERT INTO activity_logs (studentId, activityType, subjectName, timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`, [studentId, activityType, subjectName || '-']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// 8. Quiz Results
app.post('/api/quiz-results', validateRequest(schemas.quizResult), async (req, res) => {
    const { studentId, quizName, subjectId, score, totalQuestions, correctAnswers } = req.body;
    try { 
        await pool.query(`INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)`, [studentId, quizName, subjectId || 'unknown', score, totalQuestions || 0, correctAnswers || 0]);
        await redisClient.del('public_stats');
        try { await pool.query(`INSERT INTO activity_logs (studentId, activityType, subjectName, score, timestamp) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [studentId, 'quiz_completed', quizName, score]); } catch (e) {}
        res.json({ message: 'Saved successfully' }); 
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// 9. Student Data Getters
app.get('/api/students/:id', async (req, res) => { try { const r = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]); res.json(r.rows[0] || {}); } catch(e) { res.status(500).json({}); } });
app.get('/api/students/:id/results', async (req, res) => { try { const r = await pool.query('SELECT quizname as "quizName", score, subjectid as "subjectId", completedat as "completedAt" FROM quiz_results WHERE studentid = $1 ORDER BY completedat DESC', [req.params.id]); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/students/:id/stats', async (req, res) => { try { const r = await pool.query('SELECT score FROM quiz_results WHERE studentId = $1', [req.params.id]); const rs = r.rows; if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0 }); const avg = Math.round(rs.reduce((s, row) => s + row.score, 0) / rs.length); const best = Math.max(...rs.map(r => r.score)); res.json({ totalQuizzes: rs.length, averageScore: avg, bestScore: best }); } catch (e) { res.status(500).json({ error: 'Error' }); } });

// 10. Messaging System
app.get('/api/students/:id/messages', async (req, res) => { try { const r = await pool.query('SELECT * FROM messages WHERE studentId = $1 ORDER BY createdAt DESC', [req.params.id]); const now = new Date(); const todayCount = r.rows.filter(m => new Date(m.createdat) >= new Date(now.setHours(0,0,0,0))).length; res.json({ messages: r.rows, remaining: Math.max(0, 3 - todayCount) }); } catch(e) { res.status(500).json([]); } });
app.post('/api/messages', validateRequest(schemas.message), async (req, res) => { const { studentId, message } = req.body; try { const countQuery = await pool.query("SELECT COUNT(*) FROM messages WHERE studentId = $1 AND createdAt >= CURRENT_DATE", [studentId]); if (parseInt(countQuery.rows[0].count) >= 3) return res.status(429).json({ error: 'Limit reached', remaining: 0 }); await pool.query('INSERT INTO messages (studentId, content) VALUES ($1, $2)', [studentId, message]); res.json({ message: 'Sent', remaining: 3 - (parseInt(countQuery.rows[0].count) + 1) }); } catch (e) { res.status(500).json({ error: 'Error' }); } });

// 11. Quiz Status Check
app.get('/api/quiz-status', async (req, res) => { try { const cached = await redisClient.get('quiz_status'); if (cached) return res.json(JSON.parse(cached)); const r = await pool.query('SELECT * FROM quiz_status'); const map = {}; r.rows.forEach(row => map[row.subjectid] = { locked: row.locked, message: row.message }); await redisClient.setEx('quiz_status', 60, JSON.stringify(map)); res.json(map); } catch (e) { res.json({}); } });

// 12. File Upload (Admin Only)
app.post('/api/admin/upload', authenticateAdmin, upload.single('file'), async (req, res) => { if (!req.file) return res.status(400).json({ error: 'No file' }); try { const result = await uploadToCloudinary(req.file.buffer); res.json({ message: 'Uploaded', url: result.secure_url }); } catch (e) { res.status(500).json({ error: 'Upload failed' }); } });

// ================= ADMIN MANAGEMENT =================

app.get('/api/admin/stats', authenticateAdmin, async (req, res) => { try { const s = await pool.query('SELECT COUNT(*) as t FROM students'); const q = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results'); res.json({ totalStudents: parseInt(s.rows[0].t), totalQuizzes: parseInt(q.rows[0].t), averageScore: Math.round(q.rows[0].a || 0) }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/admin/students', authenticateAdmin, async (req, res) => { try { const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC'); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/admin/students/:id/status', authenticateAdmin, async (req, res) => { try { await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [req.body.isblocked, req.params.id]); res.json({ message: 'Updated' }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/admin/students/:id/block-fingerprint', authenticateAdmin, async (req, res) => { try { const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); if (!fp.rows.length) return res.status(404).json({ error: 'No device' }); await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fp.rows[0].fingerprint, 'Admin Block']); res.json({ message: 'Blocked' }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/admin/students/:id/unblock-fingerprint', authenticateAdmin, async (req, res) => { try { const fp = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [req.params.id]); if (!fp.rows.length) return res.status(404).json({ error: 'No device' }); await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fp.rows[0].fingerprint]); res.json({ message: 'Unblocked' }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/admin/quiz-status/:subjectId', authenticateAdmin, async (req, res) => { try { await pool.query(`INSERT INTO quiz_status (subjectId, locked, message, updatedAt) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT (subjectId) DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP`, [req.params.subjectId, req.body.locked, req.body.message]); await redisClient.del('quiz_status'); res.json({ message: 'Updated' }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/admin/messages', authenticateAdmin, async (req, res) => { try { const r = await pool.query('SELECT m.id, m.content, m.adminReply, m.createdAt, s.name as "studentName" FROM messages m JOIN students s ON m.studentId = s.id ORDER BY m.createdAt DESC LIMIT 100'); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/admin/messages/:id/reply', authenticateAdmin, async (req, res) => { try { await pool.query('UPDATE messages SET adminReply = $1 WHERE id = $2', [req.body.reply, req.params.id]); res.json({ message: 'Replied' }); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.delete('/api/admin/students/:id', authenticateAdmin, async (req, res) => { const client = await pool.connect(); try { await client.query('BEGIN'); const studentId = req.params.id; await client.query('DELETE FROM student_fingerprints WHERE studentId = $1', [studentId]); await client.query('DELETE FROM quiz_results WHERE studentId = $1', [studentId]); await client.query('DELETE FROM messages WHERE studentId = $1', [studentId]); await client.query('DELETE FROM login_logs WHERE studentId = $1', [studentId]); await client.query('DELETE FROM activity_logs WHERE studentId = $1', [studentId]); await client.query('DELETE FROM active_sessions WHERE studentId = $1', [studentId]); const result = await client.query('DELETE FROM students WHERE id = $1 RETURNING *', [studentId]); if (result.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student not found' }); } await redisClient.del('public_stats'); await client.query('COMMIT'); res.json({ message: 'Deleted' }); } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Error' }); } finally { client.release(); } });

// ================= HEALTH & START =================

app.get('/api/health', (req, res) => res.json({ status: 'OK', version: '25.1.0', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Version 25.1.0 - SendGrid Logic Updated`);
});
