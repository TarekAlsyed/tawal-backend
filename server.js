/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 1.7.0 (Full Extended Version)
 * =================================================================================
 * * هذا الملف يحتوي على جميع وظائف الخادم (Backend) الخاصة بمنصة طوال أكاديمي.
 * * المحتويات:
 * 1. إعدادات الخادم والمكتبات (Configuration).
 * 2. إصلاح مشاكل التواريخ في PostgreSQL.
 * 3. الاتصال بقاعدة البيانات.
 * 4. إنشاء الجداول تلقائياً (Database Schema).
 * 5. نقاط الاتصال (API Endpoints):
 * - تسجيل الطلاب والدخول.
 * - الامتحانات والنتائج.
 * - لوحة تحكم الإدارة (الإحصائيات، السجلات).
 * - نظام الحماية (حظر الحسابات + حظر بصمة الأجهزة).
 * * =================================================================================
 */

// 1. استيراد المكتبات الضرورية
require('dotenv').config(); // لقراءة المتغيرات من ملف .env أو إعدادات الاستضافة
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg'); // مكتبة الاتصال بقاعدة بيانات PostgreSQL

// =================================================================================
// 2. إصلاح مشكلة توقيت وتنسيق التواريخ (PostgreSQL Date Fix)
// =================================================================================
// هذا الجزء مهم جداً لمنع ظهور "Invalid Date" في الواجهة الأمامية.
// نقوم بإجبار المكتبة على إرجاع التواريخ كنصوص (String) كما هي مخزنة،
// بدلاً من محاولة تحويلها وتغيير توقيتها.

// النوع 1114: TIMESTAMP (بدون منطقة زمنية)
types.setTypeParser(1114, (stringValue) => {
    return stringValue;
});

// النوع 1184: TIMESTAMPTZ (مع منطقة زمنية - وهو المستخدم لدينا)
types.setTypeParser(1184, (stringValue) => {
    return stringValue;
});

// =================================================================================
// 3. إعدادات التطبيق (Express Setup)
// =================================================================================
const app = express();
const PORT = process.env.PORT || 3001; // استخدام المنفذ الذي تحدده الاستضافة أو 3001

// إعدادات CORS (السماح للمنصة بالاتصال بالخادم)
const corsOptions = {
    origin: 'https://tarekalsyed.github.io', // النطاق المسموح له فقط
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =================================================================================
// 4. الاتصال بقاعدة البيانات (Database Connection)
// =================================================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // الرابط القادم من Railway
    ssl: {
        rejectUnauthorized: false // ضروري لاتصالات SSL في الاستضافة السحابية
    }
});

