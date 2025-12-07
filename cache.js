/*
 * =================================================================================
 * CACHE.JS - Redis Connection Manager
 * =================================================================================
 * 🔥 تم تطبيق الإصلاحات الحرجة للمشاكل التالية:
 * 1. مشكلة Redis Connection يفشل أحياناً - تم إضافة Fallback Memory Cache و Retry Logic أقوى (حتى 20 محاولة).
 * 2. تم استبدال `module.exports` ليصدر الدوال الآمنة (safeGet, safeSetEx, safeDel) بدلاً من client.
 */
require('dotenv').config();
const redis = require('redis');
// ✅ إضافة Fallback Memory Cache
let memoryCache = {};
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
    socket: {
        // ✅ تحديث استراتيجية إعادة الاتصال: محاولات أكثر وتأخير تدريجي
        reconnectStrategy: (retries) => {
            console.log(`⚠️ Redis reconnecting... #${retries}`);
            if (retries > 20) {
                console.error('❌ Redis failed. Using memory cache.');
                return new Error('Redis exhausted');
            }
            return Math.min(retries * 500, 5000);
        }
    }
});
let redisReady = false;
// التعامل مع أحداث الاتصال
redisClient.on('error', (err) => {
    console.error('❌ Redis Error:', err.message);
    redisReady = false;
});
redisClient.on('connect', () => {
    console.log('✅ Redis Connected!');
    redisReady = true;
});
// بدء الاتصال فوراً عند تشغيل الملف مع معالجة الخطأ
(async () => {
    try {
        await redisClient.connect();
    } catch (e) {
        console.error('❌ Redis initial connection failed');
        redisReady = false;
    }
})();
// ✅ Wrapper Functions مع Fallback للذاكرة
const safeGet = async (key) => {
    // إذا لم يكن Redis جاهزاً، استخدم الذاكرة
    if (!redisReady) return memoryCache[key] || null;
    try {
        return await redisClient.get(key);
    } catch (e) {
        // في حالة فشل عملية Get مع Redis، نستخدم الذاكرة كـ Fallback
        return memoryCache[key] || null;
    }
};
const safeSetEx = async (key, seconds, value) => {
    // إذا لم يكن Redis جاهزاً، استخدم الذاكرة
    if (!redisReady) {
        memoryCache[key] = value;
        // قم بإزالة المفتاح من الذاكرة بعد انتهاء الصلاحية
        setTimeout(() => delete memoryCache[key], seconds * 1000);
        return 'OK';
    }
    try {
        return await redisClient.setEx(key, seconds, value);
    } catch (e) {
        // في حالة فشل عملية SetEx مع Redis، نستخدم الذاكرة كـ Fallback
        memoryCache[key] = value;
        return 'OK';
    }
};
const safeDel = async (key) => {
    // إذا لم يكن Redis جاهزاً، احذف من الذاكرة فقط
    if (!redisReady) {
        delete memoryCache[key];
        return 1;
    }
    try {
        return await redisClient.del(key);
    } catch (e) {
        // في حالة فشل عملية Del مع Redis، احذف من الذاكرة كـ Fallback
        delete memoryCache[key];
        return 1;
    }
};
// ✅ تصدير الدوال الجديدة بدلاً من العميل نفسه
module.exports = {
    get: safeGet,
    setEx: safeSetEx,
    del: safeDel,
    isReady: () => redisReady
};
