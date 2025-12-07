/*
 * =================================================================================
 * VALIDATION.JS - Input Validation Schemas (Updated for OTP)
 * =================================================================================
 */

const Joi = require('joi');

const validateRequest = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body);
        if (error) {
            return res.status(400).json({ 
                error: `Validation Error: ${error.details[0].message.replace(/"/g, '')}` 
            });
        }
        next();
    };
};

const schemas = {
    // 1. طلب رمز OTP (جديد)
    otpRequest: Joi.object({
        email: Joi.string().email().required().trim().messages({
            'string.email': 'Invalid email format',
            'any.required': 'Email is required'
        })
    }),

    // 2. تسجيل طالب جديد (تم التحديث لإضافة OTP)
    studentRegister: Joi.object({
        name: Joi.string().min(3).max(50).required().trim(),
        email: Joi.string().email().required().trim(),
        fingerprint: Joi.string().optional().allow(''),
        // 🔥 حقل جديد: كود التحقق إجباري ومكون من 6 أرقام
        otp: Joi.string().length(6).pattern(/^[0-9]+$/).required().messages({
            'string.length': 'OTP must be 6 digits',
            'string.pattern.base': 'OTP must be numbers only',
            'any.required': 'OTP code is required'
        })
    }),

    // باقي القواعد كما هي...
    adminLogin: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
    }),

    message: Joi.object({
        studentId: Joi.number().integer().required(),
        message: Joi.string().min(2).max(500).required().trim()
    }),

    quizResult: Joi.object({
        studentId: Joi.number().integer().required(),
        quizName: Joi.string().required(),
        subjectId: Joi.string().optional().allow(''),
        score: Joi.number().integer().min(0).required(),
        totalQuestions: Joi.number().integer().min(1).required(),
        correctAnswers: Joi.number().integer().min(0).required()
    }),

    activityLog: Joi.object({
        studentId: Joi.number().integer().required(),
        activityType: Joi.string().required(),
        subjectName: Joi.string().optional().allow('')
    }),

    fingerprintCheck: Joi.object({
        fingerprint: Joi.string().required()
    })
};

module.exports = { validateRequest, schemas };
