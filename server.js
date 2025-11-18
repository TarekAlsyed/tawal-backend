/*
 * =================================================================================
 * SERVER.JS - Tawal Academy Backend API
 * Version: 1.10.0 (Final Full Version)
 * =================================================================================
 * هذا الملف يحتوي على الكود المصدري الكامل للخادم (Backend).
 * * المميزات المشمولة:
 * 1. اتصال بقاعدة بيانات PostgreSQL (مع دعم SSL لـ Railway).
 * 2. معالجة صحيحة للتواريخ (Fix Invalid Date).
 * 3. نظام تسجيل ودخول الطلاب (مع التحقق من التكرار).
 * 4. نظام الامتحانات وحفظ النتائج والإحصائيات.
 * 5. لوحة تحكم الإدارة (عرض الطلاب، السجلات، الأنشطة).
 * 6. نظام الحماية الكامل:
 * - حظر الحساب (Account Block).
 * - حظر بصمة الجهاز (Device Fingerprint Block).
 * - فك حظر الجهاز (Unblock Device).
 * =================================================================================
 */

// ---------------------------------------------------------------------------------
// 1. استيراد المكتبات وإعدادات البيئة
// ---------------------------------------------------------------------------------
require('dotenv').config(); // لقراءة المتغيرات من ملف .env
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg'); // مكتبة الاتصال بـ PostgreSQL

// ---------------------------------------------------------------------------------
// 2. إصلاح مشكلة التواريخ في PostgreSQL
// ---------------------------------------------------------------------------------
// هذه الخطوة ضرورية جداً لمنع ظهور التواريخ بتنسيق غير مفهوم أو "Invalid Date"
// نقوم بإجبار المكتبة على إرجاع التواريخ كنصوص (String) كما هي مخزنة في القاعدة.

// النوع 1114: TIMESTAMP (بدون منطقة زمنية)
types.setTypeParser(1114, (stringValue) => {
    return stringValue;
});

// النوع 1184: TIMESTAMPTZ (مع منطقة زمنية - المستخدم لدينا)
types.setTypeParser(1184, (stringValue) => {
    return stringValue;
});


// ---------------------------------------------------------------------------------
// 3. إعدادات تطبيق Express والوسيط (Middleware)
// ---------------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3001; // استخدام المنفذ المحدد أو 3001

const corsOptions = {
    origin: 'https://tarekalsyed.github.io', // السماح فقط للموقع الرسمي بالاتصال
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// ---------------------------------------------------------------------------------
// 4. الاتصال بقاعدة البيانات (Database Connection)
// ---------------------------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // الرابط القادم من إعدادات Railway
    ssl: {
        rejectUnauthorized: false // ضروري للاتصال المشفر في الاستضافة السحابية
    }
});


// ---------------------------------------------------------------------------------
// 5. دالة تهيئة قاعدة البيانات (Initialize Database Tables)
// ---------------------------------------------------------------------------------
// هذه الدالة تعمل تلقائياً عند تشغيل الخادم لإنشاء الجداول إذا لم تكن موجودة.

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] جاري تهيئة قاعدة البيانات والجداول...');

        // -------------------------------------------
        // أ. جدول الطلاب (Students Table)
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
        
        // محاولة إضافة عمود الحظر للجداول القديمة (للتوافق)
        try {
            await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE');
        } catch (e) { 
            // تجاهل الخطأ إذا كان العمود موجوداً بالفعل
        }

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
        // هـ. جدول بصمات الأجهزة (Student Fingerprints) - جديد
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
        // و. جدول الأجهزة المحظورة (Blocked Fingerprints) - جديد
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
        console.error('❌ [DB] حدث خطأ أثناء تهيئة قاعدة البيانات:', err);
    } finally {
        client.release(); // إغلاق الاتصال المؤقت
    }
}


// =================================================================================
// 6. واجهة برمجة التطبيقات (API Endpoints)
// =================================================================================

/* -------------------------------------------------------------------------- */
/* القسم الأول: المصادقة والتسجيل (Authentication)                           */
/* -------------------------------------------------------------------------- */

/**
 * تسجيل طالب جديد
 * المسار: POST /api/students/register
 */
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ error: 'البيانات ناقصة (الاسم أو البريد)' });
    }

    // 1. التحقق مما إذا كان الجهاز (البصمة) محظوراً
    if (fingerprint) {
        try {
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور من التسجيل.' });
            }
        } catch (e) { 
            console.error("خطأ في فحص البصمة:", e);
        }
    }

    // 2. تنفيذ عملية التسجيل
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // بدء معاملة (Transaction)

        // إدخال الطالب
        const result = await client.query(
            'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
            [name, email]
        );
        const newStudent = result.rows[0];
        
        // تسجيل البصمة مع الحساب الجديد
        if (fingerprint) {
            await client.query(
                'INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                [newStudent.id, fingerprint]
            );
        }
        
        await client.query('COMMIT'); // إتمام المعاملة وحفظ البيانات
        res.json({ ...newStudent, message: 'تم التسجيل بنجاح' });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // التراجع في حال الخطأ
        
        // معالجة حالة الإيميل المكرر
        if (err.code === '23505') { 
            return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
        }
        
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم أثناء التسجيل' });
    } finally {
        if (client) client.release();
    }
});

