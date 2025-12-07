/*
 * =================================================================================
 * DATABASE.JS - Database Connection & Schema Management
 * =================================================================================
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Database Initialization
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Checking tables & connection...');
        
        // 1. Students table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY, 
                name TEXT NOT NULL, 
                email TEXT UNIQUE, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                isBlocked BOOLEAN DEFAULT FALSE
            )
        `);
        
        // 2. Quiz results table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_results (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                quizName TEXT NOT NULL, 
                subjectId TEXT, 
                score INTEGER NOT NULL, 
                totalQuestions INTEGER NOT NULL, 
                correctAnswers INTEGER NOT NULL, 
                completedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 3. Messages table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                content TEXT NOT NULL, 
                adminReply TEXT, 
                isRead BOOLEAN DEFAULT FALSE, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 4. Login logs table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                loginTime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                logoutTime TIMESTAMPTZ
            )
        `);
        
        // 5. Activity logs table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                activityType TEXT NOT NULL, 
                subjectName TEXT, 
                score INTEGER,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 6. Student fingerprints table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY, 
                studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                fingerprint TEXT NOT NULL, 
                lastSeen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                UNIQUE(studentId, fingerprint)
            )
        `);
        
        // 7. Blocked fingerprints table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY, 
                fingerprint TEXT UNIQUE NOT NULL, 
                reason TEXT, 
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 8. Quiz status table (Existing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_status (
                id SERIAL PRIMARY KEY, 
                subjectId TEXT UNIQUE NOT NULL, 
                locked BOOLEAN DEFAULT FALSE, 
                message TEXT, 
                updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // =========================================================
        // 🔥 NEW SECURITY TABLES (PHASE 1) 🔥
        // =========================================================

        // 9. Admins Table (New: For Multi-Admin Support)
        await client.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin', -- 'superadmin', 'admin', 'moderator'
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 10. Active Sessions (New: For Device Management & Security)
        await client.query(`
            CREATE TABLE IF NOT EXISTS active_sessions (
                id SERIAL PRIMARY KEY,
                studentId INTEGER REFERENCES students(id) ON DELETE CASCADE,
                token TEXT NOT NULL,
                fingerprint TEXT,
                deviceInfo TEXT,
                ipAddress TEXT,
                lastActivity TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 🛠️ Seed Default Admin if not exists
        // This ensures you can still login using the password in your .env
        const adminCheck = await client.query("SELECT * FROM admins WHERE username = 'admin'");
        if (adminCheck.rows.length === 0 && process.env.ADMIN_PASSWORD_HASH) {
            console.log('🛡️ [Security] Creating default admin from .env configuration...');
            await client.query(
                "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)",
                ['admin', process.env.ADMIN_PASSWORD_HASH, 'superadmin']
            );
        }
        
        console.log('✅ [DB] Database Ready & Secured with New Tables.');
    } catch (err) { 
        console.error('❌ [DB] Critical Error:', err); 
    } finally { 
        client.release(); 
    }
}

module.exports = { pool, initializeDatabase };
