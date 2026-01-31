import secrets
import bcrypt
from urllib.parse import urlparse
from pathlib import Path
from fastapi import FastAPI, Request, Form, Response
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from db import get_conn, init_db

app = FastAPI()
init_db()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

COOKIE_NAME = "session_id"

PROMPTS = [
    "The quick brown fox jumps over the lazy dog.",
    "Typing fast is useful, but typing accurately is even better.",
    "Small consistent improvements compound over time.",
    "Good software is built through iteration and careful testing.",
    "MIT students learn by building and shipping projects.",
]

ELO_W0 = 40.0
ELO_K = 32.0
ELO_P = 4.0

WORDS_PATH = Path(__file__).with_name("1000-common-english-words.txt")
WORDS_PATH_5000 = Path(__file__).with_name("5000_common_words.txt")
try:
    COMMON_WORDS = [w.strip() for w in WORDS_PATH.read_text().splitlines() if w.strip()]
except Exception:
    COMMON_WORDS = []
try:
    COMMON_WORDS_5000 = [w.strip() for w in WORDS_PATH_5000.read_text().splitlines() if w.strip()]
except Exception:
    COMMON_WORDS_5000 = []

def make_word_prompt(words: int = 300, source: str = "1000", number_rate: float = 0.0) -> str:
    pool = COMMON_WORDS
    if source == "5000":
        pool = COMMON_WORDS_5000
    if not pool:
        return " ".join(PROMPTS)
    out = []
    for _ in range(words):
        if number_rate > 0 and secrets.randbelow(1000) < int(number_rate * 1000):
            out.append(str(secrets.randbelow(10000)))
        else:
            out.append(secrets.choice(pool))
    return " ".join(out)

def get_current_user_id(request: Request):
    sid = request.cookies.get(COOKIE_NAME)
    if not sid:
        return None
    conn = get_conn()
    row = conn.execute(
        "SELECT user_id FROM auth_sessions WHERE session_id = ?",
        (sid,),
    ).fetchone()
    conn.close()
    return row["user_id"] if row else None

