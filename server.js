const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg'); 

const app = express();
const PORT = process.env.PORT || 3001; 

app.set('trust proxy', 1);

// Middleware
const corsOptions = {
  origin: ['https://tarekalsyed.github.io', 'http://127.0.0.1:5500'], 
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// دوال الفلترة
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}
const BANNED_WORDS = ['كلمة_سيئة', 'لفظ_خارج', 'شتيمة']; 
function containsBannedWord(text) {
  if (!text) return false;
  const lowerCaseText = text.toLowerCase();
  return BANNED_WORDS.some(word => lowerCaseText.includes(word.toLowerCase()));
}

// 14. Health check (*** تم نقله للأعلى ***)
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'الخادم يعمل بشكل صحيح' });
});

// 15. معالج الرابط الرئيسي (/)
app.get('/', (req, res) => {
    res.send('الخادم يعمل. اذهب إلى /api/health للتحقق.');
});


// الاتصال بقاعدة بيانات PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: {
    rejectUnauthorized: false 
  }
});

// (*** بداية التعديل: تعديل حارس الـ IP ***)
// هذا الكود يجب أن يكون قبل أي "Endpoint" تاني
app.use(async (req, res, next) => {
    
    // (*** تعديل: تجاهل كل مسارات الإدارة ومسار الفحص ***)
    if (req.path === '/api/health' || req.path.startsWith('/api/admin/')) {
        return next(); // اترك الأدمن وشأنه
    }
    
    const userIp = req.ip;
    try {
        const { rows } = await pool.query('SELECT * FROM banned_ips WHERE ip_address = $1', [userIp]);
        if (rows.length > 0) {
            // إذا كان الـ IP محظور، ارفض الطلب فوراً
            return res.status(403).json({ error: 'الوصول مرفوض من هذا العنوان (IP).' });
        }
    } catch (err) {
        console.warn("IP check failed (DB might be starting up):", err.message);
    }
    next();
});
// (*** نهاية التعديل ***)


