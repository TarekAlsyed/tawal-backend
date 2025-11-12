// app_modified_secure.js
// (*** إصدار v3: إصلاح شامل لـ case_sensitivity (camelCase) ***)
// - PORT
// - DATABASE_URL
// - ADMIN_KEY
// - FP_SECRET
// - NODE_ENV = 'production'

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const xss = require('xss'); 

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const corsOptions = {
  origin: [
    'https://tarekalsyed.github.io',
    'http://127.0.0.1:5500'
  ],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(helmet());

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 200 }); 
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20 }); 
app.use('/api/', apiLimiter);
app.use('/api/admin/', adminLimiter);

// --- إعداد اتصال PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false 
  } 
});

// --- قائمة كلمات ممنوعة ---
const BANNED_WORDS = ['كلمة_سيئة', 'لفظ_خارج', 'شتيمة'];
function containsBannedWord(text) {
  if (!text) return false;
  const lower = text.toString().toLowerCase();
  return BANNED_WORDS.some(w => lower.includes(w.toLowerCase()));
}

// --- تحقق بريد إلكتروني بسيط ---
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

// --- هاش/تجزئة البصمة بواسطة HMAC ---
function hashFingerprint(fingerprint) {
  if (!process.env.FP_SECRET) {
    console.warn('FP_SECRET غير مُعطى — استخدام البصمات كنص خام غير مستحسن');
    return fingerprint;
  }
  return crypto.createHmac('sha256', process.env.FP_SECRET).update(String(fingerprint)).digest('hex');
}

// --- Middleware مصادقة للمسارات الإدارية ---
function adminAuth(req, res, next) {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// حماية المسارات الإدارية
app.use('/api/admin', adminAuth);
// حماية مسارات التصحيح (debug)
app.use('/api/debug', adminAuth);

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'الخادم يعمل بشكل صحيح' });
});

app.get('/', (req, res) => {
  res.send('الخادم يعمل. اذهب إلى /api/health للتحقق.');
});

