/*
 * =================================================================================
 * EMAIL.JS - Version 25.0.2 (FINAL FIX - 100% Working)
 * =================================================================================
 */

require('dotenv').config();
const sgMail = require('@sendgrid/mail');

// التحقق من وجود المتغيرات المطلوبة
if (!process.env.SENDGRID_API_KEY) {
    console.error('❌ [SendGrid] MISSING: SENDGRID_API_KEY in environment variables!');
    console.error('   Add it in Railway Dashboard → Variables');
    process.exit(1);
}

if (!process.env.SENDGRID_VERIFIED_EMAIL) {
    console.error('❌ [SendGrid] MISSING: SENDGRID_VERIFIED_EMAIL in environment variables!');
    console.error('   Add it in Railway Dashboard → Variables');
    process.exit(1);
}

// ضبط API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendOTP = async (toEmail, otpCode) => {
    console.log(`📧 [SendGrid] Preparing email for ${toEmail}...`);
    console.log(`   OTP Code: ${otpCode}`);
    console.log(`   From: ${process.env.SENDGRID_VERIFIED_EMAIL}`);

    const msg = {
        to: toEmail,
        from: {
            email: process.env.SENDGRID_VERIFIED_EMAIL,
            name: 'Tawal Academy'
        },
        subject: '🔐 رمز التحقق - Tawal Academy',
        html: `
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin: 0; padding: 0; font-family: 'Cairo', Arial, sans-serif; background-color: #f4f4f4;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                        <td align="center" style="padding: 40px 20px;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                                
                                <!-- Header -->
                                <tr>
                                    <td style="padding: 30px 40px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px 12px 0 0;">
                                        <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                                            🎓 Tawal Academy
                                        </h1>
                                    </td>
                                </tr>

                                <!-- Body -->
                                <tr>
                                    <td style="padding: 40px;">
                                        <h2 style="margin: 0 0 20px 0; color: #2c3e50; font-size: 24px; text-align: center;">
                                            مرحباً بك! 👋
                                        </h2>
                                        
                                        <p style="margin: 0 0 30px 0; color: #666666; font-size: 16px; line-height: 1.6; text-align: center;">
                                            لإكمال عملية التسجيل، يرجى استخدام رمز التحقق التالي:
                                        </p>

                                        <!-- OTP Box -->
                                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                                            <tr>
                                                <td align="center" style="padding: 20px 0;">
                                                    <div style="display: inline-block; background: linear-gradient(135deg, #e8f0fe 0%, #f3e7ff 100%); border: 3px dashed #667eea; border-radius: 12px; padding: 25px 50px;">
                                                        <span style="font-size: 42px; font-weight: 800; letter-spacing: 12px; color: #667eea; font-family: 'Courier New', monospace;">
                                                            ${otpCode}
                                                        </span>
                                                    </div>
                                                </td>
                                            </tr>
                                        </table>

                                        <p style="margin: 30px 0 0 0; color: #999999; font-size: 14px; text-align: center;">
                                            ⏰ هذا الرمز صالح لمدة <strong>10 دقائق</strong> فقط
                                        </p>
                                    </td>
                                </tr>

                                <!-- Footer -->
                                <tr>
                                    <td style="padding: 30px 40px; background-color: #f8f9fa; border-radius: 0 0 12px 12px; text-align: center;">
                                        <p style="margin: 0 0 10px 0; color: #999999; font-size: 12px;">
                                            إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة
                                        </p>
                                        <p style="margin: 0; color: #cccccc; font-size: 11px;">
                                            © 2025 Tawal Academy - جميع الحقوق محفوظة
                                        </p>
                                    </td>
                                </tr>

                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `,
        text: `
مرحباً بك في Tawal Academy!

رمز التحقق الخاص بك هو: ${otpCode}

هذا الرمز صالح لمدة 10 دقائق فقط.

إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة.

© 2025 Tawal Academy
        `.trim()
    };

    try {
        const result = await sgMail.send(msg);
        
        console.log('✅ [SendGrid] Email sent successfully!');
        console.log(`   Status: ${result[0].statusCode}`);
        console.log(`   Message ID: ${result[0].headers['x-message-id']}`);
        
        return true;
        
    } catch (error) {
        console.error('❌ [SendGrid] Failed to send email!');
        console.error('   Error:', error.message);

        if (error.response) {
            console.error('   HTTP Status:', error.response.statusCode);
            console.error('   Response Body:', JSON.stringify(error.response.body, null, 2));
            
            // شرح الأخطاء الشائعة
            const statusCode = error.response.statusCode;
            
            if (statusCode === 401) {
                console.error('   🔴 CAUSE: Invalid API Key');
                console.error('   💡 FIX: Check SENDGRID_API_KEY in Railway Variables');
            } else if (statusCode === 403) {
                console.error('   🔴 CAUSE: Email not verified in SendGrid');
                console.error('   💡 FIX: Verify sender in SendGrid Dashboard');
            } else if (statusCode === 400) {
                console.error('   🔴 CAUSE: Invalid email format or blocked recipient');
            }
        }
        
        return false;
    }
};

module.exports = { sendOTP };
