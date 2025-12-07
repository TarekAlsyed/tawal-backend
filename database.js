/*
 * =================================================================================
 * DATABASE.JS - Fixed Schema (Matching Document Index 6)
 * =================================================================================
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 [DB] Initializing tables...');
        
        // 1. Students table
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY, 
                name TEXT NOT NULL, 
                email TEXT UNIQUE, 
                fingerprint TEXT,
                progress JSONB DEFAULT '{}'::jsonb,
                createdat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                isblocked BOOLEAN DEFAULT FALSE
            )
        `);
        
        // 2. Quiz results table
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_results (
                id SERIAL PRIMARY KEY, 
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                quiz_name TEXT NOT NULL,
                subject_id TEXT, 
                score INTEGER NOT NULL, 
                total_questions INTEGER NOT NULL, 
                correct_answers INTEGER NOT NULL, 
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 3. Messages table (NOT support_messages!)
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, 
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                content TEXT NOT NULL, 
                admin_reply TEXT, 
                is_read BOOLEAN DEFAULT FALSE, 
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 4. Login logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id SERIAL PRIMARY KEY, 
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                logintime TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                logouttime TIMESTAMPTZ
            )
        `);
        
        // 5. Activity logs table (with S!)
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY, 
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                activity_type TEXT NOT NULL, 
                subject_name TEXT, 
                score INTEGER,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 6. Student fingerprints table
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_fingerprints (
                id SERIAL PRIMARY KEY, 
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
                fingerprint TEXT NOT NULL, 
                last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, 
                UNIQUE(student_id, fingerprint)
            )
        `);
        
        // 7. Blocked fingerprints table
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_fingerprints (
                id SERIAL PRIMARY KEY, 
                fingerprint TEXT UNIQUE NOT NULL, 
                reason TEXT, 
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 8. Quiz status table
        await client.query(`
            CREATE TABLE IF NOT EXISTS quiz_status (
                id SERIAL PRIMARY KEY, 
                subject_id TEXT UNIQUE NOT NULL, 
                locked BOOLEAN DEFAULT FALSE, 
                message TEXT, 
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 9. Admins Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 10. Active Sessions
        await client.query(`
            CREATE TABLE IF NOT EXISTS active_sessions (
                id SERIAL PRIMARY KEY,
                student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
                token TEXT NOT NULL,
                fingerprint TEXT,
                device_info TEXT,
                ip_address TEXT,
                last_activity TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed default admin
        const adminCheck = await client.query("SELECT * FROM admins WHERE username = 'admin'");
        if (adminCheck.rows.length === 0 && process.env.ADMIN_PASSWORD_HASH) {
            console.log('🛡️ Creating default admin...');
            await client.query(
                "INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)",
                ['admin', process.env.ADMIN_PASSWORD_HASH, 'superadmin']
            );
        }
        
        console.log('✅ [DB] All tables ready!');
    } catch (err) { 
        console.error('❌ [DB] Error:', err); 
    } finally { 
        client.release(); 
    }
}

module.exports = { pool, initializeDatabase };
