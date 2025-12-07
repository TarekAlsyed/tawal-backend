/*
 * =================================================================================
 * SERVER.JS - Main Backend Server
 * =================================================================================
 * 🔥 تم تطبيق الإصلاحات الحرجة للمشاكل التالية:
 * 1. مشكلة CORS Errors في Production - تم استبدال إعدادات CORS بقائمة ديناميكية تدعم vercel.app و github.io.
 * 2. تحديث نقطة نهاية /api/auth/send-otp - لعرض الرمز في وضع التطوير إذا فشل إرسال SendGrid.
 * 3. تحديث استخدامات Redis - استبدال جميع استدعاءات redisClient بدوال cache الآمنة (get, setEx, del).
 */
require('dotenv').config();

// 1. الثوابت والإعدادات
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;

// 2. الملحقات والمعدات
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const cors = require('cors');
const path = require('path');
// ✅ تحديث لاستخدام دوال الـ safe cache بدلاً من العميل المباشر
const cache = require('./cache'); 
const { sendEmail } = require('./email'); // دالة إرسال الإيميل
const app = express();
const pool = new Pool({ connectionString: DB_URL });

// 3. إعداد CORS - (إصلاح مشكلة GitHub Pages)
const allowedOrigins = [
    'http://localhost:8000', 
    'http://127.0.0.1:8000',
    'https://tawal-academy.vercel.app', 
    'https://tawal-academy.vercel.app/'
];

