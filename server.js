/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 2.2.0 (Updated: Messaging System + Quiz Locks)
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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ---------------------------------------------------------------------------------
// 1. تهيئة قاعدة البيانات (Database Initialization)
// ---------------------------------------------------------------------------------

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] جاري تهيئة قاعدة البيانات...');

        // جدول الطلاب
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                isBlocked BOOLEAN DEFAULT FALSE
            )
        `);
        
        // جدول النتائج
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
        
        // التأكد من وجود عمود subjectId (للتحديثات القديمة)
        try { await client.query('ALTER TABLE quiz_results ADD COLUMN IF NOT EXISTS subjectId TEXT'); } catch (e) { }

        // جدول الرسائل (جديد ✅)
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                content TEXT NOT NULL,
                isRead BOOLEAN DEFAULT FALSE,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول سجل الدخول
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                logoutTime TIMESTAMPTZ
            )
        `);

        // جدول سجل النشاط
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                activityType TEXT NOT NULL,
                subjectName TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول البصمات
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                fingerprint TEXT NOT NULL,
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(studentId, fingerprint)
            )
        `);

        // جدول البصمات المحظورة
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY,
                fingerprint TEXT UNIQUE NOT NULL,
                reason TEXT,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول حالة الاختبارات (القفل)
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_status (
                id SERIAL PRIMARY KEY,
                subjectId TEXT UNIQUE NOT NULL,
                locked BOOLEAN DEFAULT FALSE,
                message TEXT,
                updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ [DB] تم الانتهاء من تهيئة جميع الجداول بنجاح.');

    } catch (err) {
        console.error('❌ [DB] خطأ في التهيئة:', err);
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------------
// 2. إدارة الطلاب والمصادقة (Auth & Students)
// ---------------------------------------------------------------------------------

app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ error: 'البيانات ناقصة (الاسم أو البريد)' });
    }

    if (fingerprint) {
        try {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور من التسجيل.' });
            }
        } catch (e) { console.error(e); }
    }

    try {
        const result = await pool.query(
            'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
            [name, email]
        );
        const newStudent = result.rows[0];
        
        if (fingerprint) {
            await pool.query(
                'INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                [newStudent.id, fingerprint]
            );
        }
        
        res.json({ 
            id: newStudent.id,
            name: newStudent.name,
            email: newStudent.email,
            createdat: newStudent.createdat,
            message: 'تم التسجيل بنجاح' 
        });

    } catch (err) {
        if (err.code === '23505') { 
            try {
                const existing = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
                const student = existing.rows[0];

                if (student.isblocked) {
                    return res.status(403).json({ error: 'هذا الحساب محظور من قبل الإدارة.' });
                }
                
                if (fingerprint) {
                    await pool.query(
                        `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
                         VALUES ($1, $2, CURRENT_TIMESTAMP) 
                         ON CONFLICT (studentId, fingerprint) 
                         DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`, 
                        [student.id, fingerprint]
                    );
                }

                return res.json({ 
                    id: student.id,
                    name: student.name,
                    email: student.email,
                    createdat: student.createdat,
                    message: 'حساب موجود' 
                });

            } catch (e) { return res.status(500).json({ error: 'خطأ في استرجاع البيانات' }); }
        }
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    if (!studentId) return res.status(400).json({ error: 'مطلوب ID الطالب' });

    try {
        if (fingerprint) {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) return res.status(403).json({ error: 'هذا الجهاز محظور.' });

            await pool.query(
                `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP) 
                 ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`,
                [studentId, fingerprint]
            );
        }
        
        const result = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
        res.json({ logId: result.rows[0].id, message: 'تم تسجيل الدخول' });

    } catch (err) { res.status(500).json({ error: 'خطأ أثناء تسجيل الدخول' }); }
});

app.get('/api/students/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'الطالب غير موجود' });
        res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: 'خطأ خادم' }); }
});

// ---------------------------------------------------------------------------------
// 3. إدارة الرسائل (Messaging System - NEW)
// ---------------------------------------------------------------------------------

// إرسال رسالة من الطالب
app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;
    if (!studentId || !message) return res.status(400).json({ error: 'البيانات ناقصة' });

    try {
        await pool.query(
            'INSERT INTO messages (studentId, content) VALUES ($1, $2)',
            [studentId, message]
        );
        console.log(`📩 رسالة جديدة من Student ${studentId}`);
        res.json({ message: 'تم إرسال الرسالة بنجاح' });
    } catch (e) {
        console.error('❌ خطأ في إرسال الرسالة:', e);
        res.status(500).json({ error: 'فشل الإرسال' });
    }
});

// جلب الرسائل للإدارة
app.get('/api/admin/messages', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.id, m.content, m.createdAt, s.name as studentName
            FROM messages m
            JOIN students s ON m.studentId = s.id
            ORDER BY m.createdAt DESC
            LIMIT 100
        `);
        res.json(result.rows || []);
    } catch (e) {
        console.error('❌ خطأ في جلب الرسائل:', e);
        res.status(500).json({ error: 'خطأ في جلب الرسائل' });
    }
});

