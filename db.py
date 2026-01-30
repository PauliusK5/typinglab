import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).with_name("app.db")

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        rating INTEGER NOT NULL DEFAULT 1500,
        password_hash BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    """)
    # lightweight migration for existing DBs
    cols = {row["name"] for row in cur.execute("PRAGMA table_info(users)")}
    if "name" not in cols:
        cur.execute("ALTER TABLE users ADD COLUMN name TEXT;")
    if "rating" not in cols:
        cur.execute("ALTER TABLE users ADD COLUMN rating INTEGER NOT NULL DEFAULT 1500;")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS preferences (
        user_id INTEGER PRIMARY KEY,
        duration_seconds INTEGER NOT NULL DEFAULT 60,
        theme TEXT NOT NULL DEFAULT 'light',
        live_wpm INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS typing_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        wpm REAL NOT NULL,
        accuracy REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        prompt_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    conn.commit()
    conn.close()
