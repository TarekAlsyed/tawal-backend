// (جديد) تحميل متغيرات البيئة (مثل رابط قاعدة البيانات)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
// (*** تعديل: قم بتغيير هذا السطر ***)
const { Pool, types } = require('pg');

// (*** جديد وموسع: لإصلاح جميع مشاكل "Invalid Date" ***)
// إخبار مكتبة pg أن تعيد التواريخ كنصوص (String)

// OID for TIMESTAMP (بدون منطقة زمنية)
types.setTypeParser(1114, (stringValue) => {
  return stringValue;
});

// OID for TIMESTAMPTZ (مع منطقة زمنية - وهو الذي نستخدمه)
types.setTypeParser(1184, (stringValue) => {
  return stringValue;
});
// (*** نهاية الإضافة ***)


const app = express();
const PORT = process.env.PORT || 3001; 

// Middleware
const corsOptions = {
  origin: 'https://tarekalsyed.github.io',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// (تغيير: الاتصال بـ PostgreSQL عن طريق الرابط)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // (هام: إذا كنت تستخدم Railway، قد تحتاج هذا السطر)
   ssl: {
    rejectUnauthorized: false
  }
});

// دالة لتهيئة قاعدة البيانات
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('✓ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح');
    
    // (تغيير: تعديل SQL ليتوافق مع PostgreSQL)
    await client.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL REFERENCES students(id),
        loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        logoutTime TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL REFERENCES students(id),
        activityType TEXT NOT NULL,
        subjectName TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✓ تم تهيئة جداول PostgreSQL (مع جدول الأنشطة)');
  } catch (err) {
    console.error('خطأ في تهيئة قاعدة البيانات:', err);
  } finally {
    client.release();
  }
}

// ============ API Endpoints (محدثة لـ async/await) ============

// 1. تسجيل طالب جديد
app.post('/api/students/register', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'الاسم والبريد الإلكتروني مطلوبان' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.json({ ...result.rows[0], message: 'تم التسجيل بنجاح' });
  } catch (err) {
    if (err.code === '23505') { 
      return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    }
    console.error(err);
    return res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// 2. الحصول على بيانات الطالب
app.get('/api/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'الطالب غير موجود' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// 3. حفظ نتيجة اختبار
app.post('/api/quiz-results', async (req, res) => {
  const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;
  if (!studentId || !quizName || score === undefined) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [studentId, quizName, score, totalQuestions, correctAnswers]
    );
    res.json({ id: result.rows[0].id, message: 'تم حفظ النتيجة بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في حفظ النتيجة' });
  }
});

// 4. جلب نتائج الطالب
app.get('/api/students/:id/results', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC',
      [id]
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب النتائج' });
  }
});

// 5. جلب إحصائيات الطالب
app.get('/api/students/:id/stats', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [id]);
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
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// 6. جلب جميع الطلاب (للإدارة)
app.get('/api/admin/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب الطلاب' });
  }
});

// 7. جلب إحصائيات عامة (للإدارة)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const studentCountResult = await pool.query('SELECT COUNT(*) as totalStudents FROM students');
    const quizStatsResult = await pool.query('SELECT COUNT(*) as totalQuizzes, AVG(score) as averageScore FROM quiz_results');
    
    res.json({
      totalStudents: parseInt(studentCountResult.rows[0].totalstudents) || 0,
      totalQuizzes: parseInt(quizStatsResult.rows[0].totalquizzes) || 0,
      averageScore: Math.round(quizStatsResult.rows[0].averagescore || 0)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ' });
  }
});

// 8. تسجيل دخول الطالب
app.post('/api/login', async (req, res) => {
  const { studentId } = req.body;
  if (!studentId) {
    return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id',
      [studentId]
    );
    res.json({ logId: result.rows[0].id, message: 'تم تسجيل الدخول' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في تسجيل الدخول' });
  }
});

// 9. تسجيل خروج الطالب
app.post('/api/logout', async (req, res) => {
  const { logId } = req.body;
  if (!logId) {
    return res.status(400).json({ error: 'معرف السجل مطلوب' });
  }
  try {
    await pool.query(
      'UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1',
      [logId]
    );
    res.json({ message: 'تم تسجيل الخروج' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في تسجيل الخروج' });
  }
});

// 10. جلب سجلات الدخول والخروج (للإدارة)
app.get('/api/admin/login-logs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
      FROM login_logs ll JOIN students s ON ll.studentId = s.id
      ORDER BY ll.loginTime DESC`
    );
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب السجلات' });
  }
});

// 11. تسجيل نشاط
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    if (!studentId || !activityType) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3) RETURNING id',
            [studentId, activityType, subjectName || null]
        );
        res.json({ id: result.rows[0].id, message: 'تم تسجيل النشاط بنجاح' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في تسجيل النشاط' });
    }
});

// 12. جلب سجلات الأنشطة (للإدارة)
app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp
            FROM activity_logs act
            JOIN students s ON act.studentId = s.id
            ORDER BY act.timestamp DESC`
        );
        res.json(result.rows || []);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في جلب سجلات الأنشطة' });
    }
});


// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'الخادم يعمل بشكل صحيح' });
});

// بدء الخادم
app.listen(PORT, () => {
  console.log(`\n✓ الخادم يعمل على: http://localhost:${PORT}`);
  console.log(`✓ API متاح على: http://localhost:${PORT}/api`);
  // (جديد) تشغيل تهيئة قاعدة البيانات عند بدء التشغيل
  initializeDatabase().catch(console.error);
});
