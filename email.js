/*
 * =================================================================================
 * EMAIL.JS - Version 25.0.0 (SENDGRID INTEGRATION)
 * =================================================================================
 */

require('dotenv').config();
const sgMail = require('@sendgrid/mail');

// ضبط مفتاح API الخاص بـ SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendOTP = async (toEmail, otpCode) => {
    console.log(`📧 [SendGrid] Preparing to send OTP to ${toEmail}...`);

    const msg = {
        to: toEmail,
        // هذا الإيميل يجب أن يكون هو نفسه المفعل في SendGrid (Sender Authentication)
        from: process.env.SENDGRID_VERIFIED_EMAIL, 
        subject: '🔐 رمز التحقق الخاص بك (Tawal Academy)',
        html: `
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #f4f4f4;">
                <div style="background-color: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: auto; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h2 style="color: #2c3e50; margin-bottom: 10px;">مرحباً بك في Tawal Academy</h2>
                    <p style="color: #666; font-size: 16px;">لإكمال تسجيل الدخول، استخدم رمز التحقق التالي:</p>
                    
                    <div style="background-color: #e8f0fe; border: 2px dashed #4a90e2; padding: 20px; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333; margin: 30px 0; border-radius: 8px;">
                        ${otpCode}
                    </div>
                    
                    <p style="color: #999; font-size: 12px;">هذا الرمز صالح لمدة 10 دقائق فقط.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #aaa; font-size: 11px;">إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة.</p>
                </div>
            </div>
        `
    };

    try {
        await sgMail.send(msg);
        console.log(`✅ [SendGrid] Email sent successfully to ${toEmail}`);
        return true;
    } catch (error) {
        console.error('❌ [SendGrid Error]:', error);

        if (error.response) {
            console.error('👉 Error Body:', error.response.body);
        }
        return false;
    }
};

module.exports = { sendOTP };
