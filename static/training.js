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

  const storageKey = "training_easy_progress";
  const state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { 1: 0, 2: 0, 3: 0 };
      const parsed = JSON.parse(raw);
      return { 1: parsed[1] || 0, 2: parsed[2] || 0, 3: parsed[3] || 0 };
    } catch (e) {
      return { 1: 0, 2: 0, 3: 0 };
    }
  }

  function saveState() {
    localStorage.setItem(storageKey, JSON.stringify(state));
    updateTrainingPageSummary();
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

    let adv = { 1: 0, 2: 0, 3: 0 };
    try {
      const advRaw = localStorage.getItem("training_advanced_progress");
      if (advRaw) adv = JSON.parse(advRaw);
    } catch (e) {
      // ignore
    }
    const advTotal = Math.round(((adv[1] || 0) + (adv[2] || 0) + (adv[3] || 0)) / 3);
    if (advancedPercent) advancedPercent.textContent = `${advTotal}%`;

    let hard = { 1: 0, 2: 0, 3: 0 };
    try {
      const hardRaw = localStorage.getItem("training_hard_progress");
      if (hardRaw) hard = JSON.parse(hardRaw);
    } catch (e) {
      // ignore
    }
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
      window.__setPrompt("loading", level.duration, levelId);
    }

    try {
      const res = await fetch(`/api/prompt?words=${level.words}`);
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
    saveState();
    updateButtons();
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

  updateButtons();
  updateTrainingPageSummary();
})();
