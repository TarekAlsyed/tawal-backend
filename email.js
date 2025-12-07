/*
 * =================================================================================
 * EMAIL.JS - Email Sending Service (Using Nodemailer)
 * =================================================================================
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

// إعداد الناقل (Transporter) باستخدام Gmail
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // إيميلك
        pass: process.env.EMAIL_PASS  // كلمة سر التطبيقات (App Password)
    }
});

// دالة إرسال رمز التحقق (OTP)
const sendOTP = async (toEmail, otpCode) => {
    try {
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

        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 [Email] OTP sent to ${toEmail}: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('❌ [Email Error]', error);
        return false;
    }
};

module.exports = { sendOTP };