// --- تهيئة قاعدة البيانات (*** إصلاح: استخدام camelCase ***) ---
async function initializeDatabase() {
  try {
    // (استخدام الأسماء القديمة camelCase)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        deviceFingerprint TEXT,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        isBanned INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_fingerprints (
        id SERIAL PRIMARY KEY,
        fingerprint TEXT UNIQUE NOT NULL,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_ips (
        id SERIAL PRIMARY KEY,
        ip_address TEXT UNIQUE NOT NULL,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_results (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        quizName TEXT NOT NULL,
        score INTEGER NOT NULL,
        totalQuestions INTEGER NOT NULL,
        correctAnswers INTEGER NOT NULL,
        completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(studentId) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        logoutTime TIMESTAMPTZ,
        ip_address TEXT,
        FOREIGN KEY(studentId) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        activityType TEXT NOT NULL,
        subjectName TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(studentId) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    
    // (*** إصلاح: التأكد من إضافة الخانات بالأسماء الصح ***)
    try {
        await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS deviceFingerprint TEXT');
    } catch (e) {
        if (e.code !== '42701') console.error('خطأ إضافة خانة البصمة:', e);
    }
    
    try {
        await pool.query('ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS ip_address TEXT');
    } catch (e) {
        if (e.code !== '42701') console.error('خطأ إضافة خانة الـ IP:', e);
    }

    console.log('✓ تهيئة جداول PostgreSQL اكتملت (إصدار camelCase)');
  } catch (err) {
    console.error('خطأ في تهيئة قاعدة البيانات:', err.message || err);
  }
}

// --- وظيفة مساعدة لتنظيف النصوص قبل التخزين ---
function sanitizeInput(value, maxLen = 200) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  s = xss(s); 
  return s;
}

// --- Debug endpoint محمي ---
app.get('/api/debug/show-all-students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, isBanned, deviceFingerprint, createdAt FROM students ORDER BY id DESC');
    res.json(rows || []);
  } catch (err) {
    console.error('debug error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Check device endpoint ---
app.post('/api/check-device', async (req, res) => {
  const fingerprint = sanitizeInput(req.body.fingerprint, 500);
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint is required' });
  try {
    const hashed = hashFingerprint(fingerprint);
    const { rows } = await pool.query('SELECT 1 FROM banned_fingerprints WHERE fingerprint = $1 LIMIT 1', [hashed]);
    return res.json({ banned: rows.length > 0 });
  } catch (err) {
    console.error('check-device error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- تسجيل طالب جديد ---
app.post('/api/students/register', async (req, res) => {
  try {
    let { name, email, fingerprint } = req.body;
    const userIp = req.ip || null;

    name = sanitizeInput(name, 100);
    email = sanitizeInput(email, 200);
    fingerprint = sanitizeInput(fingerprint, 1000);

    if (!name || !email || !fingerprint) return res.status(400).json({ error: 'الاسم والبريد والبصمة مطلوبان' });
    if (containsBannedWord(name)) return res.status(400).json({ error: 'الاسم يحتوي على كلمات غير لائقة' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });

    const hashedFingerprint = hashFingerprint(fingerprint);

    // تحقق إن كانت البصمة محظورة
    const { rows: bannedRows } = await pool.query('SELECT 1 FROM banned_fingerprints WHERE fingerprint = $1 LIMIT 1', [hashedFingerprint]);
    if (bannedRows.length > 0) return res.status(403).json({ error: 'هذا الجهاز محظور. لا يمكنك التسجيل.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insertText = `INSERT INTO students (name, email, deviceFingerprint) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING *`;
      const insertValues = [name, email, hashedFingerprint];
      const insertResult = await client.query(insertText, insertValues);

      let student;
      if (insertResult.rows.length > 0) {
        student = insertResult.rows[0];
        await client.query('INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2)', [student.id, userIp]);
      } else {
        const { rows } = await client.query('SELECT * FROM students WHERE email = $1', [email]);
        student = rows[0];

        if (!student) throw new Error('Could not find or create student');

        if (student.isBanned === 1) { // (إصلاح: isBanned)
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'هذا الحساب محظور. لا يمكنك الدخول.' });
        }

        await client.query('UPDATE students SET deviceFingerprint = $1 WHERE id = $2', [hashedFingerprint, student.id]);
        await client.query('INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2)', [student.id, userIp]);
      }

      await client.query('COMMIT');
      return res.json({ id: student.id, name: student.name, email: student.email, message: 'تم التسجيل بنجاح' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error('register error:', err.message || err);
    // (إصلاح: التأكد من أن الخطأ 23505 لم يفشل في مكان آخر)
    if (err.code !== '23505') {
        res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// --- الحصول على بيانات طالب ---
app.get('/api/students/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });
  try {
    const { rows } = await pool.query('SELECT id, name, email, isBanned FROM students WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('get student error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- حظر / فك حظر الطالب (Admin فقط) ---
app.post('/api/admin/ban', async (req, res) => {
  const { studentId, status } = req.body; 
  const adminIp = req.ip || null;

  if (studentId === undefined) return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  const id = parseInt(studentId, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (status === 1) {
      // حظر
      const upd = await client.query('UPDATE students SET isBanned = 1 WHERE id = $1 RETURNING deviceFingerprint', [id]);
      const fingerprint = upd.rows[0]?.deviceFingerprint;
      if (fingerprint) {
        await client.query('INSERT INTO banned_fingerprints (fingerprint) VALUES ($1) ON CONFLICT (fingerprint) DO NOTHING', [fingerprint]);
      }

      const { rows: logRows } = await client.query('SELECT ip_address FROM login_logs WHERE studentId = $1 AND ip_address IS NOT NULL ORDER BY loginTime DESC LIMIT 1', [id]);
      const lastIp = logRows[0]?.ip_address;
      if (lastIp && lastIp !== adminIp) {
        await client.query('INSERT INTO banned_ips (ip_address) VALUES ($1) ON CONFLICT (ip_address) DO NOTHING', [lastIp]);
      }

    } else {
      // فك الحظر
      const upd = await client.query('UPDATE students SET isBanned = 0 WHERE id = $1 RETURNING deviceFingerprint', [id]);
      const fingerprint = upd.rows[0]?.deviceFingerprint;
      if (fingerprint) {
        await client.query('DELETE FROM banned_fingerprints WHERE fingerprint = $1', [fingerprint]);
      }

      const { rows: logRows } = await client.query('SELECT ip_address FROM login_logs WHERE studentId = $1 AND ip_address IS NOT NULL ORDER BY loginTime DESC LIMIT 1', [id]);
      const lastIp = logRows[0]?.ip_address;
      if (lastIp) {
        await client.query('DELETE FROM banned_ips WHERE ip_address = $1', [lastIp]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'تم تحديث حالة الطالب بنجاح' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('admin ban error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// --- تسجيل الدخول (يحفظ IP) ---
app.post('/api/login', async (req, res) => {
  const studentId = parseInt(req.body.studentId, 10);
  const userIp = req.ip || null;
  if (Number.isNaN(studentId)) return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  try {
    const { rows } = await pool.query('INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2) RETURNING id', [studentId, userIp]);
    res.json({ logId: rows[0].id, message: 'تم تسجيل الدخول' });
  } catch (err) {
    console.error('login error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- حفظ نتيجة اختبار ---
app.post('/api/quiz-results', async (req, res) => {
  try {
    const studentId = parseInt(req.body.studentId, 10);
    const quizName = sanitizeInput(req.body.quizName, 200);
    const score = parseInt(req.body.score, 10);
    const totalQuestions = parseInt(req.body.totalQuestions, 10) || 0;
    const correctAnswers = parseInt(req.body.correctAnswers, 10) || 0;

    if (Number.isNaN(studentId) || !quizName || Number.isNaN(score)) return res.status(400).json({ error: 'بيانات ناقصة أو غير صالحة' });

    await pool.query('INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1,$2,$3,$4,$5)', [studentId, quizName, score, totalQuestions, correctAnswers]);
    res.json({ message: 'تم حفظ النتيجة بنجاح' });
  } catch (err) {
    console.error('quiz-results error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- جلب نتائج طالب ---
app.get('/api/students/:id/results', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });
  try {
    const { rows } = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [id]);
    res.json(rows || []);
  } catch (err) {
    console.error('get results error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- إحصائيات طالب ---
app.get('/api/students/:id/stats', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'معرف غير صالح' });
  try {
    const { rows } = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [id]);
    const results = rows || [];
    if (results.length === 0) return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
    const totalQuizzes = results.length;
    const averageScore = Math.round(results.reduce((sum, r) => sum + (r.score || 0), 0) / totalQuizzes);
    const bestScore = Math.max(...results.map(r => r.score || 0));
    const totalCorrect = results.reduce((sum, r) => sum + (r.correctAnswers || 0), 0);
    res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
  } catch (err) {
    console.error('stats error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- إدارة: جلب جميع الطلاب ---
app.get('/api/admin/students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, createdAt, isBanned, deviceFingerprint FROM students ORDER BY createdAt DESC');
    res.json(rows || []);
  } catch (err) {
    console.error('admin students error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- إدارة: جلب إحصائيات عامة ---
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
    console.error('admin stats error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- تسجيل الخروج ---
app.post('/api/logout', async (req, res) => {
  const logId = parseInt(req.body.logId, 10);
  if (Number.isNaN(logId)) return res.status(400).json({ error: 'معرف السجل مطلوب' });
  try {
    await pool.query('UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = $1', [logId]);
    res.json({ message: 'تم تسجيل الخروج' });
  } catch (err) {
    console.error('logout error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- إدارة: جلب سجلات الدخول (محمي) ---
app.get('/api/admin/login-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime, ll.ip_address
      FROM login_logs ll JOIN students s ON ll.studentId = s.id
      ORDER BY ll.loginTime DESC
      LIMIT 1000
    `);
    res.json(rows || []);
  } catch (err) {
    console.error('admin login logs error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- تسجيل نشاط ---
app.post('/api/log-activity', async (req, res) => {
  try {
    const studentId = parseInt(req.body.studentId, 10);
    const activityType = sanitizeInput(req.body.activityType, 100);
    const subjectName = sanitizeInput(req.body.subjectName, 200);
    if (Number.isNaN(studentId) || !activityType) return res.status(400).json({ error: 'بيانات ناقصة' });
    const { rows } = await pool.query('INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1,$2,$3) RETURNING id', [studentId, activityType, subjectName]);
    res.json({ id: rows[0].id, message: 'تم تسجيل النشاط بنجاح' });
  } catch (err) {
    console.error('log-activity error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- إدارة: جلب سجلات الأنشطة ---
app.get('/api/admin/activity-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp
      FROM activity_logs act
      JOIN students s ON act.studentId = s.id
      ORDER BY act.timestamp DESC
      LIMIT 1000
    `);
    res.json(rows || []);
  } catch (err) {
    console.error('admin activity logs error:', err.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- بدء الخادم ---
app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`\n✓ الخادم يعمل على: http://localhost:${PORT}`);
  console.log(`✓ API متاح على: http://localhost:${PORT}/api`);
});

// --- إنهاء الاتصال بقاعدة البيانات عند إغلاق التطبيق ---
process.on('SIGINT', async () => {
  try {
    await pool.end();
    console.log('\n✓ تم إغلاق الاتصال بقاعدة البيانات');
  } catch (e) {
    console.error('Error closing pool', e.message || e);
  }
  process.exit(0);
});