// تهيئة قاعدة البيانات (*** تمت إضافة جداول وخانات جديدة ***)
async function initializeDatabase() {
  try {
    // 1. جدول الطلاب
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        isBanned INTEGER DEFAULT 0
      )
    `);
    
    // 2. جدول بصمات الأجهزة المحظورة
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_fingerprints (
        id SERIAL PRIMARY KEY,
        fingerprint TEXT UNIQUE NOT NULL,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // (*** جديد: 3. جدول الـ IP المحظور ***)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_ips (
        id SERIAL PRIMARY KEY,
        ip_address TEXT UNIQUE NOT NULL,
        createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. جدول نتائج الاختبارات
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

    // 5. جدول سجلات الدخول (*** معدل ليضيف الـ IP ***)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        studentId INTEGER NOT NULL,
        loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        logoutTime TIMESTAMPTZ,
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);
    
    // 6. جدول سجلات الأنشطة
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
    
    // (*** تعديل: التأكد من إضافة الخانات الجديدة للجداول القديمة ***)
    try {
        await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS device_fingerprint TEXT');
        console.log('✓ عمود "device_fingerprint" جاهز.');
    } catch (e) {
        if (e.code !== '42701') console.error('خطأ إضافة خانة البصمة:', e);
        else console.log('✓ عمود "device_fingerprint" موجود بالفعل.');
    }
    
    try {
        await pool.query('ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS ip_address TEXT');
        console.log('✓ عمود "ip_address" جاهز.');
    } catch (e) {
        if (e.code !== '42701') console.error('خطأ إضافة خانة الـ IP:', e);
        else console.log('✓ عمود "ip_address" موجود بالفعل.');
    }
    
    console.log('✓ تم تهيئة جداول PostgreSQL (مع نظام الحظر المزدوج) بنجاح');

  } catch (err) {
    console.error('خطأ في تهيئة قاعدة البيانات:', err);
  }
}

// ============ (أداة فحص قاعدة البيانات) ============
app.get('/api/debug-show-all-students', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, name, email, isbanned, device_fingerprint FROM students ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch students', details: err.message });
    }
});
// ==============================================================


// ============ API Endpoints ============

// (نقطة نهاية "الحارس" لفحص بصمة الجهاز)
app.post('/api/check-device', async (req, res) => {
    const { fingerprint } = req.body;
    if (!fingerprint) {
        return res.status(400).json({ error: 'Fingerprint is required' });
    }
    try {
        const { rows } = await pool.query('SELECT * FROM banned_fingerprints WHERE fingerprint = $1', [fingerprint]);
        if (rows.length > 0) {
            return res.json({ banned: true });
        } else {
            return res.json({ banned: false });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error checking device status' });
    }
});


// 1. تسجيل طالب جديد (معدل ليأخذ البصمة ويتحقق منها)
app.post('/api/students/register', async (req, res) => {
  const { name, email, fingerprint } = req.body; 
  const userIp = req.ip; // (*** جديد: تسجيل الـ IP ***)

  // --- الفلترة ---
  if (!name || !email || !fingerprint) {
    return res.status(400).json({ error: 'الاسم والبريد والبصمة مطلوبان' });
  }
  if (containsBannedWord(name)) {
    return res.status(400).json({ error: 'الاسم الذي أدخلته يحتوي على كلمات غير لائقة.' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'الرجاء إدخال بريد إلكتروني صالح.' });
  }
  // --- نهاية الفلترة ---

  try {
    // (التحقق من البصمة أولاً)
    const { rows: bannedRows } = await pool.query('SELECT * FROM banned_fingerprints WHERE fingerprint = $1', [fingerprint]);
    if (bannedRows.length > 0) {
        return res.status(403).json({ error: 'هذا الجهاز محظور. لا يمكنك التسجيل.' });
    }

    // محاولة تسجيل الطالب
    const newUser = await pool.query(
      'INSERT INTO students (name, email, device_fingerprint) VALUES ($1, $2, $3) RETURNING *',
      [name, email, fingerprint] 
    );
    
    // (*** جديد: تسجيل الـ IP عند أول تسجيل ***)
    const newStudentId = newUser.rows[0].id;
    await pool.query('INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2)', [newStudentId, userIp]);

    res.json({ id: newStudentId, name, email, message: 'تم التسجيل بنجاح' });

  } catch (err) {
    if (err.code === '23505') { // الإيميل مسجل من قبل
      try {
        const { rows } = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
        const student = rows[0];

        if (student && student.isbanned === 1) { 
          return res.status(403).json({ error: 'هذا الحساب محظور. لا يمكنك الدخول.' });
        }
        
        // (تحديث البصمة والـ IP للمستخدم العائد)
        await pool.query('UPDATE students SET device_fingerprint = $1 WHERE id = $2', [fingerprint, student.id]);
        await pool.query('INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2)', [student.id, userIp]);


        res.json({ id: student.id, name: student.name, email: student.email, message: 'أهلاً بعودتك!' });
      } catch (dbErr) {
        res.status(500).json({ error: 'خطأ في جلب بيانات الطالب' });
      }
    } else {
      res.status(500).json({ error: 'خطأ في التسجيل', details: err.message });
    }
  }
});

// 2. الحصول على بيانات الطالب (معدل ليشمل حالة الحظر)
app.get('/api/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT id, name, email, isbanned FROM students WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// 13. حظر/فك حظر الطالب (*** معدل ليقوم بحظر البصمة والـ IP ***)
app.post('/api/admin/ban', async (req, res) => {
    const { studentId, status } = req.body;
    const adminIp = req.ip; // (*** جديد: هنجيب الـ IP بتاع الأدمن ***)
    
    if (studentId === undefined) {
        return res.status(400).json({ error: 'معرف الطالب مطلوب' });
    }
    try {
        if (status === 1) { // إذا كان الأمر "حظر"
            // 1. احظر الحساب وهات البصمة
            const { rows } = await pool.query(
                'UPDATE students SET isBanned = 1 WHERE id = $1 RETURNING device_fingerprint',
                [studentId]
            );
            
            // 2. ضيف البصمة لجدول الحظر
            const fingerprint = rows[0]?.device_fingerprint;
            if (fingerprint) {
                await pool.query(
                    'INSERT INTO banned_fingerprints (fingerprint) VALUES ($1) ON CONFLICT (fingerprint) DO NOTHING',
                    [fingerprint]
                );
            }
            
            // (*** جديد: 3. هات آخر IP للطالب وضيفه لجدول الحظر ***)
            const { rows: logRows } = await pool.query(
                'SELECT ip_address FROM login_logs WHERE studentId = $1 AND ip_address IS NOT NULL ORDER BY loginTime DESC LIMIT 1',
                [studentId]
            );
            const lastIp = logRows[0]?.ip_address;
            
            // (*** تعديل: متضفش الـ IP لو كان هو هو بتاع الأدمن ***)
            if (lastIp && lastIp !== adminIp) {
                await pool.query(
                    'INSERT INTO banned_ips (ip_address) VALUES ($1) ON CONFLICT (ip_address) DO NOTHING',
                    [lastIp]
                );
            }

        } else { // إذا كان الأمر "فك الحظر"
             // (ملاحظة: بنفك حظر الحساب بس. البصمة والـ IP يفضلوا محظورين كعقاب)
            await pool.query(
                'UPDATE students SET isBanned = 0 WHERE id = $1',
                [studentId]
            );
        }
        res.json({ message: 'تم تحديث حالة الطالب بنجاح' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تحديث حالة الطالب' });
    }
});


// 8. تسجيل دخول الطالب (*** معدل ليسجل الـ IP ***)
app.post('/api/login', async (req, res) => {
  const { studentId } = req.body;
  const userIp = req.ip; // (*** جديد: تسجيل الـ IP ***)
  
  if (!studentId) {
    return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  }
  try {
    const { rows } = await pool.query(
        'INSERT INTO login_logs (studentId, ip_address) VALUES ($1, $2) RETURNING id', 
        [studentId, userIp]
    );
    res.json({ logId: rows[0].id, message: 'تم تسجيل الدخول' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في تسجيل الدخول' });
  }
});


// (باقي الـ Endpoints كما هي بدون تعديل...)
// ...

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
    const totalCorrect = results.reduce((sum, r) => sum + r.correctanswers, 0); 
    res.json({ totalQuizzes, averageScore, bestScore, totalCorrect });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// 6. جلب جميع الطلاب (للإدارة)
app.get('/api/admin/students', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, createdAt, isBanned, device_fingerprint FROM students ORDER BY createdAt DESC'); 
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
      totalStudents: parseInt(studentCountResult.rows[0].totalstudents) || 0, 
      totalQuizzes: parseInt(quizStatsResult.rows[0].totalquizzes) || 0, 
      averageScore: Math.round(quizStatsResult.rows[0].averagescore || 0) 
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ' });
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
      `SELECT ll.id, s.name, s.email, ll.loginTime, ll.logoutTime, ll.ip_address 
      FROM login_logs ll JOIN students s ON ll.studentId = s.id
      ORDER BY ll.loginTime DESC` // (*** تعديل: جلب الـ IP ***)
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


// بدء الخادم
app.listen(PORT, () => {
  initializeDatabase(); 
  console.log(`\n✓ الخادم يعمل على: http://localhost:${PORT}`);
  console.log(`✓ API متاح على: http://localhost:${PORT}/api`);
  console.log('... (باقي الـ Endpoints) ...');
});

// معالجة إغلاق الخادم
process.on('SIGINT', async () => {
  if (pool) {
    await pool.end();
  }
  console.log('\n✓ تم إغلاق الاتصال بقاعدة البيانات');
  process.exit(0);
});
