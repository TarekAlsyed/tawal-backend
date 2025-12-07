/*
 * =================================================================================
 * EMAIL.JS - Resend API Version (Fast & Secure)
 * =================================================================================
 */

require('dotenv').config();
const { Resend } = require('resend');

// تهيئة مكتبة Resend
const resend = new Resend(process.env.RESEND_API_KEY);

const sendOTP = async (toEmail, otpCode) => {
    console.log(`📧 [Resend] Attempting to send OTP to ${toEmail}...`);

    try {
        const data = await resend.emails.send({
            // ⚠️ ملاحظة: في الخطة المجانية، يمكنك الإرسال فقط إلى بريدك الإلكتروني الذي سجلت به
            // لكي ترسل للطلاب، يجب توثيق الدومين الخاص بك في Resend
            // أو استخدم 'onboarding@resend.dev' كمرسل (للتجربة فقط)
            from: 'Tawal Academy <onboarding@resend.dev>', 
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
                    </div>
                </div>
            `
        });

        if (data.error) {
            console.error('❌ Resend API Error:', data.error);
            return false;
        }

        console.log(`✅ OTP sent successfully via Resend. ID: ${data.data.id}`);
        return true;

    } catch (error) {
        console.error('❌ Resend Connection Error:', error);
        return false;
    }
};

module.exports = { sendOTP };