def get_user_summary(user_id: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, name, email, rating FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    return row

def get_user_best_wpm(user_id: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT MAX(wpm) as wpm FROM typing_sessions WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    return row["wpm"] if row and row["wpm"] is not None else None

def get_training_progress(user_id: int):
    conn = get_conn()
    rows = conn.execute(
        "SELECT mode, level, percent FROM training_progress WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    conn.close()
    progress = {
        "easy": {1: 0, 2: 0, 3: 0},
        "advanced": {1: 0, 2: 0, 3: 0},
        "hard": {1: 0, 2: 0, 3: 0},
    }
    for row in rows:
        mode = row["mode"]
        level = int(row["level"])
        if mode in progress and level in progress[mode]:
            progress[mode][level] = int(row["percent"])
    return progress

def expected_wpm(rating: float) -> float:
    return ELO_W0 * (10 ** ((rating - 1500.0) / 400.0))

def score_from_performance(perf: float, expected: float) -> float:
    if expected <= 0:
        return 0.5
    ratio = perf / expected
    if ratio <= 0:
        return 0.0
    return 1.0 / (1.0 + (1.0 / ratio) ** ELO_P)

def update_rating(current: float, perf: float, duration_seconds: int) -> float:
    exp_wpm = expected_wpm(current)
    s = score_from_performance(perf, exp_wpm)
    duration_factor = {
        15: 0.85,
        30: 0.95,
        60: 1.0,
        120: 1.1,
    }.get(duration_seconds, 1.0)
    delta = ELO_K * (s - 0.5) * duration_factor
    if delta < 0:
        delta *= 0.85
    new_rating = current + delta
    return max(0.0, min(3000.0, new_rating))

def require_login(request: Request):
    uid = get_current_user_id(request)
    if uid is None:
        return RedirectResponse("/", status_code=303)
    return uid

def ensure_preferences(user_id: int):
    conn = get_conn()
    row = conn.execute("SELECT user_id FROM preferences WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO preferences (user_id, duration_seconds, theme, live_wpm) VALUES (?, 60, 'light', 1)",
            (user_id,),
        )
        conn.commit()
    conn.close()

def get_preferences(user_id: int):
    ensure_preferences(user_id)
    conn = get_conn()
    prefs = conn.execute(
        "SELECT duration_seconds, theme, live_wpm FROM preferences WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    if not prefs:
        return {"duration_seconds": 60, "theme": "dark", "live_wpm": 1}
    return {
        "duration_seconds": int(prefs["duration_seconds"]),
        "theme": "dark",
        "live_wpm": int(prefs["live_wpm"]),
    }

def get_top_wpm_and_trophy():
    conn = get_conn()
    row = conn.execute("SELECT MAX(wpm) as max_wpm FROM typing_sessions").fetchone()
    conn.close()
    top_wpm = float(row["max_wpm"]) if row and row["max_wpm"] is not None else None

    trophy = None
    if top_wpm is not None:
        if 40 <= top_wpm <= 59:
            trophy = "🥉"
        elif 60 <= top_wpm <= 79:
            trophy = "🥈"
        elif 80 <= top_wpm <= 99:
            trophy = "🥇"
        elif top_wpm >= 100:
            trophy = "🏆"
        else:
            trophy = "—"
    return top_wpm, trophy

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    user_id = get_current_user_id(request)
    logged_in = user_id is not None
    if logged_in:
        prefs = get_preferences(user_id)
        user = get_user_summary(user_id)
        display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
        user_rating = user["rating"] if user and user["rating"] is not None else 1500
        user_best_wpm = get_user_best_wpm(user_id)
    else:
        prefs = {"duration_seconds": 60, "theme": "dark", "live_wpm": 1}
        display_name = None
        user_rating = 1500
        user_best_wpm = None
    prompt_text = make_word_prompt(words=300, source="1000")
    prompt_id = 0
    top_wpm, top_trophy = get_top_wpm_and_trophy()

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "prompt_text": prompt_text,
            "prompt_id": prompt_id,
            "duration_seconds": int(prefs["duration_seconds"]),
            "theme": prefs["theme"],
            "live_wpm": int(prefs["live_wpm"]),
            "user_name": display_name,
            "show_home": True,
            "ranked": False,
            "top_wpm": top_wpm,
            "user_best_wpm": user_best_wpm,
            "top_trophy": top_trophy,
            "user_rating": user_rating,
            "user_id": user_id,
            "logged_in": logged_in,
        },
    )

@app.get("/api/prompt")
def api_prompt(request: Request):
    try:
        words = int(request.query_params.get("words", "300"))
    except Exception:
        words = 300
    source = request.query_params.get("source", "1000")
    if source not in ("1000", "5000"):
        source = "1000"
    try:
        number_rate = float(request.query_params.get("number_rate", "0"))
    except Exception:
        number_rate = 0.0
    number_rate = max(0.0, min(0.5, number_rate))
    words = max(5, min(1000, words))
    return JSONResponse({"prompt": make_word_prompt(words=words, source=source, number_rate=number_rate)})

@app.get("/api/training_progress")
def api_training_progress(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return JSONResponse({"ok": False}, status_code=401)
    user_id = uid_or_redirect
    progress = get_training_progress(user_id)
    return JSONResponse({"ok": True, "progress": progress})

@app.post("/api/training_progress")
async def api_training_progress_update(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return JSONResponse({"ok": False}, status_code=401)
    user_id = uid_or_redirect
    payload = await request.json()
    try:
        mode = str(payload.get("mode", ""))
        level = int(payload.get("level", 0))
        percent = int(payload.get("percent", 0))
    except Exception:
        return JSONResponse({"ok": False}, status_code=400)
    if mode not in ("easy", "advanced", "hard"):
        return JSONResponse({"ok": False}, status_code=400)
    if level not in (1, 2, 3):
        return JSONResponse({"ok": False}, status_code=400)
    percent = max(0, min(100, percent))

    conn = get_conn()
    conn.execute(
        """
        INSERT INTO training_progress (user_id, mode, level, percent)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, mode, level) DO UPDATE SET
          percent = excluded.percent,
          updated_at = datetime('now')
        """,
        (user_id, mode, level, percent),
    )
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

@app.get("/training", response_class=HTMLResponse)
def training(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)
    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    return templates.TemplateResponse(
        "training.html",
        {"request": request, "theme": prefs["theme"], "user_name": display_name, "user_id": user_id, "logged_in": True},
    )

@app.get("/training/easy", response_class=HTMLResponse)
def training_easy(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)
    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    prompt_text = make_word_prompt(words=300, source="1000")
    return templates.TemplateResponse(
        "training_easy.html",
        {
            "request": request,
            "prompt_text": prompt_text,
            "prompt_id": 0,
            "duration_seconds": int(prefs["duration_seconds"]),
            "theme": prefs["theme"],
            "live_wpm": int(prefs["live_wpm"]),
            "user_name": display_name,
            "user_id": user_id,
            "logged_in": True,
        },
    )

@app.get("/training/advanced", response_class=HTMLResponse)
def training_advanced(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)
    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    prompt_text = make_word_prompt(words=20, source="5000")
    return templates.TemplateResponse(
        "training_advanced.html",
        {
            "request": request,
            "prompt_text": prompt_text,
            "prompt_id": 0,
            "duration_seconds": 30,
            "theme": prefs["theme"],
            "live_wpm": int(prefs["live_wpm"]),
            "user_name": display_name,
            "user_id": user_id,
            "logged_in": True,
        },
    )

@app.get("/training/hard", response_class=HTMLResponse)
def training_hard(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)
    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    prompt_text = make_word_prompt(words=50, source="5000", number_rate=0.15)
    return templates.TemplateResponse(
        "training_hard.html",
        {
            "request": request,
            "prompt_text": prompt_text,
            "prompt_id": 0,
            "duration_seconds": 60,
            "theme": prefs["theme"],
            "live_wpm": int(prefs["live_wpm"]),
            "user_name": display_name,
            "user_id": user_id,
            "logged_in": True,
        },
    )

@app.get("/test", response_class=HTMLResponse)
def typing_test(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)

    prompt_text = make_word_prompt(words=300)
    prompt_id = 0

    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    user_rating = user["rating"] if user and user["rating"] is not None else 1500
    conn = get_conn()
    elo_rankings = conn.execute(
        "SELECT name, email, rating FROM users ORDER BY rating DESC LIMIT 25"
    ).fetchall()
    conn.close()
    if not elo_rankings:
        elo_rankings = [{
            "name": user["name"] if user else None,
            "email": user["email"] if user else None,
            "rating": user_rating,
        }]
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "prompt_text": prompt_text,
            "prompt_id": prompt_id,
            "duration_seconds": int(prefs["duration_seconds"]),
            "theme": prefs["theme"],
            "live_wpm": int(prefs["live_wpm"]),
            "user_name": display_name,
            "user_rating": user_rating,
            "show_home": False,
            "ranked": True,
            "user_id": user_id,
            "elo_rankings": elo_rankings,
            "logged_in": True,
        },
    )

@app.get("/leaderboard", response_class=HTMLResponse)
def leaderboard(request: Request):
    user_id = get_current_user_id(request)
    logged_in = user_id is not None
    if logged_in:
        prefs = get_preferences(user_id)
        user = get_user_summary(user_id)
        display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    else:
        prefs = {"duration_seconds": 60, "theme": "dark", "live_wpm": 1}
        display_name = None
    conn = get_conn()
    top = conn.execute("""
        SELECT u.name as name, u.email as email, ts.wpm as wpm, ts.accuracy as accuracy, ts.created_at as created_at
        FROM typing_sessions ts
        JOIN users u ON u.id = ts.user_id
        ORDER BY ts.wpm DESC
        LIMIT 10
    """).fetchall()

    elo = conn.execute("""
        SELECT name, email, rating
        FROM users
        ORDER BY rating DESC
        LIMIT 25
    """).fetchall()
    if logged_in:
        mine = conn.execute("""
            SELECT wpm, accuracy, duration_seconds, created_at
            FROM typing_sessions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        """, (user_id,)).fetchall()
    else:
        mine = []
    conn.close()

    return templates.TemplateResponse(
        "leaderboard.html",
        {
            "request": request,
            "top": top,
            "elo": elo,
            "mine": mine,
            "theme": prefs["theme"],
            "user_name": display_name,
            "logged_in": logged_in,
            "user_id": user_id,
        },
    )

@app.get("/settings", response_class=HTMLResponse)
def settings(request: Request):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)

    user = get_user_summary(user_id)
    display_name = user["name"] if user and user["name"] else (user["email"] if user else "User")
    return templates.TemplateResponse(
        "settings.html",
        {"request": request, "prefs": prefs, "theme": prefs["theme"], "user_name": display_name, "logged_in": True},
    )

@app.post("/settings")
def save_settings(
    request: Request,
    duration_seconds: str = Form(None),
    theme: str = Form(None),
    live_wpm: str = Form(...),
):
    uid_or_redirect = require_login(request)
    if isinstance(uid_or_redirect, RedirectResponse):
        return uid_or_redirect
    user_id = uid_or_redirect

    prefs = get_preferences(user_id)

    if duration_seconds is None:
        duration_seconds = prefs["duration_seconds"]
    else:
        try:
            duration_seconds = int(duration_seconds)
        except Exception:
            duration_seconds = prefs["duration_seconds"]
        duration_seconds = 30 if duration_seconds <= 30 else 60 if duration_seconds <= 60 else 120

    theme = "dark"
    live_wpm = 1 if str(live_wpm) in ("1", "true", "True", "on") else 0

    conn = get_conn()
    conn.execute("""
        INSERT INTO preferences (user_id, duration_seconds, theme, live_wpm, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
            duration_seconds=excluded.duration_seconds,
            theme=excluded.theme,
            live_wpm=excluded.live_wpm,
            updated_at=datetime('now')
    """, (user_id, duration_seconds, theme, live_wpm))
    conn.commit()
    conn.close()

    return RedirectResponse("/settings", status_code=303)

@app.post("/api/session")
def save_typing_session(request: Request):
    uid = get_current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "not_authenticated"}, status_code=401)

    data = request._json if hasattr(request, "_json") else None  # (not used)
    # We’ll parse JSON the normal FastAPI way:
    # but to keep file minimal, use request.json() below
    return JSONResponse({"error": "use_json"}, status_code=400)

