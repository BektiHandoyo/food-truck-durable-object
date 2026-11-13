export const initSchema = (sql) => {
    sql.exec(`
        CREATE TABLE IF NOT EXISTS slots (
            id TEXT PRIMARY KEY,
            slot_time INTEGER NOT NULL,
            quota INTEGER NOT NULL CHECK (quota > 0),
            claimed INTEGER NOT NULL DEFAULT 0
        );
        
        CREATE TABLE IF NOT EXISTS claims (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            queue_pos INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'CLAIMED',
            claimed_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            redeemed_at INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_user
            ON claims(user_id) WHERE status = 'CLAIMED';
    `);
};

