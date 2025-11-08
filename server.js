const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

// Middleware
// (*** تعديل CORS للسماح بالرابط الصحيح ***)
const corsOptions = {
  origin: 'https://tarekalsyed.github.io',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
// (*** نهاية التعديل ***)

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// إنشاء قاعدة البيانات
const db = new sqlite3.Database('./tawal_academy.db', (err) => {
  if (err) {
    console.error('خطأ في الاتصال بقاعدة البيانات:', err);
  } else {
    console.log('✓ تم الاتصال بقاعدة البيانات بنجاح');
    initializeDatabase();
  }
});

// تهيئة قاعدة البيانات
function initializeDatabase() {
  db.serialize(() => {
    // جدول الطلاب
    db.run(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول نتائج الاختبارات
    db.run(`
      CREATE TABLE IF NOT EXISTS quiz_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studentId INTEGER NOT NULL,
        quizName TEXT NOT NULL,
        score INTEGER NOT NULL,
        totalQuestions INTEGER NOT NULL,
        correctAnswers INTEGER NOT NULL,
        completedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);

    // جدول تتبع الدخول
    db.run(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        studentId INTEGER NOT NULL,
        loginTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        logoutTime DATETIME,
        FOREIGN KEY(studentId) REFERENCES students(id)
      )
    `);

    console.log('✓ تم تهيئة جداول قاعدة البيانات');
  });
}

// ============ API Endpoints ============

// 1. تسجيل طالب جديد
app.post('/api/students/register', (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'الاسم والبريد الإلكتروني مطلوبان' });
  }

  db.run(
    'INSERT INTO students (name, email) VALUES (?, ?)',
    [name, email],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
        }
        return res.status(500).json({ error: 'خطأ في التسجيل' });
      }
      res.json({ 
        id: this.lastID, 
        name, 
        email,
        message: 'تم التسجيل بنجاح'
      });
    }
  );
});

// 2. الحصول على بيانات الطالب
app.get('/api/students/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM students WHERE id = ?',
    [id],
    (err, student) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ في جلب البيانات' });
      }
      if (!student) {
        return res.status(404).json({ error: 'الطالب غير موجود' });
      }
      res.json(student);
    }
  );
});

// 3. حفظ نتيجة اختبار
app.post('/api/quiz-results', (req, res) => {
  const { studentId, quizName, score, totalQuestions, correctAnswers } = req.body;

  if (!studentId || !quizName || score === undefined) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }

  db.run(
    'INSERT INTO quiz_results (studentId, quizName, score, totalQuestions, correctAnswers) VALUES (?, ?, ?, ?, ?)',
    [studentId, quizName, score, totalQuestions, correctAnswers],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'خطأ في حفظ النتيجة' });
      }
      res.json({ 
        id: this.lastID,
        message: 'تم حفظ النتيجة بنجاح'
      });
    }
  );
});

// 4. جلب نتائج الطالب
app.get('/api/students/:id/results', (req, res) => {
  const { id } = req.params;

  db.all(
    'SELECT * FROM quiz_results WHERE studentId = ? ORDER BY completedAt DESC',
    [id],
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ في جلب النتائج' });
      }
      res.json(results || []);
    }
  );
});

// 5. جلب إحصائيات الطالب
app.get('/api/students/:id/stats', (req, res) => {
  const { id } = req.params;

  db.all(
    'SELECT * FROM quiz_results WHERE studentId = ?',
    [id],
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
      }

      if (!results || results.length === 0) {
        return res.json({
          totalQuizzes: 0,
          averageScore: 0,
          bestScore: 0,
          totalCorrect: 0
        });
      }

      const totalQuizzes = results.length;
      const averageScore = Math.round(
        results.reduce((sum, r) => sum + r.score, 0) / totalQuizzes
      );
      const bestScore = Math.max(...results.map(r => r.score));
      const totalCorrect = results.reduce((sum, r) => sum + r.correctAnswers, 0);

      res.json({
        totalQuizzes,
        averageScore,
        bestScore,
        totalCorrect
      });
    }
  );
});

// 6. جلب جميع الطلاب (للإدارة)
app.get('/api/admin/students', (req, res) => {
  db.all(
    'SELECT * FROM students ORDER BY createdAt DESC',
    (err, students) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ في جلب الطلاب' });
      }
      res.json(students || []);
    }
  );
});

// 7. جلب إحصائيات عامة (للإدارة)
app.get('/api/admin/stats', (req, res) => {
  db.get(
    'SELECT COUNT(*) as totalStudents FROM students',
    (err, studentCount) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ' });
      }

      db.get(
        'SELECT COUNT(*) as totalQuizzes, AVG(score) as averageScore FROM quiz_results',
        (err, quizStats) => {
          if (err) {
            return res.status(500).json({ error: 'خطأ' });
          }

          res.json({
            totalStudents: studentCount?.totalStudents || 0,
            totalQuizzes: quizStats?.totalQuizzes || 0,
            averageScore: Math.round(quizStats?.averageScore || 0)
          });
        }
      );
    }
  );
});

// 8. تسجيل دخول الطالب
app.post('/api/login', (req, res) => {
  const { studentId } = req.body;

  if (!studentId) {
    return res.status(400).json({ error: 'معرف الطالب مطلوب' });
  }

  db.run(
    'INSERT INTO login_logs (studentId) VALUES (?)',
    [studentId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'خطأ في تسجيل الدخول' });
      }
      res.json({ 
        logId: this.lastID,
        message: 'تم تسجيل الدخول'
      });
    }
  );
});

// 9. تسجيل خروج الطالب
app.post('/api/logout', (req, res) => {
  const { logId } = req.body;

  if (!logId) {
    return res.status(400).json({ error: 'معرف السجل مطلوب' });
  }

  db.run(
    'UPDATE login_logs SET logoutTime = CURRENT_TIMESTAMP WHERE id = ?',
    [logId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'خطأ في تسجيل الخروج' });
      }
      res.json({ message: 'تم تسجيل الخروج' });
    }
  );
});

// 10. جلب سجلات الدخول والخروج (للإدارة)
app.get('/api/admin/login-logs', (req, res) => {
  db.all(
    `SELECT 
      ll.id, 
      s.name, 
      s.email, 
      ll.loginTime, 
      ll.logoutTime 
    FROM login_logs ll
    JOIN students s ON ll.studentId = s.id
    ORDER BY ll.loginTime DESC`,
    (err, logs) => {
      if (err) {
        return res.status(500).json({ error: 'خطأ في جلب السجلات' });
      }
      res.json(logs || []);
    }
  );
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'الخادم يعمل بشكل صحيح' });
});

// بدء الخادم
app.listen(PORT, () => {
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
  console.log('  GET    /api/admin/students - جميع الطلاب (إدارة)');
  console.log('  GET    /api/admin/stats - إحصائيات عامة (إدارة)');
  console.log('  GET    /api/admin/login-logs - سجلات الدخول (إدارة)');
  console.log('  GET    /api/health - فحص صحة الخادم\n');
});

// معالجة الأخطاء
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('خطأ في إغلاق قاعدة البيانات:', err);
    } else {
      console.log('\n✓ تم إغلاق قاعدة البيانات');
    }
    process.exit(0);
  });
});