const corsOptions = {
    origin: (origin, callback) => {
        // السماح بالطلبات التي لا تحتوي على Origin (مثل تطبيقات الهاتف المحمول)
        if (!origin) return callback(null, true);
        
        // السماح بالقائمة المحددة
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        
        // ✅ السماح بجميع النطاقات الفرعية لـ vercel.app و github.io
        if (origin.endsWith('.vercel.app') || origin.endsWith('.github.io') || origin.endsWith('.github.io/')) {
            return callback(null, true);
        }

        // رفض أي أصل آخر
        callback(new Error('Not allowed by CORS'));
    },
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// =================================================================
// 4. الدوال المساعدة وقواعد البيانات
// =================================================================

/**
 * دالة لتنفيذ استعلامات قواعد البيانات
 * @param {string} text - الاستعلام
 * @param {Array<any>} params - المعلمات
 */
async function query(text, params) {
    try {
        const res = await pool.query(text, params);
        return res;
    } catch (err) {
        console.error('Database Query Error:', err.stack);
        throw err;
    }
}

/**
 * الحصول على بيانات الطالب
 * @param {number} studentId - رقم الطالب
 */
async function getStudentById(studentId) {
    const res = await query('SELECT id, name, email, progress, isblocked FROM students WHERE id = $1', [studentId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

// =================================================================
// 5. نقاط نهاية Authentication
// =================================================================

// 5.1 إرسال رمز التحقق لمرة واحدة (OTP)
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    
    // التحقق من صحة الإدخال
    const schema = Joi.object({
        email: Joi.string().email().required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    try {
        // التحقق من الحد الأقصى للمحاولات (Rate Limiting)
        const rateLimitKey = `otp_limit:${email}`;
        // ✅ استبدال redisClient.get بـ cache.get
        const currentLimit = await cache.get(rateLimitKey); 
        if (currentLimit && parseInt(currentLimit) >= 5) {
            return res.status(429).json({ error: 'Too many OTP requests today' });
        }
        
        // توليد الرمز (6 أرقام)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpKey = `otp:${email}`;

        // حفظ الرمز في الكاش لمدة 10 دقائق (600 ثانية)
        // ✅ استبدال redisClient.setEx بـ cache.setEx
        await cache.setEx(otpKey, 600, otp); 

        // ✅ استبدال incr و expire بـ get و setEx لـ Rate Limiting
        let newLimit = 1;
        if (currentLimit) {
            newLimit = parseInt(currentLimit) + 1;
        }
        // Set the new limit with a 24-hour expiration (86400 seconds)
        await cache.setEx(rateLimitKey, 86400, newLimit.toString()); 

        if (process.env.NODE_ENV === 'development') {
            console.log(`DEV MODE OTP for ${email}: ${otp}`);
            return res.status(200).json({ 
                message: 'OTP sent successfully (Dev Mode - Console)',
                method: 'console',
                otp: otp
            });
        }

        // إرسال عبر SendGrid
        const emailSent = await sendEmail(email, 'Tawal Academy OTP', `Your verification code is: ${otp}`);

        if (!emailSent) {
            console.error('SendGrid failed to send email. OTP:', otp);
            // ✅ إصلاح: عرض الرمز إذا فشل الإرسال ونحن لسنا في الإنتاج
            if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'prod') {
                return res.status(200).json({ 
                    message: 'OTP sent successfully (Fallback Dev Mode - Console)',
                    method: 'console',
                    otp: otp
                });
            }
            // إذا كنا في الإنتاج أو لم يكن هناك تصريح، نرجع الخطأ القياسي
            return res.status(500).json({ error: 'Failed to send OTP email' });
        }

        res.status(200).json({ message: 'OTP sent successfully' });

    } catch (err) {
        console.error('Error sending OTP:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 5.2 تسجيل طالب جديد
app.post('/api/students/register', async (req, res) => {
    const { name, email, fingerprint, otp } = req.body;
    
    // التحقق من صحة الإدخال
    const schema = Joi.object({
        name: Joi.string().min(3).required(),
        email: Joi.string().email().required(),
        fingerprint: Joi.string().required(),
        otp: Joi.string().length(6).required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    try {
        // التحقق من الرمز
        const otpKey = `otp:${email}`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const storedOtp = await cache.get(otpKey); 
        
        if (!storedOtp || storedOtp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        // التحقق من وجود الإيميل بالفعل
        const existing = await query('SELECT id, isblocked FROM students WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            if (existing.rows[0].isblocked) {
                return res.status(403).json({ error: 'Account is blocked' });
            }
            // إذا كان موجوداً، نعتبره "تحديث" بيانات/تفعيل دخول
            
            // حذف الرمز بعد استخدامه
            // ✅ استخدام cache.del بدلاً من redisClient.del
            await cache.del(otpKey); 
            
            const student = await getStudentById(existing.rows[0].id);
            return res.status(200).json(student);
        }

        // تسجيل الطالب الجديد
        const newStudent = await query(
            'INSERT INTO students (name, email, fingerprint) VALUES ($1, $2, $3) RETURNING id, name, email, progress',
            [name.trim(), email, fingerprint]
        );

        // حذف الرمز بعد استخدامه
        // ✅ استخدام cache.del بدلاً من redisClient.del
        await cache.del(otpKey); 

        // Log the new registration
        console.log(`🎉 New student registered: ${newStudent.rows[0].id} - ${name}`);

        res.status(201).json(newStudent.rows[0]);
    } catch (err) {
        console.error('Error registering student:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// 5.3 الحصول على بيانات الطالب للتحقق
app.get('/api/students/:id', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        const student = await getStudentById(studentId);
        if (!student) return res.status(404).json({ error: 'Student not found or deleted.' });
        
        if (student.isblocked) {
            return res.status(403).json({ error: 'Blocked: Account has been suspended.' });
        }

        res.status(200).json(student);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});


// =================================================================
// 6. نقاط نهاية الإحصائيات (Stats)
// =================================================================

// 6.1 الإحصائيات العامة (Public Stats)
app.get('/api/public-stats', async (req, res) => {
    try {
        const totalStudentsRes = await query('SELECT count(*) FROM students');
        const totalQuizzesRes = await query('SELECT count(*) FROM quiz_results');

        res.status(200).json({
            totalStudents: parseInt(totalStudentsRes.rows[0].count),
            totalQuizzes: parseInt(totalQuizzesRes.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6.2 إحصائيات الطالب
app.get('/api/students/:id/stats', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        // التحقق من الكاش
        const cacheKey = `student_stats:${studentId}`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const cachedStats = await cache.get(cacheKey); 
        if (cachedStats) {
            return res.status(200).json(JSON.parse(cachedStats));
        }

        const avgRes = await query('SELECT avg(score) as averageScore, max(score) as bestScore, count(*) as totalQuizzes FROM quiz_results WHERE student_id = $1', [studentId]);
        
        const stats = {
            averageScore: Math.round(parseFloat(avgRes.rows[0].averagescore) || 0),
            bestScore: parseInt(avgRes.rows[0].bestscore) || 0,
            totalQuizzes: parseInt(avgRes.rows[0].totalquizzes) || 0
        };
        
        // حفظ في الكاش
        // ✅ استخدام cache.setEx بدلاً من redisClient.setEx
        await cache.setEx(cacheKey, 3600, JSON.stringify(stats)); // كاش لمدة ساعة واحدة

        res.status(200).json(stats);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6.3 نتائج اختبارات الطالب
app.get('/api/students/:id/results', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        // التحقق من الكاش
        const cacheKey = `student_results:${studentId}`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const cachedResults = await cache.get(cacheKey); 
        if (cachedResults) {
            return res.status(200).json(JSON.parse(cachedResults));
        }

        const resultsRes = await query('SELECT * FROM quiz_results WHERE student_id = $1 ORDER BY created_at DESC', [studentId]);
        const results = resultsRes.rows;

        // حفظ في الكاش
        // ✅ استخدام cache.setEx بدلاً من redisClient.setEx
        await cache.setEx(cacheKey, 3600, JSON.stringify(results)); // كاش لمدة ساعة واحدة

        res.status(200).json(results);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6.4 حفظ نتائج الاختبار
app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, score, totalQuestions, correctAnswers, subjectId } = req.body;
    
    // التحقق من صحة الإدخال
    const schema = Joi.object({
        studentId: Joi.number().required(),
        quizName: Joi.string().required(),
        score: Joi.number().min(0).max(100).required(),
        totalQuestions: Joi.number().min(1).required(),
        correctAnswers: Joi.number().min(0).required(),
        subjectId: Joi.string().required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    try {
        await query(
            'INSERT INTO quiz_results (student_id, quiz_name, score, total_questions, correct_answers, subject_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [studentId, quizName, score, totalQuestions, correctAnswers, subjectId]
        );

        // تحديث progress في جدول students
        const studentRes = await query('SELECT progress FROM students WHERE id = $1 FOR UPDATE', [studentId]);
        const progress = studentRes.rows[0].progress || {};
        
        // تحديث أعلى درجة تم تحقيقها لهذا الموضوع/المستوى
        const currentMax = progress[subjectId] || 0;
        if (score > currentMax) {
             progress[subjectId] = score;
             await query('UPDATE students SET progress = $1 WHERE id = $2', [progress, studentId]);
        }
        
        // مسح كاش الإحصائيات والنتائج للطالب
        // ✅ استخدام cache.del بدلاً من redisClient.del
        await cache.del(`student_stats:${studentId}`); 
        // ✅ استخدام cache.del بدلاً من redisClient.del
        await cache.del(`student_results:${studentId}`); 

        res.status(201).json({ message: 'Result saved successfully' });
    } catch (err) {
        console.error('Error saving quiz result:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6.5 حالة الاختبارات (Quiz Lock Status)
app.get('/api/quiz-status', async (req, res) => {
    try {
        const cacheKey = `quiz_status_locks`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const cachedStatus = await cache.get(cacheKey); 
        if (cachedStatus) {
            return res.status(200).json(JSON.parse(cachedStatus));
        }

        // هنا يتم استرجاع حالة الإغلاق من قاعدة البيانات أو من ملف إعدادات
        // في هذا المثال، نفترض أن كل شيء مفتوح بشكل افتراضي
        const locks = {
            gis_networks: { locked: false, message: '' },
            transport: { locked: true, message: 'قريباً...' },
            geo_maps: { locked: false, message: '' },
            projections: { locked: false, message: '' },
            research: { locked: true, message: 'مغلق مؤقتاً' },
            surveying_texts: { locked: false, message: '' },
            arid_lands: { locked: false, message: '' }
        };

        // حفظ في الكاش لمدة 5 دقائق (300 ثانية)
        // ✅ استخدام cache.setEx بدلاً من redisClient.setEx
        await cache.setEx(cacheKey, 300, JSON.stringify(locks)); 

        res.status(200).json(locks);
    } catch (err) {
        console.error('Error fetching quiz status:', err);
        res.status(500).json({});
    }
});

// 6.6 تسجيل الدخول (Session Log)
app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    
    const schema = Joi.object({
        studentId: Joi.number().required(),
        fingerprint: Joi.string().required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Invalid data' });

    try {
        // تحديث البصمة في قاعدة البيانات
        await query('UPDATE students SET fingerprint = $1 WHERE id = $2', [fingerprint, studentId]);
        
        // التحقق من حدود تسجيل الدخول بالجهاز (Rate Limit)
        const rateLimitKey = `login_limit:${fingerprint}`;
        
        // ✅ استبدال incr و expire بـ get و setEx
        const loginCount = await cache.get(rateLimitKey); 
        let newLoginCount = 1;

        if (loginCount) {
            newLoginCount = parseInt(loginCount) + 1;
            if (newLoginCount > 100) { // حد أقصى 100 دخول للجهاز في الأسبوع
                return res.status(403).json({ error: 'Rate limit exceeded for this device.' });
            }
        } else {
            // If no count exists, it's 1
        }

        // Set the new count with a 7-day expiration (3600 * 24 * 7 seconds = 604800)
        await cache.setEx(rateLimitKey, 604800, newLoginCount.toString()); 

        res.status(200).json({ message: 'Login logged' });
    } catch (err) {
        console.error('Error logging login:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6.7 تسجيل الخروج (Logout)
app.post('/api/logout', async (req, res) => {
    const { studentId } = req.body;
    try {
        // يمكن هنا إضافة منطق لتسجيل وقت الخروج إذا لزم الأمر
        // حالياً، نكتفي بإرسال استجابة نجاح
        res.status(200).json({ message: 'Logout successful' });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 7. نقاط نهاية رسائل الدعم (Support Messages)
// =================================================================

// 7.1 إرسال رسالة دعم جديدة
app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;

    const schema = Joi.object({
        studentId: Joi.number().required(),
        message: Joi.string().min(5).max(500).required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    try {
        // التحقق من الحد اليومي (5 رسائل)
        const rateLimitKey = `msg_limit:${studentId}`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const messagesSent = await cache.get(rateLimitKey); 
        const sentCount = messagesSent ? parseInt(messagesSent) : 0;
        const LIMIT = 5;

        if (sentCount >= LIMIT) {
            return res.status(429).json({ error: 'Daily message limit exceeded (5 messages).' });
        }

        const resDb = await query(
            'INSERT INTO support_messages (student_id, content) VALUES ($1, $2) RETURNING created_at',
            [studentId, message]
        );
        
        // تحديث العداد في الكاش لمدة 24 ساعة (86400 ثانية)
        // ✅ استخدام cache.setEx بدلاً من redisClient.setEx
        await cache.setEx(rateLimitKey, 86400, (sentCount + 1).toString());

        res.status(201).json({ 
            message: 'Message sent successfully',
            remaining: LIMIT - (sentCount + 1),
            createdAt: resDb.rows[0].created_at
        });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 7.2 جلب رسائل الطالب السابقة
app.get('/api/students/:id/messages', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });
    
    try {
        // جلب الرسائل
        const messagesRes = await query('SELECT content, admin_reply as adminReply, created_at as createdAt FROM support_messages WHERE student_id = $1 ORDER BY created_at DESC', [studentId]);
        const messages = messagesRes.rows;

        // جلب الحد المتبقي اليومي
        const rateLimitKey = `msg_limit:${studentId}`;
        // ✅ استخدام cache.get بدلاً من redisClient.get
        const messagesSent = await cache.get(rateLimitKey);
        const sentCount = messagesSent ? parseInt(messagesSent) : 0;
        const LIMIT = 5;

        res.status(200).json({
            messages: messages,
            remaining: LIMIT - sentCount
        });
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 8. نقاط نهاية تتبع النشاط (Activity Logging)
// =================================================================

// 8.1 تسجيل النشاط
app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    
    // التحقق من صحة الإدخال
    const schema = Joi.object({
        studentId: Joi.number().required(),
        activityType: Joi.string().required(),
        subjectName: Joi.string().required()
    });
    const { error } = schema.validate(req.body);
    if (error) {
        // لا نرسل 400، نكتفي بالتسجيل في اللوغ وتجاهل الطلب
        console.warn('Invalid activity log data:', error.details[0].message);
        return res.status(200).json({ message: 'Log ignored due to invalid data' });
    }

    try {
        await query(
            'INSERT INTO activity_log (student_id, activity_type, subject_name) VALUES ($1, $2, $3)',
            [studentId, activityType, subjectName]
        );
        res.status(201).json({ message: 'Activity logged' });
    } catch (err) {
        console.error('Error logging activity:', err);
        // نرسل 200 لتجنب تعطيل الفرونت إند في حالة الفشل
        res.status(200).json({ message: 'Failed to log activity but request accepted' });
    }
});


// =================================================================
// 9. تشغيل السيرفر
// =================================================================

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    // التحقق من اتصال قاعدة البيانات عند البدء
    pool.query('SELECT NOW()')
        .then(res => console.log('✅ PostgreSQL Connected:', res.rows[0].now))
        .catch(err => console.error('❌ PostgreSQL Connection Failed:', err.stack));
});
