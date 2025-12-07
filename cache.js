/*
 * =================================================================================
 * CACHE.JS - Redis Connection Manager
 * =================================================================================
 */

require('dotenv').config();
const redis = require('redis');

// إعداد عميل Redis
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
    socket: {
        // محاولة إعادة الاتصال تلقائياً في حالة الانقطاع
        reconnectStrategy: (retries) => {
            console.log(`⚠️ [Redis] Reconnecting... attempt #${retries}`);
            if (retries > 10) return new Error('Redis connection retries exhausted');
            return Math.min(retries * 100, 3000); // الانتظار بين المحاولات
        }
    }
});

// التعامل مع أحداث الاتصال
redisClient.on('error', (err) => console.error('❌ [Redis Error]', err));
redisClient.on('connect', () => console.log('✅ [Redis] Connected successfully! 🚀'));

// بدء الاتصال فوراً عند تشغيل الملف
(async () => {
    try {
        await redisClient.connect();
    } catch (e) {
        console.error('❌ [Redis] Failed to connect initially:', e);
    }
})();

module.exports = redisClient;
