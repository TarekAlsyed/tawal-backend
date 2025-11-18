/*
 * server.js - Tawal Academy (v1.5.0 - Final Complete Version)
 * يحتوي على:
 * - اتصال PostgreSQL.
 * - إصلاح التواريخ.
 * - جداول البصمة والحظر.
 * - جميع الـ Endpoints بما في ذلك حظر الجهاز.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');

// ============ 1. إصلاح مشكلة التواريخ في PostgreSQL ============
// إخبار مكتبة pg بأن تتعامل مع التواريخ كنصوص للحفاظ على التنسيق
types.setTypeParser(1114, (stringValue) => {
  return stringValue;
});
types.setTypeParser(1184, (stringValue) => {
  return stringValue;
});

const app = express();
const PORT = process.env.PORT || 3001; 

// ============ 2. Middleware ============
const corsOptions = {
  origin: 'https://tarekalsyed.github.io', // رابط موقعك
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============ 3. الاتصال بقاعدة البيانات ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
   ssl: {
    rejectUnauthorized: false
  }
});

// ============ 4. تهيئة الجداول (Database Schema) ============
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('✓ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح');
    
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
    // تحديث الجدول القديم إذا لم يكن به عمود الحظر
    try {
        await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE');
    } catch (e) {}

    // جدول النتائج
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

    // جدول سجلات الدخول
    await client.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL REFERENCES students(id),
        loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        logoutTime TIMESTAMPTZ
      )
    `);

    // جدول سجلات الأنشطة
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL REFERENCES students(id),
        activityType TEXT NOT NULL,
        subjectName TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // (جديد) جدول بصمات الطلاب
    await client.query(`
      CREATE TABLE IF NOT EXISTS student_fingerprints (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL REFERENCES students(id),
        fingerprint TEXT NOT NULL,
        lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(studentId, fingerprint)
      )
    `);

    // (جديد) جدول البصمات المحظورة (القائمة السوداء)
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_fingerprints (
        id SERIAL PRIMARY KEY,
        fingerprint TEXT UNIQUE NOT NULL,
        reason TEXT,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✓ تم تهيئة جميع الجداول بنجاح');
  } catch (err) {
    console.error('خطأ في تهيئة قاعدة البيانات:', err);
  } finally {
    client.release();
  }
}

// ============ 5. API Endpoints ============

// --- تسجيل طالب جديد (مع التحقق من البصمة) ---
app.post('/api/students/register', async (req, res) => {
  const { name, email, fingerprint } = req.body;
  
  if (!name || !email) {
    return res.status(400).json({ error: 'الاسم والبريد الإلكتروني مطلوبان' });
  }
  // ملاحظة: نجعل البصمة اختيارية مؤقتاً لتجنب مشاكل التوافق، لكن نفضل وجودها
  
  // 1. التحقق من القائمة السوداء
  if (fingerprint) {
      try {
        const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blockedCheck.rows.length > 0) {
          return res.status(403).json({ error: 'هذا الجهاز محظور من التسجيل.' });
        }
      } catch (err) {
          console.error(err);
      }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN'); 

    // 2. إنشاء الطالب
    const regResult = await client.query(
      'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    const newStudent = regResult.rows[0];

    // 3. تسجيل البصمة (إذا وجدت)
    if (fingerprint) {
        await client.query(
            'INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) VALUES ($1, $2, CURRENT_TIMESTAMP)',
            [newStudent.id, fingerprint]
        );
    }
    
    await client.query('COMMIT'); 
    res.json({ ...newStudent, message: 'تم التسجيل بنجاح' });

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    if (err.code === '23505') { 
      return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
    }
    console.error(err);
    return res.status(500).json({ error: 'خطأ في التسجيل' });
  } finally {
    if (client) client.release();
  }
});

// --- تسجيل دخول (مع تسجيل البصمة) ---
app.post('/api/login', async (req, res) => {
  const { studentId, fingerprint } = req.body;
  if (!studentId) {
    return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  }

  try {
    // 1. التحقق من القائمة السوداء
    if (fingerprint) {
        const blockedCheck = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blockedCheck.rows.length > 0) {
          return res.status(403).json({ error: 'هذا الجهاز محظور.' });
        }

        // 2. تحديث البصمة
        await pool.query(
          `INSERT INTO student_fingerprints (studentId, fingerprint, lastSeen) 
           VALUES ($1, $2, CURRENT_TIMESTAMP) 
           ON CONFLICT (studentId, fingerprint) 
           DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`,
          [studentId, fingerprint]
        );
    }

    // 3. تسجيل الدخول
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

// --- جلب بيانات طالب ---
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

// --- حفظ نتيجة ---
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

// --- جلب نتائج طالب ---
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

// --- جلب إحصائيات طالب ---
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

// --- (إدارة) جلب الطلاب ---
app.get('/api/admin/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في جلب الطلاب' });
  }
});

// --- (إدارة) إحصائيات عامة ---
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

// --- (إدارة) حظر/إلغاء حظر الحساب ---
app.post('/api/admin/students/:id/status', async (req, res) => {
  const { id } = req.params;
  const { isblocked } = req.body; 

  if (isblocked === undefined) {
    return res.status(400).json({ error: 'الحالة (isblocked) مطلوبة' });
  }

  try {
    const result = await pool.query(
      'UPDATE students SET isblocked = $1 WHERE id = $2 RETURNING id, isblocked',
      [isblocked, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'الطالب غير موجود' });
    }
    res.json({ message: 'تم تحديث حالة الطالب بنجاح', student: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في تحديث حالة الطالب' });
  }
});

// --- (إدارة) حظر بصمة الجهاز (BLOCK FINGERPRINT) ---
app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
  const { id } = req.params;
  const reason = req.body.reason || 'Blocked by admin';

  try {
    // 1. البحث عن آخر بصمة
    const fpResult = await pool.query(
      'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
      [id]
    );

    if (fpResult.rows.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على بصمة مسجلة لهذا الطالب.' });
    }
    
    const fingerprintToBlock = fpResult.rows[0].fingerprint;

    // 2. الحظر
    await pool.query(
      'INSERT INTO blocked_fingerprints (fingerprint, reason) VALUES ($1, $2) ON CONFLICT (fingerprint) DO NOTHING',
      [fingerprintToBlock, reason]
    );

    res.json({ message: `تم حظر البصمة (${fingerprintToBlock}) بنجاح.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في حظر البصمة' });
  }
});

// --- تسجيل خروج ---
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

// --- (إدارة) سجلات الدخول ---
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

// --- تسجيل نشاط ---
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

// --- (إدارة) سجلات الأنشطة ---
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
  initializeDatabase().catch(console.error);
});
