(function () {
  const levelButtons = Array.from(document.querySelectorAll(".training-level"));
  const trainingBox = document.getElementById("trainingBox");
  const trainingStatus = document.getElementById("trainingStatus");
  const trainingResult = document.getElementById("trainingResult");

  const LEVELS = [
    { id: 1, words: 20, duration: 30 },
    { id: 2, words: 25, duration: 30 },
    { id: 3, words: 32, duration: 30 },
  ];

  const userId = (window.TYPINGLAB && window.TYPINGLAB.userId) ? String(window.TYPINGLAB.userId) : "anon";
  const state = { 1: 0, 2: 0, 3: 0 };

  async function fetchProgress() {
    try {
      const res = await fetch("/api/training_progress");
      const j = await res.json();
      if (j && j.ok && j.progress && j.progress.advanced) {
        state[1] = j.progress.advanced[1] || 0;
        state[2] = j.progress.advanced[2] || 0;
        state[3] = j.progress.advanced[3] || 0;
      }
    } catch (e) {
      // ignore
    }
  }

  async function saveState(levelId, percent) {
    try {
      await fetch("/api/training_progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "advanced", level: levelId, percent }),
      });
    } catch (e) {
      // ignore
    }
  }

  function updateButtons() {
    levelButtons.forEach((btn) => {
      const level = Number(btn.dataset.level);
      const pct = state[level] || 0;
      const locked =
        (level === 2 && (state[1] || 0) < 100) ||
        (level === 3 && (state[2] || 0) < 100);
      btn.dataset.locked = locked ? "1" : "0";
      btn.textContent = `Level ${level} · ${pct}%`;
      btn.disabled = locked;
      btn.classList.toggle("is-locked", locked);
    });
  }

  async function startLevel(levelId) {
    const level = LEVELS.find((l) => l.id === levelId);
    if (!level) return;
    trainingStatus.textContent = `Level ${levelId}: ${level.words} words in ${level.duration}s.`;
    if (trainingResult) {
      trainingResult.classList.add("hidden");
      trainingResult.textContent = "";
    }
    trainingBox.classList.remove("hidden");
    if (window.__setPrompt) {
      window.__setPrompt("loading", level.duration, levelId);
    }

    try {
      const res = await fetch(`/api/prompt?words=${level.words}&source=5000`);
      const j = await res.json();
      if (!j || !j.prompt) return;
      if (window.__setPrompt) {
        window.__setPrompt(j.prompt, level.duration, levelId);
      }
    } catch (e) {
      // ignore
    }
  }

  function countCorrectWords(typed, target) {
    const tWords = typed.trim().split(/\s+/).filter(Boolean);
    const pWords = target.trim().split(/\s+/).filter(Boolean);
    let correct = 0;
    for (let i = 0; i < tWords.length && i < pWords.length; i++) {
      if (tWords[i] === pWords[i]) correct += 1;
      else break;
    }
    return { correct, total: pWords.length };
  }

  document.addEventListener("typinglab:ended", (e) => {
    const detail = e.detail || {};
    if (!detail.training) return;
    const levelId = detail.levelId || 1;
    const { correct, total } = countCorrectWords(detail.typedText || "", detail.promptText || "");
    const percent = detail.reason === "completed" ? 100 : Math.min(100, Math.round((correct / total) * 100));
    state[levelId] = Math.max(state[levelId] || 0, percent);
    saveState(levelId, percent).finally(() => {
      updateButtons();
    });
    if (trainingResult) {
      trainingResult.classList.remove("hidden");
      trainingResult.textContent = `Level ${levelId} complete: ${percent}%`;
    }
  });

  levelButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const level = Number(btn.dataset.level);
      if (btn.disabled) return;
      startLevel(level);
    });
  });

  fetchProgress().finally(() => {
    updateButtons();
  });
})();
