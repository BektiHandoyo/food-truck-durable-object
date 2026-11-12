const initSchema = (sql) => {
    // create table if not exist
    // slots with column id text as primary key, slot_time integer not null, quota integer not null (must check if the quota is not zero or negative), claimed boolean
    // claims with column id text as primary key, request_id text not null, user_id text not null, queue_pos integer not null, status text with default 'CLAIMED', claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER
    sql.exec(`
        CREATE TABLE IF NOT EXISTS slots (
            id TEXT PRIMARY KEY,
            slot_time INTEGER NOT NULL,
            quota INTEGER NOT NULL CHECK (quota > 0),
            claimed BOOLEAN NOT NULL DEFAULT 0
        );
        
        CREATE TABLE IF NOT EXISTS claims (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            queue_pos INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'CLAIMED',
            claimed_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            redeemed_at INTEGER
        );

        CREATE UNIQUE INDEX idx_one_active_per_user ON claims(user_id) WHERE status = 'CLAIMED';
    `);
}