// حذف رسالة
app.delete('/api/admin/messages/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
        res.json({ message: 'تم الحذف' });
    } catch (e) { res.status(500).json({ error: 'فشل الحذف' }); }
});

// ---------------------------------------------------------------------------------
// 4. إدارة الاختبارات والنتائج
// ---------------------------------------------------------------------------------

app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, subjectId, score, totalQuestions, correctAnswers } = req.body;
    
    if (!studentId || !quizName) return res.status(400).json({ error: 'بيانات ناقصة' });

    try {
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)',
            [studentId, quizName, subjectId || null, score || 0, totalQuestions || 0, correctAnswers || 0]
        );
        res.json({ message: 'تم حفظ النتيجة بنجاح' });
    } catch (e) { res.status(500).json({ error: 'فشل الحفظ' }); }
});

app.get('/api/students/:id/results', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [req.params.id]);
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/students/:id/stats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
        const rs = result.rows;
        
        if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0 });

        const totalQuizzes = rs.length;
        const averageScore = Math.round(rs.reduce((a, b) => a + b.score, 0) / totalQuizzes);
        const bestScore = Math.max(...rs.map(x => x.score));

        res.json({ totalQuizzes, averageScore, bestScore });
    } catch (e) { res.status(500).json({ error: 'خطأ في الحسابات' }); }
});

// ---------------------------------------------------------------------------------
// 5. نظام قفل الاختبارات
// ---------------------------------------------------------------------------------

app.get('/api/quiz-status', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_status');
        const statusMap = {};
        result.rows.forEach(row => {
            statusMap[row.subjectid] = { locked: row.locked, message: row.message };
        });
        res.json(statusMap);
    } catch (e) { res.json({}); }
});

app.post('/api/admin/quiz-status/:subjectId', async (req, res) => {
    const { subjectId } = req.params;
    const { locked, message } = req.body;

    try {
        await pool.query(
            `INSERT INTO quiz_status (subjectId, locked, message, updatedAt) 
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (subjectId) 
             DO UPDATE SET locked = $2, message = $3, updatedAt = CURRENT_TIMESTAMP`,
            [subjectId, locked, message || null]
        );
        res.json({ message: 'تم تحديث حالة الاختبار' });
    } catch (e) { res.status(500).json({ error: 'خطأ في التحديث' }); }
});

// ---------------------------------------------------------------------------------
// 6. لوحة تحكم الإدارة (Admin APIs)
// ---------------------------------------------------------------------------------

app.get('/api/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'خطأ في جلب الطلاب' }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const studentCount = await pool.query('SELECT COUNT(*) as t FROM students');
        const quizStats = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results');
        
        res.json({
            totalStudents: parseInt(studentCount.rows[0].t) || 0,
            totalQuizzes: parseInt(quizStats.rows[0].t) || 0,
            averageScore: Math.round(quizStats.rows[0].a || 0)
        });
    } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/login-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
            FROM login_logs ll JOIN students s ON ll.studentId = s.id 
            ORDER BY ll.loginTime DESC LIMIT 50
        `);
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp 
            FROM activity_logs act JOIN students s ON act.studentId = s.id 
            ORDER BY act.timestamp DESC LIMIT 50
        `);
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// حظر الحسابات والأجهزة
app.post('/api/admin/students/:id/status', async (req, res) => {
    const { id } = req.params;
    const { isblocked } = req.body;
    try {
        const result = await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2 RETURNING id', [isblocked, id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json({ message: 'تم تحديث الحالة' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    const { id } = req.params;
    try {
        const fpResult = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [id]);
        if (fpResult.rows.length === 0) return res.status(404).json({ error: 'لا توجد بصمة' });
        
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING', [fpResult.rows[0].fingerprint, 'Admin Block']);
        res.json({ message: 'تم حظر الجهاز' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/unblock-fingerprint', async (req, res) => {
    const { id } = req.params;
    try {
        const fpResult = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [id]);
        if (fpResult.rows.length === 0) return res.status(404).json({ error: 'لا توجد بصمة' });
        
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fpResult.rows[0].fingerprint]);
        res.json({ message: 'تم فك الحظر' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ---------------------------------------------------------------------------------
// 7. تشغيل السيرفر
// ---------------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running correctly ✅' });
});

app.listen(PORT, () => {
    console.log(`\n🚀 ═══════════════════════════════════════════════════`);
    console.log(`   Tawal Academy Backend Server v2.2.0`);
    console.log(`   🌐 Server running on port: ${PORT}`);
    console.log(`   ✅ Database & Messaging System: Ready`);
    console.log(`═══════════════════════════════════════════════════\n`);
    
    initializeDatabase().catch(console.error);
});
