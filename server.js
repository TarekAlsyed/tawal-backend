/*
 * =================================================================================
 * SERVER.JS - COMPLETE FIXED VERSION
 * =================================================================================
 * ✅ جميع الـ Endpoints مكتملة
 * ✅ معالجة أخطاء الـ 500 و 404
 * ✅ دعم كامل للوحة التحكم
 */
require('dotenv').config();

// 1. الثوابت والإعدادات
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;

// 2. الملحقات
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const cors = require('cors');
const app = express();
const pool = new Pool({ connectionString: DB_URL });

// استيراد cache و email بشكل آمن
let cache, sendEmail;
try {
    cache = require('./cache');
    const emailModule = require('./email');
    sendEmail = emailModule.sendOTP || emailModule.sendEmail;
} catch (e) {
    console.warn('⚠️ Cache or Email module not found, using fallback');
    // Fallback cache
    cache = {
        get: async () => null,
        setEx: async () => 'OK',
        del: async () => 1
    };
    // Fallback email
    sendEmail = async (email, otp) => {
        console.log(`📧 DEV MODE - OTP for ${email}: ${otp}`);
        return { success: true, method: 'console', otp };
    };
}

// 3. إعداد CORS
const allowedOrigins = [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'https://tawal-academy.vercel.app'
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || 
            origin.endsWith('.vercel.app') || 
            origin.endsWith('.github.io')) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
    },
    optionsSuccessStatus: 200
}));

app.use(express.json());

// =================================================================
// 4. دوال مساعدة
// =================================================================
async function query(text, params) {
    try {
        const res = await pool.query(text, params);
        return res;
    } catch (err) {
        console.error('Database Query Error:', err.stack);
        throw err;
    }
}

