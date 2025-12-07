/*
 * =================================================================================
 * VALIDATION.JS - Input Validation Schemas using Joi
 * =================================================================================
 */

const Joi = require('joi');

// دالة وسيطة (Middleware) لفحص البيانات
const validateRequest = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body);
        if (error) {
            // إذا كانت البيانات غير صالحة، نرفض الطلب فوراً
            return res.status(400).json({ 
                error: `Validation Error: ${error.details[0].message.replace(/"/g, '')}` 
            });
        }
        next();
    };
};

// تعريف قواعد البيانات (Schemas)
const schemas = {
    // 1. تسجيل طالب جديد
    studentRegister: Joi.object({
        name: Joi.string().min(3).max(50).required().trim().messages({
            'string.min': 'Name must be at least 3 characters',
            'string.max': 'Name cannot exceed 50 characters',
            'any.required': 'Name is required'
        }),
        email: Joi.string().email().required().trim().messages({
            'string.email': 'Invalid email format',
            'any.required': 'Email is required'
        }),
        fingerprint: Joi.string().optional().allow('')
    }),

    // 2. تسجيل دخول الأدمن
    adminLogin: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
    }),

    // 3. إرسال رسالة دعم
    message: Joi.object({
        studentId: Joi.number().integer().required(),
        message: Joi.string().min(2).max(500).required().trim()
    }),

    // 4. حفظ نتيجة اختبار
    quizResult: Joi.object({
        studentId: Joi.number().integer().required(),
        quizName: Joi.string().required(),
        subjectId: Joi.string().optional().allow(''),
        score: Joi.number().integer().min(0).required(),
        totalQuestions: Joi.number().integer().min(1).required(),
        correctAnswers: Joi.number().integer().min(0).required()
    }),

    // 5. تسجيل نشاط
    activityLog: Joi.object({
        studentId: Joi.number().integer().required(),
        activityType: Joi.string().required(),
        subjectName: Joi.string().optional().allow('')
    }),

    // 6. التحقق من البصمة
    fingerprintCheck: Joi.object({
        fingerprint: Joi.string().required()
    })
};

module.exports = { validateRequest, schemas };