// =================================================================================
// 5. دالة تهيئة الجداول (Initialize Database Tables)
// =================================================================================
// هذه الدالة تعمل تلقائياً عند تشغيل الخادم لإنشاء الجداول إذا لم تكن موجودة.

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 جاري تهيئة قاعدة البيانات والتحقق من الجداول...');

        // -----------------------------------------------------
        // أ. جدول الطلاب (Students Table)
        // -----------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                isBlocked BOOLEAN DEFAULT FALSE 
            )
        `);
        // (تأمين إضافي) إضافة عمود الحظر إذا كان الجدول قديماً
        try {
            await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE');
        } catch (alterErr) {
            // تجاهل الخطأ إذا كان العمود موجوداً بالفعل
        }

        // -----------------------------------------------------
        // ب. جدول نتائج الاختبارات (Quiz Results)
        // -----------------------------------------------------
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

        // -----------------------------------------------------
        // ج. جدول سجلات الدخول (Login Logs)
        // -----------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                logoutTime TIMESTAMPTZ
            )
        `);

        // -----------------------------------------------------
        // د. جدول سجلات الأنشطة (Activity Logs)
        // -----------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                activityType TEXT NOT NULL,
                subjectName TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // -----------------------------------------------------
        // هـ. جدول بصمات الأجهزة (Student Fingerprints) - جديد
        // -----------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY,
                studentId INTEGER NOT NULL REFERENCES students(id),
                fingerprint TEXT NOT NULL,
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(studentId, fingerprint)
            )
        `);

        // -----------------------------------------------------
        // و. جدول الأجهزة المحظورة (Blocked Fingerprints) - جديد
        // -----------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY,
                fingerprint TEXT UNIQUE NOT NULL,
                reason TEXT,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ تم الانتهاء من تهيئة جميع الجداول بنجاح.');
    } catch (err) {
        console.error('❌ حدث خطأ خطير أثناء تهيئة قاعدة البيانات:', err);
    } finally {
        client.release(); // إغلاق الاتصال المؤقت
    }
}


// =================================================================================
// 6. واجهة برمجة التطبيقات (API Endpoints)
// =================================================================================

/* -------------------------------------------------------------------------- */
/* 1. المصادقة (Auth)                         */
/* -------------------------------------------------------------------------- */

/**
 * تسجيل طالب جديد
 * يتحقق من حظر الجهاز أولاً، ثم يسجل الطالب والبصمة.
 */
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;

    // التحقق من البيانات
    if (!name || !email) {
        return res.status(400).json({ error: 'الاسم والبريد الإلكتروني مطلوبان' });
    }

    // 1. التحقق مما إذا كان الجهاز محظوراً (Blacklist Check)
    if (fingerprint) {
        try {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'عذراً، هذا الجهاز محظور من إنشاء حسابات جديدة.' });
            }
        } catch (e) {
            console.error("خطأ في فحص البصمة:", e);
        }
    }

    // 2. تنفيذ عملية التسجيل
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // بدء معاملة آمنة (Transaction)

        // إدخال الطالب
        const result = await client.query(
            'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
            [name, email]
        );
        const newStudent = result.rows[0];

        // تسجيل البصمة (إذا وجدت)
        if (fingerprint) {
            await client.query(
                'INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                [newStudent.id, fingerprint]
            );
        }

        await client.query('COMMIT'); // حفظ التغييرات
        res.json({ ...newStudent, message: 'تم التسجيل بنجاح' });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // التراجع في حال الخطأ
        
        if (err.code === '23505') {
            return res.status(400).json({ error: 'هذا البريد الإلكتروني مسجل بالفعل' });
        }
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم أثناء التسجيل' });
    } finally {
        if (client) client.release();
    }
});

/**
 * تسجيل الدخول
 * يتحقق من البصمة، يسجل وقت الدخول.
 */
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;

    if (!studentId) {
        return res.status(400).json({ error: 'معرف الطالب مطلوب' });
    }

    try {
        // 1. التحقق من البصمة وحفظها
        if (fingerprint) {
            // هل هي محظورة؟
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'عذراً، هذا الجهاز تم حظره.' });
            }

            // تحديث أو إضافة البصمة للطالب
            await pool.query(
                `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP) 
                 ON CONFLICT (studentId, fingerprint) 
                 DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`,
                [studentId, fingerprint]
            );
        }

        // 2. تسجيل عملية الدخول في السجلات
        const result = await pool.query(
            'INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id',
            [studentId]
        );

        res.json({ logId: result.rows[0].id, message: 'تم تسجيل الدخول' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ أثناء تسجيل الدخول' });
    }
});

/**
 * تسجيل الخروج
 */
app.post('/api/logout', async (req, res) => {
    const { logId } = req.body;
    if (!logId) return res.status(400).json({ error: 'Logout ID required' });

    try {
        await pool.query('UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1', [logId]);
        res.json({ message: 'تم تسجيل الخروج' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تسجيل الخروج' });
    }
});


/* -------------------------------------------------------------------------- */
/* 2. بيانات الطلاب والنتائج                   */
/* -------------------------------------------------------------------------- */

// جلب بيانات طالب محدد
app.get('/api/students/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'الطالب غير موجود' });
        }
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// حفظ نتيجة اختبار جديد
app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;
    
    if (!studentId || !quizName) return res.status(400).json({ error: 'بيانات ناقصة' });

    try {
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5)',
            [studentId, quizName, score, totalQuestions, correctAnswers]
        );
        res.json({ message: 'تم حفظ النتيجة بنجاح' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'فشل حفظ النتيجة' });
    }
});

// جلب سجل نتائج طالب معين
app.get('/api/students/:id/results', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC',
            [req.params.id]
        );
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: 'خطأ في جلب النتائج' });
    }
});

// جلب إحصائيات طالب معين (للوحة التقدم)
app.get('/api/students/:id/stats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
        const results = result.rows;
        
        if (!results || results.length === 0) {
            return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
        }

        const totalQuizzes = results.length;
        const averageScore = Math.round(results.reduce((sum, r) => sum + r.score, 0) / totalQuizzes);
        const bestScore = Math.max(...results.map(r => r.score));
        const totalCorrect = results.reduce((sum, r) => sum + r.correctAnswers, 0);

        res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حساب الإحصائيات' });
    }
});

// تسجيل نشاط (فتح ملخص، صور، إلخ)
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    try {
        await pool.query(
            'INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3)', 
            [studentId, activityType, subjectName]
        );
        res.json({ message: 'Activity logged' });
    } catch (e) {
        res.status(500).json({ error: 'Error logging activity' });
    }
});


/* -------------------------------------------------------------------------- */
/* 3. لوحة تحكم الإدارة (Admin)                     */
/* -------------------------------------------------------------------------- */

// جلب قائمة جميع الطلاب
app.get('/api/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: 'خطأ في جلب الطلاب' });
    }
});

// جلب الإحصائيات العامة للمنصة
app.get('/api/admin/stats', async (req, res) => {
    try {
        const studentCount = await pool.query('SELECT COUNT(*) as t FROM students');
        const quizStats = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results');
        
        res.json({
            totalStudents: parseInt(studentCount.rows[0].t) || 0,
            totalQuizzes: parseInt(quizStats.rows[0].t) || 0,
            averageScore: Math.round(quizStats.rows[0].a || 0)
        });
    } catch (e) {
        res.status(500).json({ error: 'خطأ في الإحصائيات' });
    }
});

// جلب سجلات الدخول العامة
app.get('/api/admin/login-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
            FROM login_logs ll 
            JOIN students s ON ll.studentId = s.id 
            ORDER BY ll.loginTime DESC
        `);
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: 'خطأ في جلب السجلات' });
    }
});

