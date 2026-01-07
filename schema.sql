-- Users table for storing GitHub authenticated users
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id TEXT UNIQUE NOT NULL,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
);

-- Index for quick GitHub ID lookup
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);

-- Transfers table for tracking user uploads (optional, for analytics)
CREATE TABLE IF NOT EXISTS user_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    transfer_id TEXT NOT NULL,
    filename TEXT,
    size INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_user_id ON user_transfers(user_id);
