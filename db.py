import os
from pathlib import Path

from sqlalchemy import create_engine, event, text

DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL:
    db_url = DATABASE_URL.replace("postgres://", "postgresql://")
else:
    db_url = f"sqlite:///{Path(__file__).with_name('app.db')}"

engine = create_engine(db_url, future=True, pool_pre_ping=True)

if engine.dialect.name == "sqlite":
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.close()


def get_conn():
    return engine.connect()


def init_db() -> None:
    is_sqlite = engine.dialect.name == "sqlite"
    with engine.begin() as conn:
        if is_sqlite:
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT UNIQUE NOT NULL,
                rating INTEGER NOT NULL DEFAULT 1500,
                password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """))
            # lightweight migration for existing DBs
            cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
            if "name" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN name TEXT;"))
            if "rating" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN rating INTEGER NOT NULL DEFAULT 1500;"))
        else:
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT,
                email TEXT UNIQUE NOT NULL,
                rating INTEGER NOT NULL DEFAULT 1500,
                password_hash BYTEA NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """))
            conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;"))
            conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS rating INTEGER NOT NULL DEFAULT 1500;"))

        if is_sqlite:
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS auth_sessions (
                session_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS preferences (
                user_id INTEGER PRIMARY KEY,
                duration_seconds INTEGER NOT NULL DEFAULT 60,
                theme TEXT NOT NULL DEFAULT 'light',
                live_wpm INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS typing_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                wpm REAL NOT NULL,
                accuracy REAL NOT NULL,
                duration_seconds INTEGER NOT NULL,
                prompt_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS training_progress (
                user_id INTEGER NOT NULL,
                mode TEXT NOT NULL,
                level INTEGER NOT NULL,
                percent INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, mode, level),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))
        else:
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS auth_sessions (
                session_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS preferences (
                user_id INTEGER PRIMARY KEY,
                duration_seconds INTEGER NOT NULL DEFAULT 60,
                theme TEXT NOT NULL DEFAULT 'light',
                live_wpm INTEGER NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS typing_sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                wpm DOUBLE PRECISION NOT NULL,
                accuracy DOUBLE PRECISION NOT NULL,
                duration_seconds INTEGER NOT NULL,
                prompt_id INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))

            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS training_progress (
                user_id INTEGER NOT NULL,
                mode TEXT NOT NULL,
                level INTEGER NOT NULL,
                percent INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, mode, level),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """))