async function getStudentById(studentId) {
    const res = await query(
        'SELECT id, name, email, progress, isblocked FROM students WHERE id = $1',
        [studentId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

// =================================================================
// 5. نقاط نهاية Authentication
// =================================================================

// 5.1 إرسال OTP
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    
    const schema = Joi.object({
        email: Joi.string().email().required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    try {
        const rateLimitKey = `otp_limit:${email}`;
        const currentLimit = await cache.get(rateLimitKey);
        
        if (currentLimit && parseInt(currentLimit) >= 5) {
            return res.status(429).json({ error: 'Too many OTP requests today' });
        }
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpKey = `otp:${email}`;

        await cache.setEx(otpKey, 600, otp);

        let newLimit = 1;
        if (currentLimit) {
            newLimit = parseInt(currentLimit) + 1;
        }
        await cache.setEx(rateLimitKey, 86400, newLimit.toString());

        if (process.env.NODE_ENV === 'development') {
            console.log(`🔐 DEV MODE OTP for ${email}: ${otp}`);
            return res.status(200).json({ 
                message: 'OTP sent successfully (Dev Mode)',
                method: 'console',
                otp: otp
            });
        }

        const emailResult = await sendEmail(email, otp);

        if (!emailResult.success) {
            if (process.env.NODE_ENV !== 'production') {
                return res.status(200).json({ 
                    message: 'OTP sent successfully (Fallback)',
                    method: 'console',
                    otp: otp
                });
            }
            return res.status(500).json({ error: 'Failed to send OTP' });
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
    
    const schema = Joi.object({
        name: Joi.string().min(3).required(),
        email: Joi.string().email().required(),
        fingerprint: Joi.string().required(),
        otp: Joi.string().length(6).required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    try {
        const otpKey = `otp:${email}`;
        const storedOtp = await cache.get(otpKey);
        
        if (!storedOtp || storedOtp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        const existing = await query('SELECT id, isblocked FROM students WHERE email = $1', [email]);
        
        if (existing.rows.length > 0) {
            if (existing.rows[0].isblocked) {
                return res.status(403).json({ error: 'Account is blocked' });
            }
            await cache.del(otpKey);
            const student = await getStudentById(existing.rows[0].id);
            return res.status(200).json(student);
        }

        const newStudent = await query(
            'INSERT INTO students (name, email, fingerprint) VALUES ($1, $2, $3) RETURNING id, name, email, progress',
            [name.trim(), email, fingerprint]
        );

        await cache.del(otpKey);

        console.log(`🎉 New student: ${newStudent.rows[0].id} - ${name}`);

        res.status(201).json(newStudent.rows[0]);
    } catch (err) {
        console.error('Error registering:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 5.3 الحصول على بيانات الطالب
app.get('/api/students/:id', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        const student = await getStudentById(studentId);
        if (!student) return res.status(404).json({ error: 'Student not found' });
        
        if (student.isblocked) {
            return res.status(403).json({ error: 'Account blocked' });
        }

        res.status(200).json(student);
    } catch (err) {
        console.error('Error fetching student:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 6. نقاط نهاية الإحصائيات (Stats)
// =================================================================

app.get('/api/public-stats', async (req, res) => {
    try {
        const totalStudentsRes = await query('SELECT count(*) FROM students');
        const totalQuizzesRes = await query('SELECT count(*) FROM quiz_results');

        res.status(200).json({
            totalStudents: parseInt(totalStudentsRes.rows[0].count),
            totalQuizzes: parseInt(totalQuizzesRes.rows[0].count)
        });
    } catch (err) {
        console.error('Error fetching public stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/students/:id/stats', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        const cacheKey = `student_stats:${studentId}`;
        const cachedStats = await cache.get(cacheKey);
        if (cachedStats) {
            return res.status(200).json(JSON.parse(cachedStats));
        }

        const avgRes = await query(
            'SELECT avg(score) as averageScore, max(score) as bestScore, count(*) as totalQuizzes FROM quiz_results WHERE student_id = $1',
            [studentId]
        );
        
        const stats = {
            averageScore: Math.round(parseFloat(avgRes.rows[0].averagescore) || 0),
            bestScore: parseInt(avgRes.rows[0].bestscore) || 0,
            totalQuizzes: parseInt(avgRes.rows[0].totalquizzes) || 0
        };
        
        await cache.setEx(cacheKey, 3600, JSON.stringify(stats));

        res.status(200).json(stats);
    } catch (err) {
        console.error('Error fetching student stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/students/:id/results', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });

    try {
        const cacheKey = `student_results:${studentId}`;
        const cachedResults = await cache.get(cacheKey);
        if (cachedResults) {
            return res.status(200).json(JSON.parse(cachedResults));
        }

        const resultsRes = await query(
            'SELECT * FROM quiz_results WHERE student_id = $1 ORDER BY created_at DESC',
            [studentId]
        );
        const results = resultsRes.rows;

        await cache.setEx(cacheKey, 3600, JSON.stringify(results));

        res.status(200).json(results);
    } catch (err) {
        console.error('Error fetching results:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/quiz-results', async (req, res) => {
    const { studentId, quizName, score, totalQuestions, correctAnswers, subjectId } = req.body;
    
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

        const studentRes = await query('SELECT progress FROM students WHERE id = $1 FOR UPDATE', [studentId]);
        const progress = studentRes.rows[0].progress || {};
        
        const currentMax = progress[subjectId] || 0;
        if (score > currentMax) {
            progress[subjectId] = score;
            await query('UPDATE students SET progress = $1 WHERE id = $2', [progress, studentId]);
        }
        
        await cache.del(`student_stats:${studentId}`);
        await cache.del(`student_results:${studentId}`);

        res.status(201).json({ message: 'Result saved successfully' });
    } catch (err) {
        console.error('Error saving quiz result:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/quiz-status', async (req, res) => {
    try {
        const cacheKey = `quiz_status_locks`;
        const cachedStatus = await cache.get(cacheKey);
        if (cachedStatus) {
            return res.status(200).json(JSON.parse(cachedStatus));
        }

        const locks = {
            gis_networks: { locked: false, message: '' },
            transport: { locked: false, message: '' },
            geo_maps: { locked: false, message: '' },
            projections: { locked: false, message: '' },
            research: { locked: false, message: '' },
            surveying_texts: { locked: false, message: '' },
            arid_lands: { locked: false, message: '' }
        };

        await cache.setEx(cacheKey, 300, JSON.stringify(locks));

        res.status(200).json(locks);
    } catch (err) {
        console.error('Error fetching quiz status:', err);
        res.status(500).json({});
    }
});

app.post('/api/login', async (req, res) => {
    const { studentId, fingerprint } = req.body;
    
    const schema = Joi.object({
        studentId: Joi.number().required(),
        fingerprint: Joi.string().required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Invalid data' });

    try {
        await query('UPDATE students SET fingerprint = $1 WHERE id = $2', [fingerprint, studentId]);
        
        const rateLimitKey = `login_limit:${fingerprint}`;
        const loginCount = await cache.get(rateLimitKey);
        let newLoginCount = 1;

        if (loginCount) {
            newLoginCount = parseInt(loginCount) + 1;
            if (newLoginCount > 100) {
                return res.status(403).json({ error: 'Rate limit exceeded' });
            }
        }

        await cache.setEx(rateLimitKey, 604800, newLoginCount.toString());

        res.status(200).json({ message: 'Login logged' });
    } catch (err) {
        console.error('Error logging login:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        res.status(200).json({ message: 'Logout successful' });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 7. رسائل الدعم (Messages)
// =================================================================

app.post('/api/messages', async (req, res) => {
    const { studentId, message } = req.body;

    const schema = Joi.object({
        studentId: Joi.number().required(),
        message: Joi.string().min(5).max(500).required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    try {
        const rateLimitKey = `msg_limit:${studentId}`;
        const messagesSent = await cache.get(rateLimitKey);
        const sentCount = messagesSent ? parseInt(messagesSent) : 0;
        const LIMIT = 5;

        if (sentCount >= LIMIT) {
            return res.status(429).json({ error: 'Daily message limit exceeded' });
        }

        const resDb = await query(
            'INSERT INTO support_messages (student_id, content) VALUES ($1, $2) RETURNING created_at',
            [studentId, message]
        );
        
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

app.get('/api/students/:id/messages', async (req, res) => {
    const studentId = parseInt(req.params.id);
    if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid ID' });
    
    try {
        const messagesRes = await query(
            'SELECT content, admin_reply as adminReply, created_at as createdAt FROM support_messages WHERE student_id = $1 ORDER BY created_at DESC',
            [studentId]
        );
        const messages = messagesRes.rows;

        const rateLimitKey = `msg_limit:${studentId}`;
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
// 8. تتبع النشاط (Activity Logging)
// =================================================================

app.post('/api/log-activity', async (req, res) => {
    const { studentId, activityType, subjectName } = req.body;
    
    const schema = Joi.object({
        studentId: Joi.number().required(),
        activityType: Joi.string().required(),
        subjectName: Joi.string().required()
    });
    const { error } = schema.validate(req.body);
    if (error) {
        console.warn('Invalid activity log:', error.details[0].message);
        return res.status(200).json({ message: 'Log ignored' });
    }

    try {
        await query(
            'INSERT INTO activity_log (student_id, activity_type, subject_name) VALUES ($1, $2, $3)',
            [studentId, activityType, subjectName]
        );
        res.status(201).json({ message: 'Activity logged' });
    } catch (err) {
        console.error('Error logging activity:', err);
        res.status(200).json({ message: 'Failed to log but accepted' });
    }
});

// =================================================================
// 9. ✅ ADMIN ENDPOINTS (المفقودة في الكود القديم)
// =================================================================

// 9.1 إحصائيات الإدارة
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalStudents = await query('SELECT COUNT(*) as count FROM students');
        const totalQuizzes = await query('SELECT COUNT(*) as count FROM quiz_results');
        const avgScore = await query('SELECT AVG(score) as avg FROM quiz_results');

        res.status(200).json({
            totalStudents: parseInt(totalStudents.rows[0].count) || 0,
            totalQuizzes: parseInt(totalQuizzes.rows[0].count) || 0,
            averageScore: Math.round(parseFloat(avgScore.rows[0].avg)) || 0
        });
    } catch (err) {
        console.error('Error fetching admin stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9.2 جميع الطلاب
app.get('/api/admin/students', async (req, res) => {
    try {
        const students = await query(
            'SELECT id, name, email, createdat, isblocked FROM students ORDER BY createdat DESC'
        );
        res.status(200).json(students.rows);
    } catch (err) {
        console.error('Error fetching students:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9.3 الرسائل للإدارة
app.get('/api/admin/messages', async (req, res) => {
    try {
        const messages = await query(`
            SELECT 
                sm.id, 
                sm.content, 
                sm.admin_reply as adminreply,
                sm.created_at as createdat,
                s.name as studentName
            FROM support_messages sm
            JOIN students s ON sm.student_id = s.id
            ORDER BY sm.created_at DESC
            LIMIT 50
        `);
        res.status(200).json(messages.rows);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9.4 سجلات النشاط
app.get('/api/admin/activity-logs', async (req, res) => {
    try {
        const logs = await query(`
            SELECT 
                al.activity_type as activitytype,
                al.subject_name as subjectname,
                al.timestamp,
                s.name as studentName
            FROM activity_log al
            JOIN students s ON al.student_id = s.id
            ORDER BY al.timestamp DESC
            LIMIT 100
        `);
        res.status(200).json(logs.rows);
    } catch (err) {
        console.error('Error fetching activity logs:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9.5 سجلات الدخول
app.get('/api/admin/login-logs', async (req, res) => {
    try {
        const logs = await query(`
            SELECT 
                ll.logintime,
                ll.logouttime,
                s.name
            FROM login_logs ll
            JOIN students s ON ll.student_id = s.id
            ORDER BY ll.logintime DESC
            LIMIT 100
        `);
        res.status(200).json(logs.rows);
    } catch (err) {
        console.error('Error fetching login logs:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 10. تشغيل السيرفر
// =================================================================

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    pool.query('SELECT NOW()')
        .then(res => console.log('✅ PostgreSQL Connected:', res.rows[0].now))
        .catch(err => console.error('❌ PostgreSQL Failed:', err.stack));
});
