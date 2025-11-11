const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg'); // (جديد) استبدال sqlite3 بـ pg

const app = express();
const PORT = process.env.PORT || 3001; // (تعديل) استخدام البورت الافتراضي من Railway

// Middleware
const corsOptions = {
  origin: ['https://tarekalsyed.github.io', 'http://127.0.0.1:5500'], // (تعديل) إضافة الرابط المحلي
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// (جديد) دوال الفلترة
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}
const BANNED_WORDS = ['كلمة_سيئة', 'لفظ_خارج', 'شتيمة']; // أضف كلماتك هنا
function containsBannedWord(text) {
  if (!text) return false;
  const lowerCaseText = text.toLowerCase();
  return BANNED_WORDS.some(word => lowerCaseText.includes(word.toLowerCase()));
}

// (*** بداية التعديل: نقل الـ Health Check فوق ***)
// 14. Health check
// هذا الرابط يجب أن يكون أول رابط للرد بسرعة على Railway
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'الخادم يعمل بشكل صحيح' });
});

// 15. (جديد) معالج الخطأ الرئيسي للرابط "/"
// هذا أيضاً يساعد Railway على معرفة أن الخادم "عايش"
app.get('/', (req, res) => {
    res.send('الخادم يعمل. اذهب إلى /api/health للتحقق.');
});
// (*** نهاية التعديل ***)


// (جديد) الاتصال بقاعدة بيانات PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // قراءة الرابط من المتغير السري
  ssl: {
    rejectUnauthorized: false // مطلوب للاتصال بـ Railway
  }
});

// (جديد) تهيئة قاعدة البيانات (بصيغة PostgreSQL)
async function initializeDatabase() {
  try {
    // (تعديل) Sintax الـ SQL الخاص بـ PostgreSQL
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        isBanned INTEGER DEFAULT 0
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
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        logoutTime TIMESTAMPTZ,
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        activityType TEXT NOT NULL,
        subjectName TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);
    
    console.log('✓ تم تهيئة جداول PostgreSQL بنجاح');
  } catch (err) {
    console.error('خطأ في تهيئة قاعدة البيانات:', err);
  }
}

// ============ API Endpoints (محولة إلى PostgreSQL) ============

// 1. تسجيل طالب جديد (async/await)
app.post('/api/students/register', async (req, res) => {
  const { name, email } = req.body;

  // --- الفلترة ---
  if (!name || !email) {
    return res.status(400).json({ error: 'الاسم والبريد الإلكتروني مطلوبان' });
  }
  if (containsBannedWord(name)) {
    return res.status(400).json({ error: 'الاسم الذي أدخلته يحتوي على كلمات غير لائقة.' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'الرجاء إدخال بريد إلكتروني صالح.' });
  }
  // --- نهاية الفلترة ---

  try {
    // محاولة تسجيل الطالب
    const newUser = await pool.query(
      'INSERT INTO students (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.json({ id: newUser.rows[0].id, name, email, message: 'تم التسجيل بنجاح' });

  } catch (err) {
    if (err.code === '23505') { // 23505 هو كود الخطأ "UNIQUE constraint"
      // --- التحقق من الحظر للمستخدم العائد ---
      try {
        const { rows } = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
        const student = rows[0];

        // لاحظ أن pg يحول الأسماء إلى lowercase (isbanned)
        if (student && student.isbanned === 1) { 
          return res.status(403).json({ error: 'هذا الحساب محظور. لا يمكنك الدخول.' });
        }
        res.json({ id: student.id, name: student.name, email: student.email, message: 'أهلاً بعودتك!' });
      } catch (dbErr) {
        res.status(500).json({ error: 'خطأ في جلب بيانات الطالب' });
      }
      // --- نهاية التحقق من الحظر ---
    } else {
      res.status(500).json({ error: 'خطأ في التسجيل' });
    }
  }
});

// 2. الحصول على بيانات الطالب
app.get('/api/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json(rows[0]);
  } catch (err) {
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
    await pool.query(
      'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES ($1, $2, $3, $4, $5)',
      [studentId, quizName, score, totalQuestions, correctAnswers]
    );
    res.json({ message: 'تم حفظ النتيجة بنجاح' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في حفظ النتيجة' });
  }
});

// 4. جلب نتائج الطالب
app.get('/api/students/:id/results', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1 ORDER BY completedAt DESC', [id]);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب النتائج' });
  }
});

// 5. جلب إحصائيات الطالب
app.get('/api/students/:id/stats', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM quiz_results WHERE studentId = $1', [id]);
    const results = rows || [];
    if (results.length === 0) {
      return res.json({ totalQuizzes: 0, averageScore: 0, bestScore: 0, totalCorrect: 0 });
    }
    const totalQuizzes = results.length;
    const averageScore = Math.round(results.reduce((sum, r) => sum + r.score, 0) / totalQuizzes);
    const bestScore = Math.max(...results.map(r => r.score));
    const totalCorrect = results.reduce((sum, r) => sum + r.correctanswers, 0); // (تعديل) postgres يحول لـ lowercase
    res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// 6. جلب جميع الطلاب (للإدارة)
app.get('/api/admin/students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, createdAt, isBanned FROM students ORDER BY createdAt DESC'); // (تعديل) جلب حالة الحظر
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب الطلاب' });
  }
});

