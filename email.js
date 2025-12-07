/*
 * =================================================================================
 * EMAIL.JS - Version 22.0.0 (FIXED: Gmail with Multiple Fallbacks)
 * =================================================================================
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

// 🔥 إعداد Gmail مع خيارات محسّنة
const createGmailTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com', // صريح
        port: 587, // TLS
        secure: false, // false for port 587
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS // ⚠️ يجب أن يكون App Password
        },
        tls: {
            rejectUnauthorized: false, // للسماح بشهادات Self-signed
            ciphers: 'SSLv3'
        },
        connectionTimeout: 10000, // 10 ثواني
        greetingTimeout: 5000,
        socketTimeout: 15000
    });
};

// 🔥 Fallback: محاولة Port 465 إذا فشل 587
const createGmailSecureTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 465, // SSL
        secure: true, // true for 465
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 10000
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

/*
 * =================================================================================
 * 📝 خطوات إصلاح Gmail:
 * =================================================================================
 * * ⚠️ المشكلة الأساسية: Gmail يحظر "Less Secure Apps" منذ 2022
 * * ✅ الحل الوحيد: استخدام "App Password"
 * * خطوات الحصول على App Password:
 * * 1. اذهب إلى: https://myaccount.google.com/
 * 2. اختر "Security" من القائمة اليسرى
 * 3. فعّل "2-Step Verification" (إذا لم يكن مفعلاً)
 * 4. بعد التفعيل، ارجع إلى "Security"
 * 5. ابحث عن "App passwords" (كلمات مرور التطبيقات)
 * 6. اختر "Select app" → Other (Custom name)
 * 7. اكتب: "Tawal Academy"
 * 8. اضغط "Generate"
 * 9. انسخ الكلمة المكونة من 16 حرف (مثلاً: abcd efgh ijkl mnop)
 * 10. في Railway Variables:
 * EMAIL_USER=youremail@gmail.com
 * EMAIL_PASS=abcdefghijklmnop  (بدون مسافات!)
 * * ⚠️ تحذير: إذا فشل هذا أيضاً، استخدم SendGrid (الحل 1)
 * * =================================================================================
 */
