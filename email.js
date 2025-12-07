/*
 * =================================================================================
 * EMAIL.JS - Version 22.0.1 (FIXED: IPv4 Forced + Timeout Fix)
 * =================================================================================
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

// 🔥 إعداد Gmail مع خيارات محسّنة + إجبار IPv4
const createGmailTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, 
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS 
        },
        tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
        },
        // 🔥🔥🔥 إصلاح مشكلة Timeout في Railway 🔥🔥🔥
        family: 4, // يجبر النظام على استخدام IPv4 بدلاً من IPv6
        connectionTimeout: 20000, // زيادة وقت الانتظار لـ 20 ثانية
        greetingTimeout: 10000,
        socketTimeout: 20000
    });
};

// 🔥 Fallback: محاولة Port 465 إذا فشل 587
const createGmailSecureTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        // 🔥🔥🔥 إصلاح مشكلة Timeout هنا أيضاً 🔥🔥🔥
        family: 4, 
        connectionTimeout: 20000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });
};

const sendOTP = async (toEmail, otpCode) => {
    console.log(`📧 Attempting to send OTP to ${toEmail}...`);
    
    const mailOptions = {
        from: `"Tawal Academy Support" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: '🔐 رمز التحقق الخاص بك (Tawal Academy)',
        html: `
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #f4f4f4;">
                <div style="background-color: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: auto;">
                    <h2 style="color: #2c3e50;">مرحباً بك في Tawal Academy</h2>
                    <p style="color: #555;">لإكمال تسجيل الدخول، يرجى استخدام رمز التحقق التالي:</p>
                    <div style="background-color: #eee; padding: 15px; font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #333; margin: 20px 0;">
                        ${otpCode}
                    </div>
                    <p style="color: #999; font-size: 12px;">هذا الرمز صالح لمدة 10 دقائق فقط.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #aaa; font-size: 11px;">إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة.</p>
                </div>
            </div>
        `
    };

    // المحاولة الأولى: Port 587 (TLS)
    try {
        const transporter = createGmailTransporter();
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ [Gmail TLS] OTP sent to ${toEmail}: ${info.messageId}`);
        return true;
    } catch (error587) {
        console.warn(`⚠️ [Gmail TLS Failed] ${error587.message}`);
        console.log('🔄 Trying fallback: Port 465 (SSL)...');
        
        // المحاولة الثانية: Port 465 (SSL)
        try {
            const secureTransporter = createGmailSecureTransporter();
            const info = await secureTransporter.sendMail(mailOptions);
            console.log(`✅ [Gmail SSL] OTP sent to ${toEmail}: ${info.messageId}`);
            return true;
        } catch (error465) {
            console.error('❌ [Gmail SSL Also Failed]', error465.message);
            console.error('❌ Full Error:', error465);
            return false;
        }
    }
};

module.exports = { sendOTP };