/**
 * تسجيل الدخول
 * المسار: POST /api/login
 */
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;

    if (!studentId) {
        return res.status(400).json({ error: 'مطلوب ID الطالب' });
    }

    try {
        // 1. التحقق من البصمة وحفظها
        if (fingerprint) {
            // هل هي محظورة؟
            const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
            if (blockedCheck.rows.length > 0) {
                return res.status(403).json({ error: 'هذا الجهاز محظور.' });
            }

            // تحديث تاريخ آخر ظهور للبصمة أو إضافتها
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
 * المسار: POST /api/logout
 */
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
/* القسم الثاني: بيانات الطلاب والامتحانات (Student Data)                    */
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
        res.status(500).json({ error: 'خطأ خادم' }); 
    }
});

// حفظ نتيجة امتحان
app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;
    
    if (!studentId || !quizName) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    try {
        await pool.query(
            'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5)',
            [studentId, quizName, score, totalQuestions, correctAnswers]
        );
        res.json({ message: 'تم الحفظ بنجاح' });
    } catch (e) { 
        res.status(500).json({ error: 'فشل الحفظ' }); 
    }
});

// جلب جميع نتائج طالب معين (للعرض في لوحة التحكم أو الملف الشخصي)
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

// جلب إحصائيات طالب معين (للوحة التقدم)
app.get('/api/students/:id/stats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
        const rs = result.rows;
        
        if (!rs.length) {
            return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
        }

        // حساب الإحصائيات
        const totalQuizzes = rs.length;
        const averageScore = Math.round(rs.reduce((a, b) => a + b.score, 0) / totalQuizzes);
        const bestScore = Math.max(...rs.map(x => x.score));
        const totalCorrect = rs.reduce((a, b) => a + b.correctAnswers, 0);

        res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
    } catch (e) { 
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// تسجيل نشاط (تصفح، فتح ملخص، إلخ)
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
/* القسم الثالث: لوحة تحكم الإدارة (Admin Dashboard)                          */
/* -------------------------------------------------------------------------- */

// أ. جلب قائمة جميع الطلاب
app.get('/api/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
        res.json(result.rows || []);
    } catch (e) { 
        res.status(500).json({ error: 'خطأ في جلب الطلاب' }); 
    }
});

// ب. جلب الإحصائيات العامة للمنصة
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
        res.status(500).json({ error: 'خطأ' }); 
    }
});

// ج. جلب سجلات الدخول العامة
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

// د. جلب سجلات الأنشطة العامة
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
/* القسم الرابع: نظام الحظر والحماية (Blocking & Security)                   */
/* -------------------------------------------------------------------------- */

/**
 * 1. حظر / إلغاء حظر الحساب (Account Block)
 * يغير حالة العمود `isBlocked` في جدول `students`.
 * الطالب المحظور لن يتمكن من الدخول بإيميله حتى لو غير الجهاز.
 */
app.post('/api/admin/students/:id/status', async (req, res) => {
    const { id } = req.params;
    const { isblocked } = req.body; // تأكدنا من استخدام أحرف صغيرة

    if (isblocked === undefined) {
        return res.status(400).json({ error: 'Status required' });
    }

    try {
        const result = await pool.query(
            'UPDATE students SET isblocked = $1 WHERE id = $2 RETURNING id',
            [isblocked, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على الطالب' });
        }

        res.json({ message: 'تم تحديث حالة الحظر بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم أثناء التحديث' });
    }
});

/**
 * 2. حظر بصمة الجهاز (Device/Fingerprint Block)
 * يقوم بالبحث عن آخر بصمة استخدمها الطالب ويضيفها للقائمة السوداء.
 * هذا يمنع أي شخص من استخدام هذا الجهاز للتسجيل أو الدخول، حتى لو غير الإيميل.
 */
app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
    const { id } = req.params;
    const reason = req.body.reason || 'Blocked by Admin';

    try {
        // أ. البحث عن آخر بصمة مسجلة لهذا الطالب
        const fpResult = await pool.query(
            'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
            [id]
        );

        if (fpResult.rows.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على أي بصمة جهاز مسجلة لهذا الطالب.' });
        }
        
        const fingerprintToBlock = fpResult.rows[0].fingerprint;

        // ب. إضافة البصمة إلى جدول المحظورين
        await pool.query(
            'INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING',
            [fingerprintToBlock, reason]
        );

        res.json({ message: `تم حظر الجهاز (${fingerprintToBlock}) بنجاح.` });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'حدث خطأ أثناء محاولة حظر الجهاز.' });
    }
});

/**
 * 3. فك حظر الجهاز (Unblock Device)
 * يقوم بحذف بصمة الطالب من القائمة السوداء للسماح له بالدخول مجدداً.
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
        res.status(500).json({ error: 'خطأ أثناء فك الحظر' });
    }
});


// =================================================================================
// 7. بدء تشغيل الخادم (Server Start)
// =================================================================================

// نقطة فحص صحة الخادم (Health Check)
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running correctly' });
});

// بدء الاستماع للمنفذ
app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on port ${PORT}`);
    // محاولة تهيئة قاعدة البيانات عند البدء
    initializeDatabase().catch(console.error);
});