@app.post("/api/session_json")
async def save_typing_session_json(request: Request):
    uid = get_current_user_id(request)
    if uid is None:
        return JSONResponse({"error": "not_authenticated"}, status_code=401)

    payload = await request.json()
    # Expected keys: wpm, accuracy, duration_seconds, prompt_id
    try:
        wpm = float(payload["wpm"])
        accuracy = float(payload["accuracy"])
        duration_seconds = int(payload["duration_seconds"])
        prompt_id = int(payload["prompt_id"])
    except Exception:
        return JSONResponse({"error": "bad_payload"}, status_code=400)

    # basic validation
    if not (0 <= accuracy <= 1):
        return JSONResponse({"error": "bad_accuracy"}, status_code=400)
    if wpm < 0 or wpm > 400:
        return JSONResponse({"error": "bad_wpm"}, status_code=400)
    if duration_seconds not in (15, 30, 60, 120):
        duration_seconds = 60
    if not (0 <= prompt_id < len(PROMPTS)):
        prompt_id = 0

    conn = get_conn()
    conn.execute("""
        INSERT INTO typing_sessions (user_id, wpm, accuracy, duration_seconds, prompt_id)
        VALUES (?, ?, ?, ?, ?)
    """, (uid, wpm, accuracy, duration_seconds, prompt_id))
    # update rating based on performance
    row = conn.execute("SELECT rating FROM users WHERE id = ?", (uid,)).fetchone()
    current_rating = float(row["rating"]) if row and row["rating"] is not None else 1500.0
    new_rating = update_rating(current_rating, wpm, duration_seconds)
    new_rating_int = int(round(new_rating))
    delta = new_rating_int - int(round(current_rating))
    conn.execute("UPDATE users SET rating = ? WHERE id = ?", (new_rating_int, uid))
    conn.commit()
    conn.close()

    return JSONResponse({"ok": True, "rating": new_rating_int, "delta": delta})

