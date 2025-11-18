/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 1.9.0 (Final Full Version)
 * =================================================================================
 * هذا الملف يحتوي على الكود المصدري الكامل للخادم.
 * * المميزات المشمولة:
 * 1. اتصال بقاعدة بيانات PostgreSQL (مع معالجة SSL).
 * 2. إصلاح مشاكل توقيت التواريخ (Invalid Date Fix).
 * 3. نظام تسجيل ودخول الطلاب.
 * 4. نظام الامتحانات وحفظ النتائج.
 * 5. لوحة تحكم الإدارة (إحصائيات، سجلات).
 * 6. نظام الحماية الكامل:
 * - حظر الحساب (Account Block).
 * - حظر بصمة الجهاز (Device Fingerprint Block).
 * - فك حظر الجهاز (Unblock Device).
 * =================================================================================
 */

// 1. استيراد المكتبات الضرورية
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');

// =================================================================================
// 2. إعدادات معالجة التواريخ (PostgreSQL Date Parsing Fix)
// =================================================================================
// هذا الجزء يمنع ظهور التواريخ بتنسيق غير مفهوم أو Invalid Date
// نقوم بإجبار المكتبة على إرجاع التواريخ كنصوص String

// النوع 1114: TIMESTAMP (بدون منطقة زمنية)
types.setTypeParser(1114, (stringValue) => {
    return stringValue;
});

// النوع 1184: TIMESTAMPTZ (مع منطقة زمنية - المستخدم لدينا)
types.setTypeParser(1184, (stringValue) => {
    return stringValue;
});


// =================================================================================
// 3. إعدادات التطبيق والوسيط (Middleware)
// =================================================================================
const app = express();
const PORT = process.env.PORT || 3001;

const corsOptions = {
    origin: 'https://tarekalsyed.github.io', // السماح فقط للموقع الرسمي
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// =================================================================================
// 4. الاتصال بقاعدة البيانات (Database Connection)
// =================================================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // ضروري لبيئة Railway/Heroku
    }
});


// =================================================================================
// 5. دالة تهيئة قاعدة البيانات (Database Initialization)
// =================================================================================
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] جاري تهيئة قاعدة البيانات والجداول...');

        // -------------------------------------------
        // أ. جدول الطلاب (Students)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                isBlocked BOOLEAN DEFAULT FALSE 
            )
        `);
        // التأكد من وجود عمود الحظر للجداول القديمة
        try {
            await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE');
        } catch (e) { }

        // -------------------------------------------
        // ب. جدول نتائج الاختبارات (Quiz Results)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_results (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                quizName TEXT NOT NULL,
                score INTEGER NOT NULL,
                totalQuestions INTEGER NOT NULL,
                correctAnswers INTEGER NOT NULL,
                completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // -------------------------------------------
        // ج. جدول سجلات الدخول (Login Logs)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                logoutTime TIMESTAMPTZ
            )
        `);

        // -------------------------------------------
        // د. جدول سجلات الأنشطة (Activity Logs)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                activityType TEXT NOT NULL,
                subjectName TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // -------------------------------------------
        // هـ. جدول بصمات الأجهزة (Fingerprints)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                fingerprint TEXT NOT NULL,
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(studentId, fingerprint)
            )
        `);

        // -------------------------------------------
        // و. جدول الأجهزة المحظورة (Blocked Devices)
        // -------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY,
                fingerprint TEXT UNIQUE NOT NULL,
                reason TEXT,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ [DB] تم الانتهاء من تهيئة جميع الجداول بنجاح.');

    } catch (err) {
        console.error('❌ [DB] حدث خطأ أثناء التهيئة:', err);
    } finally {
        client.release();
    }
}


// =================================================================================
// 6. واجهة برمجة التطبيقات (API Endpoints)
// =================================================================================

/* -------------------------------------------------------------------------- */
/* أولاً: المصادقة والتسجيل (Auth)                                           */
/* -------------------------------------------------------------------------- */

/**
 * تسجيل طالب جديد
 * المسار: POST /api/students/register
 */
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    // 1. فحص حظر الجهاز (Fingerprint Check)
    if (fingerprint) {
        try {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور من التسجيل.' });
            }
        } catch (e) { console.error(e); }
    }

    try {
        // 2. تسجيل الطالب
        const result = await pool.query(
            'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
            [name, email]
        );
        const newStudent = result.rows[0];
        
        // 3. حفظ البصمة
        if (fingerprint) {
            await pool.query(
                'INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)',
                [newStudent.id, fingerprint]
            );
        }
        res.json({ ...newStudent, message: 'تم التسجيل بنجاح' });

    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
        }
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

/**
 * تسجيل الدخول
 * المسار: POST /api/login
 */
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    if (!studentId) return res.status(400).json({ error: 'مطلوب ID' });

    try {
        // 1. فحص البصمة وتحديثها
        if (fingerprint) {
            // هل هي محظورة؟
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور.' });
            }

            // تحديث آخر ظهور للبصمة
            await pool.query(
                `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP) 
                 ON CONFLICT (studentId, fingerprint) 
                 DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`,
                [studentId, fingerprint]
            );
        }
        
        // 2. تسجيل الدخول
        const result = await pool.query(
            'INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', 
            [studentId]
        );
        res.json({ logId: result.rows[0].id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ دخول' });
    }
});

/**
 * تسجيل الخروج
 * المسار: POST /api/logout
 */
app.post('/api/logout', async (req, res) => {
    try {
        await pool.query('UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1', [req.body.logId]);
        res.json({ message: 'Logged out' });
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});


/* -------------------------------------------------------------------------- */
/* ثانياً: بيانات الطلاب والامتحانات                                         */
/* -------------------------------------------------------------------------- */

// جلب بيانات طالب
app.get('/api/students/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
        res.json(result.rows[0]);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// حفظ نتيجة امتحان
app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;
    try {
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5)',
            [studentId, quizName, score, totalQuestions, correctAnswers]
        );
        res.json({ message: 'تم الحفظ' });
    } catch (e) { 
        res.status(500).json({ error: 'خطأ حفظ' }); 
    }
});

// جلب سجل نتائج طالب
app.get('/api/students/:id/results', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', 
            [req.params.id]
        );
        res.json(result.rows || []);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// جلب إحصائيات طالب (للوحة التقدم)
app.get('/api/students/:id/stats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
        const rs = result.rows;
        
        if (!rs.length) {
            return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
        }

        res.json({
            totalQuizzes: rs.length,
            averageScore: Math.round(rs.reduce((a, b) => a + b.score, 0) / rs.length),
            bestScore: Math.max(...rs.map(x => x.score)),
            totalCorrect: rs.reduce((a, b) => a + b.correctAnswers, 0)
        });
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// تسجيل نشاط (Activity Log)
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    try {
        await pool.query(
            'INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3)', 
            [studentId, activityType, subjectName]
        );
        res.json({ message: 'Activity logged' });
    } catch (e) { 
        res.status(500).json({ error: 'Error' }); 
    }
});


/* -------------------------------------------------------------------------- */
/* ثالثاً: لوحة تحكم الإدارة (Admin)                                        */
/* -------------------------------------------------------------------------- */

// جلب جميع الطلاب
app.get('/api/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
        res.json(result.rows || []);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// إحصائيات عامة للمنصة
app.get('/api/admin/stats', async (req, res) => {
    try {
        const sc = await pool.query('SELECT COUNT(*) as t FROM students');
        const qs = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results');
        res.json({
            totalStudents: parseInt(sc.rows[0].t) || 0,
            totalQuizzes: parseInt(qs.rows[0].t) || 0,
            averageScore: Math.round(qs.rows[0].a || 0)
        });
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// سجلات الدخول العامة
app.get('/api/admin/login-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
            FROM login_logs ll JOIN students s ON ll.studentId = s.id 
            ORDER BY ll.loginTime DESC
        `);
        res.json(result.rows || []);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// سجلات الأنشطة العامة