// 7. جلب إحصائيات عامة (للإدارة)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const studentCountResult = await pool.query('SELECT COUNT(*) as totalStudents FROM students');
    const quizStatsResult = await pool.query('SELECT COUNT(*) as totalQuizzes, AVG(score) as averageScore FROM quiz_results');
    
    res.json({
      totalStudents: parseInt(studentCountResult.rows[0].totalstudents) || 0, // (تعديل) postgres يحول لـ lowercase
      totalQuizzes: parseInt(quizStatsResult.rows[0].totalquizzes) || 0, // (تعديل) postgres يحول لـ lowercase
      averageScore: Math.round(quizStatsResult.rows[0].averagescore || 0) // (تعديل) postgres يحول لـ lowercase
    });
  } catch (err) {
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
    const { rows } = await pool.query('INSERT INTO login_logs (studentId) VALUES ($1) RETURNING id', [studentId]);
    res.json({ logId: rows[0].id, message: 'تم تسجيل الدخول' });
  } catch (err) {
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
     res.status(500).json({ error: 'خطأ في تسجيل الخروج' });
  }
});

// 10. جلب سجلات الدخول والخروج (للإدارة)
app.get('/api/admin/login-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime 
      FROM login_logs ll JOIN students s ON ll.studentId = s.id
      ORDER BY ll.loginTime DESC`
    );
    res.json(rows || []);
  } catch (err) {
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
    const { rows } = await pool.query(
      'INSERT INTO activity_logs (studentId, activityType, subjectName) VALUES ($1, $2, $3) RETURNING id',
      [studentId, activityType || null, subjectName || null]
    );
    res.json({ id: rows[0].id, message: 'تم تسجيل النشاط بنجاح' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في تسجيل النشاط' });
  }
});

// 12. جلب سجلات الأنشطة (للإدارة)
app.get('/api/admin/activity-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(
        `SELECT act.id, s.name, act.activityType, act.subjectName, act.timestamp
        FROM activity_logs act
        JOIN students s ON act.studentId = s.id
        ORDER BY act.timestamp DESC`
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب سجلات الأنشطة' });
  }
});

// 13. حظر/فك حظر الطالب
app.post('/api/admin/ban', async (req, res) => {
    const { studentId, status } = req.body;
    if (studentId === undefined) {
        return res.status(400).json({ error: 'معرف الطالب مطلوب' });
    }
    try {
        await pool.query(
            'UPDATE students SET isBanned = $1 WHERE id = $2',
            [status, studentId]
        );
        res.json({ message: 'تم تحديث حالة الطالب بنجاح' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تحديث حالة الطالب' });
    }
});

// بدء الخادم
app.listen(PORT, () => {
  // (تعديل) لا ننتظر التهيئة، بل نبدأها في الخلفية
  // هذا يضمن أن /api/health يرد فوراً
  initializeDatabase(); 
  console.log(`\n✓ الخادم يعمل على: http://localhost:${PORT}`);
  console.log(`✓ API متاح على: http://localhost:${PORT}/api`);
  console.log('\n📚 الـ Endpoints المتاحة:');
  console.log('  POST   /api/students/register - تسجيل طالب جديد');
  console.log('  GET    /api/students/:id - الحصول على بيانات الطالب');
  console.log('  POST   /api/quiz-results - حفظ نتيجة اختبار');
  console.log('  GET    /api/students/:id/results - جلب نتائج الطالب');
  console.log('  GET    /api/students/:id/stats - جلب إحصائيات الطالب');
  console.log('  POST   /api/login - تسجيل دخول');
  console.log('  POST   /api/logout - تسجيل خروج');
  console.log('  POST   /api/log-activity - (جديد) تسجيل نشاط الطالب');
  console.log('  GET    /api/admin/students - جميع الطلاب (إدارة)');
  console.log('  GET    /api/admin/stats - إحصائيات عامة (إدارة)');
  console.log('  GET    /api/admin/login-logs - سجلات الدخول (إدارة)');
  console.log('  GET    /api/admin/activity-logs - (جديد) سجلات الأنشطة (إدارة)');
  console.log('  POST   /api/admin/ban - (جديد) حظر/فك حظر طالب');
  console.log('  GET    /api/health - فحص صحة الخادم\n');
});

// (جديد) معالجة إغلاق الخادم
process.on('SIGINT', async () => {
  if (pool) {
    await pool.end();
  }
  console.log('\n✓ تم إغلاق الاتصال بقاعدة البيانات');
  process.exit(0);
});