// جلب سجلات الأنشطة العامة
app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp 
            FROM activity_logs act 
            JOIN students s ON act.studentId = s.id 
            ORDER BY act.timestamp DESC
        `);
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: 'خطأ في جلب الأنشطة' });
    }
});


/* -------------------------------------------------------------------------- */
/* 4. دوال الحظر والحماية (Blocking System)                */
/* -------------------------------------------------------------------------- */
/* (هذه هي الدوال التي كانت مفقودة وتسبب خطأ 404) */

/**
 * تغيير حالة حظر الحساب (Account Block)
 * يقوم بتغيير قيمة isBlocked في جدول الطلاب
 */
app.post('/api/admin/students/:id/status', async (req, res) => {
    const { id } = req.params;
    const { isblocked } = req.body; // تأكدنا من استخدام أحرف صغيرة

    if (isblocked === undefined) {
        return res.status(400).json({ error: 'حالة الحظر مطلوبة' });
    }

    try {
        const result = await pool.query(
            'UPDATE students SET isblocked = $1 WHERE id = $2 RETURNING id, isblocked',
            [isblocked, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على الطالب' });
        }

        res.json({ 
            message: 'تم تحديث حالة الحظر بنجاح', 
            student: result.rows[0] 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم أثناء التحديث' });
    }
});

/**
 * حظر بصمة الجهاز (Device/Fingerprint Block)
 * يقوم بالبحث عن آخر بصمة للطالب وإضافتها للقائمة السوداء
 */
app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    const { id } = req.params;
    const reason = req.body.reason || 'Blocked by Admin Panel';

    try {
        // 1. البحث عن آخر بصمة مسجلة لهذا الطالب
        const fpResult = await pool.query(
            'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
            [id]
        );

        if (fpResult.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على أي بصمة جهاز مسجلة لهذا الطالب. لا يمكن حظر الجهاز.' });
        }
        
        const fingerprintToBlock = fpResult.rows[0].fingerprint;

        // 2. إضافة البصمة إلى جدول المحظورين (مع تجاهل التكرار)
        await pool.query(
            'INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING',
            [fingerprintToBlock, reason]
        );

        res.json({ 
            message: `تم حظر الجهاز صاحب البصمة (${fingerprintToBlock}) بنجاح. لن يتمكن من التسجيل أو الدخول مرة أخرى.` 
        });

    } catch (err) {
        console.error('Error blocking fingerprint:', err);
        res.status(500).json({ error: 'حدث خطأ أثناء محاولة حظر الجهاز.' });
    }
});


/* -------------------------------------------------------------------------- */
/* 5. تشغيل الخادم                            */
/* -------------------------------------------------------------------------- */

// فحص صحة الخادم
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running correctly' });
});

// بدء الاستماع
app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on port ${PORT}`);
    
    // تشغيل تهيئة قاعدة البيانات عند البدء
    initializeDatabase().catch(console.error);
});
