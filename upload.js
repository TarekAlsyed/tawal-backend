/*
 * =================================================================================
 * UPLOAD.JS - File Upload Service (Cloudinary + Multer)
 * =================================================================================
 */

require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');

// 1. إعداد Cloudinary بالمفاتيح
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. إعداد Multer (تخزين مؤقت في الذاكرة)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // الحد الأقصى 5 ميجا للملف
});

// 3. دالة الرفع المساعدة (Stream Upload)
const uploadToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "tawal_academy_assets" }, // اسم المجلد في Cloudinary
            (error, result) => {
                if (result) {
                    resolve(result);
                } else {
                    reject(error);
                }
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

module.exports = { upload, uploadToCloudinary };
