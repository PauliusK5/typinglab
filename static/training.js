(function () {
  const levelButtons = Array.from(document.querySelectorAll(".training-level"));
  const trainingBox = document.getElementById("trainingBox");
  const trainingStatus = document.getElementById("trainingStatus");
  const trainingResult = document.getElementById("trainingResult");
  const progressRing = document.getElementById("trainingProgressRing");
  const progressValue = document.getElementById("trainingProgressValue");
  const easyPercent = document.getElementById("trainingEasyPercent");
  const advancedPercent = document.getElementById("trainingAdvancedPercent");
  const hardPercent = document.getElementById("trainingHardPercent");

  const LEVELS = [
    { id: 1, words: 10, duration: 30 },
    { id: 2, words: 20, duration: 30 },
    { id: 3, words: 30, duration: 30 },
  ];

  const state = { 1: 0, 2: 0, 3: 0 };
  let progress = {
    easy: { 1: 0, 2: 0, 3: 0 },
    advanced: { 1: 0, 2: 0, 3: 0 },
    hard: { 1: 0, 2: 0, 3: 0 },
  };

  async function fetchProgress() {
    try {
      const res = await fetch("/api/training_progress");
      const j = await res.json();
      if (j && j.ok && j.progress) {
        progress = j.progress;
        state[1] = progress.easy[1] || 0;
        state[2] = progress.easy[2] || 0;
        state[3] = progress.easy[3] || 0;
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
        body: JSON.stringify({ mode: "easy", level: levelId, percent }),
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
    if (window.__updateTrainingProgress) {
      window.__updateTrainingProgress();
    }
  }

  function updateTrainingPageSummary() {
    const pct1 = state[1] || 0;
    const pct2 = state[2] || 0;
    const pct3 = state[3] || 0;
    const easyTotal = Math.round((pct1 + pct2 + pct3) / 3);
    if (easyPercent) easyPercent.textContent = `${easyTotal}%`;

    const adv = progress.advanced || { 1: 0, 2: 0, 3: 0 };
    const advTotal = Math.round(((adv[1] || 0) + (adv[2] || 0) + (adv[3] || 0)) / 3);
    if (advancedPercent) advancedPercent.textContent = `${advTotal}%`;

    const hard = progress.hard || { 1: 0, 2: 0, 3: 0 };
    const hardTotal = Math.round(((hard[1] || 0) + (hard[2] || 0) + (hard[3] || 0)) / 3);
    if (hardPercent) hardPercent.textContent = `${hardTotal}%`;

    const overall = Math.round((easyTotal + advTotal + hardTotal) / 3);
    if (progressRing) progressRing.style.setProperty("--progress", overall);
    if (progressValue) progressValue.textContent = `${overall}%`;
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
        window.__setPrompt("loading", level.duration, levelId, level.words);
      }

    try {
      const res = await fetch(`/api/prompt?words=300`);
      const j = await res.json();
      if (!j || !j.prompt) return;
      if (window.__setPrompt) {
        window.__setPrompt(j.prompt, level.duration, levelId, level.words);
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
    }
    return { correct, total: pWords.length };
  }

  document.addEventListener("typinglab:ended", (e) => {
    const detail = e.detail || {};
    if (!detail.training) return;
    const levelId = detail.levelId || 1;
    const { correct } = countCorrectWords(detail.typedText || "", detail.promptText || "");
    const required = LEVELS.find((l) => l.id === levelId)?.words || 0;
    const percent = required > 0 ? Math.min(100, Math.round((correct / required) * 100)) : 0;
    state[levelId] = Math.max(state[levelId] || 0, percent);
    progress.easy[levelId] = state[levelId];
    saveState(levelId, percent).finally(() => {
      updateButtons();
      updateTrainingPageSummary();
    });
    if (trainingResult) {
      trainingResult.classList.remove("hidden");
      const wpm = typeof detail.wpm === "number" ? detail.wpm.toFixed(1) : "0.0";
      const acc = typeof detail.accuracy === "number" ? `${(detail.accuracy * 100).toFixed(1)}%` : "0%";
      trainingResult.innerHTML = `
        <div class="training-result-title">Level ${levelId} complete: ${percent}%</div>
        <div class="training-result-grid">
          <div class="training-result-box">
            <div class="training-result-label">WPM</div>
            <div class="training-result-value">${wpm}</div>
          </div>
          <div class="training-result-box">
            <div class="training-result-label">Accuracy</div>
            <div class="training-result-value">${acc}</div>
          </div>
        </div>
      `;
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
    updateTrainingPageSummary();
  });
})();
