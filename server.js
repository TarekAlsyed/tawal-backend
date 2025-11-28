/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 2.2.0 (Final Comprehensive Build - Fully Compatible)
 * =================================================================================
 * هذا الملف هو "العقل المدبر" للمنصة (Backend Server).
 * يحتوي على كافة العمليات المنطقية وقواعد البيانات والحماية.
 *
 * التحديثات:
 * - توافق كامل مع نظام قفل الاختبارات (Quiz Locks) في لوحة التحكم.
 * - إصلاح جداول قاعدة البيانات لتطابق أسماء المتغيرات في الواجهة.
 * =================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');

// إصلاح مشكلة التواريخ في PostgreSQL
types.setTypeParser(1114, (stringValue) => stringValue);
types.setTypeParser(1184, (stringValue) => stringValue);

const app = express();
const PORT = process.env.PORT || 3001;

// إعدادات CORS
const corsOptions = {
    origin: ['https://tarekalsyed.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'],
    optionsSuccessStatus: 200,
    credentials: true
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// الاتصال بقاعدة البيانات
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ---------------------------------------------------------------------------------
// تهيئة الجداول (Database Initialization)
// ---------------------------------------------------------------------------------
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] جاري تهيئة قاعدة البيانات والجداول...');

        // 1. جدول الطلاب
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                isBlocked BOOLEAN DEFAULT FALSE
            )
        `);
        
        // 2. جدول النتائج
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

        // 3. جدول سجلات الدخول
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                logoutTime TIMESTAMPTZ
            )
        `);

        // 4. جدول الأنشطة
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                activityType TEXT NOT NULL,
                subjectName TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. جدول البصمات
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                fingerprint TEXT NOT NULL,
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(studentId, fingerprint)
            )
        `);

        // 6. جدول البصمات المحظورة
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY,
                fingerprint TEXT UNIQUE NOT NULL,
                reason TEXT,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 7. جدول قفل الاختبارات (المعدل ليتوافق مع لوحة التحكم)
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_locks (
                subject_key TEXT PRIMARY KEY,
                is_locked BOOLEAN DEFAULT FALSE,
                message TEXT,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ [DB] تم الانتهاء من تهيئة جميع الجداول بنجاح.');

    } catch (err) {
        console.error('❌ [DB] خطأ في التهيئة:', err);
    } finally {
        client.release();
    }
}


// =================================================================================
// API Endpoints
// =================================================================================

/* -------------------------------------------------------------------------- */
/* 1. المصادقة والتسجيل                                                       */
/* -------------------------------------------------------------------------- */

app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    // التحقق من الحظر
    if (fingerprint) {
        try {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور من التسجيل.' });
            }
        } catch (e) { console.error("Fingerprint Check Error", e); }
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
        
        res.json({ ...newStudent, message: 'تم التسجيل بنجاح' });

    } catch (err) {
        if (err.code === '23505') { 
            // الإيميل مكرر - محاولة الاسترجاع
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

                return res.json({ ...student, message: 'حساب موجود (تم استرجاع البيانات)' });

            } catch (e) { 
                return res.status(500).json({ error: 'خطأ في استرجاع البيانات' }); 
            }
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
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور.' });
            }

            await pool.query(
                `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP) 
                 ON CONFLICT (studentId, fingerprint) 
                 DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`,
                [studentId, fingerprint]
            );
        }
        
        const result = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
        res.json({ logId: result.rows[0].id, message: 'تم تسجيل الدخول' });

    } catch (err) {
        res.status(500).json({ error: 'خطأ أثناء تسجيل الدخول' });
    }
});

app.post('/api/logout', async (req, res) => {
    const { logId } = req.body;
    if (!logId) return res.status(400).json({ error: 'Log ID required' });
    try {
        await pool.query('UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1', [logId]);
        res.json({ message: 'تم تسجيل الخروج' });
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});


/* -------------------------------------------------------------------------- */
/* 2. بيانات الطلاب والنتائج                                                  */
/* -------------------------------------------------------------------------- */

app.get('/api/students/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'الطالب غير موجود' });
        res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: 'خطأ خادم' }); }
});

app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, subjectId, score, totalQuestions, correctAnswers } = req.body;
    
    if (!studentId || !quizName) return res.status(400).json({ error: 'بيانات ناقصة' });

    try {
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, subjectId, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5, $6)',
            [studentId, quizName, subjectId || null, score || 0, totalQuestions || 0, correctAnswers || 0]
        );
        res.json({ message: 'تم حفظ النتيجة' });
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
        
        if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });

        const totalQuizzes = rs.length;
        const averageScore = Math.round(rs.reduce((a, b) => a + b.score, 0) / totalQuizzes);
        const bestScore = Math.max(...rs.map(x => x.score));
        const totalCorrect = rs.reduce((a, b) => a + b.correctanswers, 0);

        res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
    } catch (e) { res.status(500).json({ error: 'خطأ في الحسابات' }); }
});

app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    try {
        await pool.query(
            'INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3)', 
            [studentId, activityType, subjectName || null]
        );
        res.json({ message: 'Activity logged' });
    } catch (e) { res.status(500).json({ error: 'Error logging' }); }
});


/* -------------------------------------------------------------------------- */
/* 3. نظام قفل الاختبارات (Quiz Lock System)                                  */
/* -------------------------------------------------------------------------- */

// جلب حالة الأقفال (للواجهة الأمامية ولوحة التحكم)
app.get('/api/quiz-status', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_locks');
        const locks = {};
        result.rows.forEach(row => {
            locks[row.subject_key] = { locked: row.is_locked, message: row.message };
        });
        res.json(locks);
    } catch (e) {
        console.error('Quiz Status Error:', e);
        res.status(500).json({ error: 'خطأ في جلب حالة الأقفال' });
    }
});

// تحديث حالة القفل (من لوحة التحكم)
app.post('/api/admin/quiz-lock', async (req, res) => {
    const { subjectKey, isLocked, message } = req.body;
    
    if (!subjectKey) return res.status(400).json({ error: 'Subject Key required' });

    try {
        await pool.query(`
            INSERT INTO quiz_locks (subject_key, is_locked, message)
            VALUES ($1, $2, $3)
            ON CONFLICT (subject_key)
            DO UPDATE SET is_locked = $2, message = $3, updated_at = CURRENT_TIMESTAMP
        `, [subjectKey, isLocked, message]);
        
        console.log(`🔒 Lock Update: ${subjectKey} -> ${isLocked}`);
        res.json({ message: 'تم تحديث حالة القفل بنجاح' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'فشل تحديث القفل' });
    }
});


/* -------------------------------------------------------------------------- */
/* 4. لوحة تحكم الإدارة (Admin Dashboard)                                     */
/* -------------------------------------------------------------------------- */

app.get('/api/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
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
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/login-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
            FROM login_logs ll JOIN students s ON ll.studentId = s.id 
            ORDER BY ll.loginTime DESC LIMIT 50
        `);
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp 
            FROM activity_logs act JOIN students s ON act.studentId = s.id 
            ORDER BY act.timestamp DESC LIMIT 50
        `);
        res.json(result.rows || []);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/status', async (req, res) => {
    const { id } = req.params;
    const { isblocked } = req.body;
    try {
        await pool.query('UPDATE students SET isblocked = $1 WHERE id = $2', [isblocked, id]);
        res.json({ message: 'Status updated' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    const { id } = req.params;
    const reason = req.body.reason || 'Blocked by Admin';
    try {
        const fpResult = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [id]);
        if (fpResult.rows.length === 0) return res.status(404).json({ error: 'No fingerprint found' });
        
        await pool.query('INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING', [fpResult.rows[0].fingerprint, reason]);
        res.json({ message: 'Device blocked' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/students/:id/unblock-fingerprint', async (req, res) => {
    const { id } = req.params;
    try {
        const fpResult = await pool.query('SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1', [id]);
        if (fpResult.rows.length === 0) return res.status(404).json({ error: 'No fingerprint found' });
        
        await pool.query('DELETE FROM blocked_fingerprints WHERE fingerprint = $1', [fpResult.rows[0].fingerprint]);
        res.json({ message: 'Device unblocked' });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running correctly ✅' });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port: ${PORT}`);
    initializeDatabase().catch(console.error);
});