app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp 
            FROM activity_logs act JOIN students s ON act.studentId = s.id 
            ORDER BY act.timestamp DESC
        `);
        res.json(result.rows || []);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});


/* -------------------------------------------------------------------------- */
/* رابعاً: نظام الحظر والحماية (Blocking System)                             */
/* -------------------------------------------------------------------------- */

/**
 * 1. حظر الحساب (Account Block)
 * المسار: POST /api/admin/students/:id/status
 */
app.post('/api/admin/students/:id/status', async (req, res) => {
    const { id } = req.params;
    const { isblocked } = req.body; 

    if (isblocked === undefined) return res.status(400).json({ error: 'Status required' });

    try {
        const result = await pool.query(
            'UPDATE students SET isblocked = $1 WHERE id = $2 RETURNING id',
            [isblocked, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json({ message: 'Updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 2. حظر بصمة الجهاز (Device Block)
 * المسار: POST /api/admin/students/:id/block-fingerprint
 */
app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    const { id } = req.params;
    const reason = req.body.reason || 'Blocked by Admin';

    try {
        // أ. البحث عن آخر بصمة مسجلة للطالب
        const fpResult = await pool.query(
            'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
            [id]
        );

        if (fpResult.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على بصمة مسجلة لهذا الطالب.' });
        }
        
        const fingerprintToBlock = fpResult.rows[0].fingerprint;

        // ب. إضافة البصمة إلى القائمة السوداء
        await pool.query(
            'INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING',
            [fingerprintToBlock, reason]
        );

        res.json({ message: `تم حظر الجهاز (${fingerprintToBlock}) بنجاح.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في حظر البصمة' });
    }
});

/**
 * 3. فك حظر الجهاز (Unblock Device) - (الإضافة الجديدة)
 * المسار: POST /api/admin/students/:id/unblock-fingerprint
 */
app.post('/api/admin/students/:id/unblock-fingerprint', async (req, res) => {
    const { id } = req.params;

    try {
        // أ. العثور على بصمة الطالب
        const fpResult = await pool.query(
            'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
            [id]
        );

        if (fpResult.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على بصمة مسجلة.' });
        }
        
        const fingerprintToUnblock = fpResult.rows[0].fingerprint;

        // ب. حذف البصمة من القائمة السوداء
        await pool.query(
            'DELETE FROM blocked_fingerprints WHERE fingerprint = $1',
            [fingerprintToUnblock]
        );

        res.json({ message: `تم فك حظر الجهاز (${fingerprintToUnblock}) بنجاح.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في فك الحظر' });
    }
});


// =================================================================================
// 7. بدء تشغيل الخادم (Server Start)
// =================================================================================

// نقطة فحص صحة الخادم
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running correctly' });
});

// بدء الاستماع على المنفذ المحدد
app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on port ${PORT}`);
    // تشغيل تهيئة قاعدة البيانات
    initializeDatabase().catch(console.error);
});