@app.get("/signup", response_class=HTMLResponse)
def signup_page(request: Request):
    return templates.TemplateResponse(
    "signup.html",
    {"request": request, "error": None, "auth_page": True},
)

@app.post("/signup")
def signup(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    name: str | None = Form(None),
):
    email = email.strip().lower()
    if name:
        name = name.strip()
    if not name:
        name = None
    if len(email) < 3 or "@" not in email:
        return templates.TemplateResponse("signup.html", {"request": request, "error": "Enter a valid email."})
    if len(password) < 6:
        return templates.TemplateResponse("signup.html", {"request": request, "error": "Password must be at least 6 characters."})

    pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
            (name, email, pw_hash),
        )
        user_id = cur.lastrowid
        conn.commit()
    except Exception:
        conn.close()
        return templates.TemplateResponse("signup.html", {"request": request, "error": "Email already in use."})
    conn.close()

    # create default preferences
    ensure_preferences(user_id)

    return RedirectResponse("/login", status_code=303)

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(
    "login.html",
    {"request": request, "error": None, "auth_page": True},
)


@app.post("/login")
def login(
    response: Response,
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
):
    email = email.strip().lower()
    conn = get_conn()
    row = conn.execute(
        "SELECT id, password_hash FROM users WHERE email = ?",
        (email,),
    ).fetchone()
    conn.close()

    if not row:
        return templates.TemplateResponse("login.html", {"request": request, "error": "Invalid email or password."})

    if not bcrypt.checkpw(password.encode("utf-8"), row["password_hash"]):
        return templates.TemplateResponse("login.html", {"request": request, "error": "Invalid email or password."})

    # create session
    sid = secrets.token_urlsafe(32)
    conn = get_conn()
    conn.execute("INSERT INTO auth_sessions (session_id, user_id) VALUES (?, ?)", (sid, row["id"]))
    conn.commit()
    conn.close()

    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(
        key=COOKIE_NAME,
        value=sid,
        httponly=True,
        samesite="lax",
        secure=False,  # set True on HTTPS deploy
        max_age=60 * 60 * 24 * 7,
    )
    return resp

@app.post("/logout")
def logout(request: Request, next: str = Form(None)):
    sid = request.cookies.get(COOKIE_NAME)
    if sid:
        conn = get_conn()
        conn.execute("DELETE FROM auth_sessions WHERE session_id = ?", (sid,))
        conn.commit()
        conn.close()

    target = "/"
    if next and isinstance(next, str) and next.startswith("/"):
        target = next
    resp = RedirectResponse(target, status_code=303)
    resp.delete_cookie(COOKIE_NAME)
    return resp
