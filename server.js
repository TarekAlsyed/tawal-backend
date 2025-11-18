/*
 * server.js - Tawal Academy (v1.6.0 - Full & Clean)
 * - نسخة نظيفة تماماً (بدون أخطاء مسافات).
 * - تحتوي على جميع وظائف الحظر وقاعدة البيانات.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool, types } = require('pg');

// 1. إصلاح مشكلة التواريخ
types.setTypeParser(1114, (str) => str);
types.setTypeParser(1184, (str) => str);

const app = express();
const PORT = process.env.PORT || 3001; 

// 2. Middleware
const corsOptions = {
  origin: 'https://tarekalsyed.github.io', 
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 3. الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
   ssl: {
    rejectUnauthorized: false
  }
});

// 4. تهيئة الجداول
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('✓ تهيئة قاعدة البيانات...');
    
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
    try { await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS isBlocked BOOLEAN DEFAULT FALSE'); } catch (e) {}

    // باقي الجداول
    await client.query(`CREATE TABLE IF NOT EXISTS quiz_results (id SERIAL PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id), quizName TEXT NOT NULL, score INTEGER NOT NULL, totalQuestions INTEGER NOT NULL, correctAnswers INTEGER NOT NULL, completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
    await client.query(`CREATE TABLE IF NOT EXISTS login_logs (id SERIAL PRIMARY KEY, studentId INTEGER REFERENCES students(id), loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, logoutTime TIMESTAMPTZ)`);
    await client.query(`CREATE TABLE IF NOT EXISTS activity_logs (id SERIAL PRIMARY KEY, studentId INTEGER REFERENCES students(id), activityType TEXT NOT NULL, subjectName TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
    
    // جداول البصمة والحظر
    await client.query(`CREATE TABLE IF NOT EXISTS student_fingerprints (id SERIAL PRIMARY KEY, studentId INTEGER REFERENCES students(id), fingerprint TEXT NOT NULL, lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, UNIQUE(studentId, fingerprint))`);
    await client.query(`CREATE TABLE IF NOT EXISTS blocked_fingerprints (id SERIAL PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, reason TEXT, createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
    
    console.log('✓ تم الانتهاء من تهيئة جميع الجداول.');
  } catch (err) {
    console.error('خطأ التهيئة:', err);
  } finally {
    client.release();
  }
}

// ============ API Endpoints ============

// --- تسجيل طالب جديد ---
app.post('/api/students/register', async (req, res) => {
  const { name, email, fingerprint } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'بيانات ناقصة' });

  // فحص حظر الجهاز
  if (fingerprint) {
      try {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ error: 'هذا الجهاز محظور.' });
      } catch (e) { console.error(e); }
  }

  try {
    const result = await pool.query('INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
    const newStudent = result.rows[0];
    
    if (fingerprint) {
        await pool.query('INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2)', [newStudent.id, fingerprint]);
    }
    res.json({ ...newStudent, message: 'تم التسجيل' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'الإيميل مسجل بالفعل' });
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// --- تسجيل دخول ---
app.post('/api/login', async (req, res) => {
  const { studentId, fingerprint } = req.body;
  if (!studentId) return res.status(400).json({ error: 'مطلوب ID' });

  try {
    if (fingerprint) {
        const blocked = await pool.query('SELECT 1 FROM blocked_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (blocked.rows.length > 0) return res.status(403).json({ error: 'هذا الجهاز محظور.' });

        await pool.query(`INSERT INTO student_fingerprints (studentId, fingerprint) VALUES ($1, $2) ON CONFLICT (studentId, fingerprint) DO UPDATE SET lastSeen = CURRENT_TIMESTAMP`, [studentId, fingerprint]);
    }
    
    const result = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
    res.json({ logId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'خطأ دخول' });
  }
});

// --- بيانات طالب ---
app.get('/api/students/:id', async (req, res) => {
  try {
      const r = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
      res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// --- حفظ نتائج ---
app.post('/api/quiz-results', async (req, res) => {
  const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;
  try {
      await pool.query('INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5)', [studentId, quizName, score, totalQuestions, correctAnswers]);
      res.json({ message: 'تم الحفظ' });
  } catch (e) { res.status(500).json({ error: 'خطأ حفظ' }); }
});

// --- جلب نتائج ---
app.get('/api/students/:id/results', async (req, res) => {
  const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [req.params.id]);
  res.json(r.rows);
});

// --- جلب إحصائيات ---
app.get('/api/students/:id/stats', async (req, res) => {
  const r = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [req.params.id]);
  const rs = r.rows;
  if (!rs.length) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
  res.json({
      totalQuizzes: rs.length,
      averageScore: Math.round(rs.reduce((a, b) => a + b.score, 0) / rs.length),
      bestScore: Math.max(...rs.map(x => x.score)),
      totalCorrect: rs.reduce((a, b) => a + b.correctAnswers, 0)
  });
});

// --- (إدارة) جلب الطلاب ---
app.get('/api/admin/students', async (req, res) => {
  const r = await pool.query('SELECT * FROM students ORDER BY createdAt DESC');
  res.json(r.rows);
});

// --- (إدارة) إحصائيات عامة ---
app.get('/api/admin/stats', async (req, res) => {
  const sc = await pool.query('SELECT COUNT(*) as t FROM students');
  const qs = await pool.query('SELECT COUNT(*) as t, AVG(score) as a FROM quiz_results');
  res.json({
      totalStudents: parseInt(sc.rows[0].t) || 0,
      totalQuizzes: parseInt(qs.rows[0].t) || 0,
      averageScore: Math.round(qs.rows[0].a || 0)
  });
});

// --- (إدارة) السجلات ---
app.get('/api/admin/login-logs', async (req, res) => {
  const r = await pool.query('SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime FROM login_logs ll JOIN students s ON ll.studentId = s.id ORDER BY ll.loginTime DESC');
  res.json(r.rows);
});

app.get('/api/admin/activity-logs', async (req, res) => {
  const r = await pool.query('SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp FROM activity_logs act JOIN students s ON act.studentId = s.id ORDER BY act.timestamp DESC');
  res.json(r.rows);
});

// --- تسجيل نشاط ---
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    await pool.query('INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3)', [studentId, activityType, subjectName]);
    res.json({ message: 'ok' });
});

// --- تسجيل خروج ---
app.post('/api/logout', async (req, res) => {
    await pool.query('UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1', [req.body.logId]);
    res.json({ message: 'out' });
});

// ============ دوال الحظر ============

// 1. حظر الحساب (Account Block)
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

// 2. حظر الجهاز (Device Block)
app.post('/api/admin/students/:id/block-fingerprint', async (req, res) => {
  const { id } = req.params;
  const reason = req.body.reason || 'Blocked by Admin';

  try {
    // البحث عن آخر بصمة
    const fpResult = await pool.query(
      'SELECT fingerprint FROM student_fingerprints WHERE studentId = $1 ORDER BY lastSeen DESC LIMIT 1',
      [id]
    );

    if (fpResult.rows.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على بصمة مسجلة لهذا الطالب.' });
    }
    
    const fingerprintToBlock = fpResult.rows[0].fingerprint;

    // الحظر
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

// ======================================================

app.get('/api/health', (req, res) => res.json({ status: 'OK', message: 'Server is running' }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initializeDatabase().catch(console.error);
});
