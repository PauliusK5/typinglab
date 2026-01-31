(function () {
  const cfgEl = document.getElementById("typing-config");
  let cfg = {
    durationSeconds: 60,
    promptText: "",
    promptId: 0,
    liveWpm: 1,
  };

  if (cfgEl) {
    try {
      cfg = { ...cfg, ...JSON.parse(cfgEl.textContent || "{}") };
    } catch (e) {
      // keep defaults if parsing fails
    }
  }

  const savedDuration = Number(localStorage.getItem("typing_duration_seconds") || "0");
  if (Number.isFinite(savedDuration) && savedDuration > 0) {
    cfg.durationSeconds = savedDuration;
  }

  const promptSource = document.getElementById("prompt-source");
  if (promptSource && !cfg.promptText) {
    cfg.promptText = promptSource.textContent || "";
  }

  const inputEl = document.getElementById("input");
  const ghostEl = document.getElementById("ghost");

  // Prefer cfg.promptText; otherwise fall back to DOM prompt.
  const promptFromDom = ghostEl
    ? (ghostEl.dataset.prompt || ghostEl.textContent || "").trim()
    : "";
  if (!cfg.promptText && promptFromDom) cfg.promptText = promptFromDom;

  if (!cfg.promptText) return;

  window.TYPINGLAB = cfg;

  // Lock the prompt into the DOM once so ghost rendering is stable.
  if (ghostEl) ghostEl.dataset.prompt = cfg.promptText;

  const timeEl = document.getElementById("timeLeft");
  const wpmEl = document.getElementById("wpm");
  const accEl = document.getElementById("acc");
  const statusEl = document.getElementById("status");
  const restartBtn = document.getElementById("restart");
  const resultEl = document.getElementById("result");
  const resultTextEl = document.getElementById("resultText");
  const chartEl = document.getElementById("wpmChart");
  const homeTimerEl = document.getElementById("homeTimer");
  const testTimerEl = document.getElementById("testTimer");
  const trainingTimerEl = document.getElementById("trainingTimer");
  const trainingCounterEl = document.getElementById("trainingCounter");
  const durationRows = Array.from(document.querySelectorAll("[data-duration-row]"));
  const homeTypeboxEl = document.getElementById("homeTypebox");
  const restartHomeBtn = document.getElementById("restartHome");
  const testTypeboxEl = document.getElementById("testTypebox");
  const trainingTypeboxEl = document.getElementById("trainingTypebox");
  const wpmRingEl = document.getElementById("wpmRing");
  const wpmValueEl = document.getElementById("wpmValue");
  const accValueEl = document.getElementById("accValue");
  const eloValueEl = document.getElementById("eloValue");
  const eloDeltaEl = document.getElementById("eloDelta");
  const durationEl = document.getElementById("duration");
  let hoverIndex = null;
  let chartState = null;

  let started = false;
  let startTs = null;
  let timer = null;
  let remaining = cfg.durationSeconds;
  let finished = false;
  let wpmSeries = [];
  let accSeries = [];
  let displayText = "";
  let promptPlain = "";
  let typedValue = "";
  let needsLineEnds = true;
  // --- Auto-scroll one visual line at a time (for wrapped lines too) ---
  let lastDesired = 0;
  let lineEnds = [];
  let lineHeightPx = 0;
  let lastCaretLine = 0;
  let ignoreBeforeInput = false;
  let desiredScrollTop = 0;
  let isAutoScroll = false;
  let scrollAnim = null;

  function reset() {
    started = false;
    startTs = null;
    finished = false;
    remaining = cfg.durationSeconds;
    document.body.classList.remove("typing-active");

    if (timer) clearInterval(timer);
    timer = null;

    typedValue = "";
    inputEl.value = promptPlain;
    if (timeEl) timeEl.textContent = String(remaining);
    if (wpmEl) wpmEl.textContent = "0";
    if (accEl) accEl.textContent = "0";
    if (statusEl) statusEl.textContent = "";

    // IMPORTANT: render ghost AFTER clearing input
    renderGhost();

    if (resultEl) {
      resultEl.classList.add("hidden");
    }
    if (resultEl) {
      resultEl.style.display = "";
      resultEl.style.visibility = "";
      resultEl.style.opacity = "";
    }
    if (resultTextEl) resultTextEl.textContent = "";
    if (wpmValueEl) wpmValueEl.textContent = "0";
    if (accValueEl) accValueEl.textContent = "0%";
    if (wpmRingEl) {
      wpmRingEl.style.setProperty("--wpm-progress", "0");
      wpmRingEl.style.setProperty("--wpm-color", "#ef4444");
    }

    wpmSeries = [];
    accSeries = [];

    if (homeTimerEl) homeTimerEl.classList.add("hidden");
    if (testTimerEl) testTimerEl.classList.add("hidden");
    if (trainingTimerEl) trainingTimerEl.classList.add("hidden");
    if (homeTypeboxEl) {
      homeTypeboxEl.classList.remove("hidden");
      homeTypeboxEl.style.display = "";
    }
    if (testTypeboxEl) testTypeboxEl.classList.remove("hidden");

    if (!cfg.ranked && !cfg.training) {
      refreshPrompt();
    }

    // Focus after DOM updates (prevents weird scroll jumps)
    queueMicrotask(() => {
      inputEl.focus();
      setCaretToTyped();
    });
    inputEl.scrollTop = 0;
    lastDesired = 0;
    lastCaretLine = 0;
    syncGhostScroll();
    syncDurationPills();
    if (trainingCounterEl && Number.isFinite(cfg.trainingRequiredWords)) {
      trainingCounterEl.textContent = `0/${cfg.trainingRequiredWords}`;
    }
  }

  function computeStats() {
    const typed = typedValue;
    const target = promptPlain;

    const n = Math.min(typed.length, target.length);
    let correct = 0;
    for (let i = 0; i < n; i++) {
      if (typed[i] === target[i]) correct++;
    }

    const totalTyped = typed.length;
    const accuracy = totalTyped === 0 ? 0 : correct / totalTyped;

    const now = Date.now();
    const elapsedMs = started ? now - startTs : 0;
    const minutes = Math.max(1e-9, elapsedMs / 60000.0);

    const grossWpm = (totalTyped / 5.0) / minutes;
    const netWpm = grossWpm * accuracy;

    return { netWpm, accuracy };
  }

  async function submitResult(wpm, accuracy) {
    if (!cfg.ranked || !cfg.userId) return;
    try {
      const res = await fetch("/api/session_json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wpm: wpm,
          accuracy: accuracy,
          duration_seconds: cfg.durationSeconds,
          prompt_id: cfg.promptId,
        }),
      });

      const j = await res.json();
      if (!j.ok && statusEl) {
        statusEl.textContent = "Saved locally, but server responded with an error.";
      }
      if (j && typeof j.rating === "number") {
        animateElo(j.rating, j.delta || 0);
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = "Could not save result (network/server error).";
    }
  }

  function endTest(reason) {
    if (finished) return;
    finished = true;

    if (timer) clearInterval(timer);
    timer = null;
    document.body.classList.remove("typing-active");

    const { netWpm, accuracy } = computeStats();

    if (wpmEl) wpmEl.textContent = netWpm.toFixed(1);
    if (accEl) accEl.textContent = (accuracy * 100).toFixed(1);

    if (statusEl) {
      statusEl.textContent =
        reason === "completed" ? "Completed! Result saved." : "Time! Result saved.";
    }

    if (resultEl) {
      if (resultTextEl) resultTextEl.textContent = "";
      resultEl.classList.remove("hidden");
      resultEl.style.display = "block";
      resultEl.style.visibility = "visible";
      resultEl.style.opacity = "1";
    }
    if (wpmValueEl) wpmValueEl.textContent = netWpm.toFixed(1);
    if (accValueEl) accValueEl.textContent = `${(accuracy * 100).toFixed(1)}%`;
    if (wpmRingEl) {
      const progress = Math.max(0, Math.min(100, (netWpm / 150) * 100));
      wpmRingEl.style.setProperty("--wpm-progress", progress.toFixed(2));
      wpmRingEl.style.setProperty("--wpm-color", wpmColor(netWpm));
    }

    if (homeTypeboxEl) {
      homeTypeboxEl.classList.add("hidden");
      homeTypeboxEl.style.display = "none";
    }
    if (testTypeboxEl) testTypeboxEl.classList.add("hidden");
    if (trainingTypeboxEl) trainingTypeboxEl.classList.add("hidden");

    if (chartEl) {
      if (wpmSeries.length === 0) wpmSeries.push(netWpm);
      renderChart();
    }

    submitResult(netWpm, accuracy);
    if (cfg.training) {
      const elapsedSeconds = startTs ? Math.max(0, Math.round((Date.now() - startTs) / 1000)) : 0;
      const event = new CustomEvent("typinglab:ended", {
        detail: {
          training: true,
          reason,
          typedText: typedValue,
          promptText: promptPlain,
          durationSeconds: cfg.durationSeconds,
          elapsedSeconds,
          levelId: cfg.trainingLevelId || 1,
          wpm: netWpm,
          accuracy,
        },
      });
      document.dispatchEvent(event);
    }
  }

  function tick() {
    remaining -= 1;
    if (timeEl) timeEl.textContent = String(Math.max(0, remaining));

    const { netWpm, accuracy } = computeStats();

    if (cfg.liveWpm === 1) {
      if (wpmEl) wpmEl.textContent = netWpm.toFixed(1);
      if (accEl) accEl.textContent = (accuracy * 100).toFixed(1);
    }

    wpmSeries.push(netWpm);
    accSeries.push(accuracy * 100);

    if (remaining <= 0) endTest("time");
  }

  function escapeHtml(s) {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function syncGhostScroll() {
    if (!ghostEl) return;
    ghostEl.scrollTop = inputEl.scrollTop;
    ghostEl.scrollLeft = inputEl.scrollLeft;
  }

  function computeDisplayText() {
    promptPlain = (cfg.promptText || "").trim().replace(/\s+/g, " ");
    displayText = promptPlain;
    lineEnds = [];
    lineHeightPx = getLineHeightPx(inputEl);
    needsLineEnds = true;
    typedValue = "";
    if (inputEl) {
      inputEl.value = promptPlain;
      setCaretToTyped();
    }
    window.__promptPlain = promptPlain;
    window.__displayText = displayText;
    window.__lineEnds = lineEnds;
    window.__lineHeightPx = lineHeightPx;
  }

  async function refreshPrompt() {
    if (cfg.ranked || cfg.training) return;
    try {
      const res = await fetch("/api/prompt");
      const j = await res.json();
      if (j && j.prompt) {
        cfg.promptText = j.prompt;
        if (ghostEl) ghostEl.dataset.prompt = cfg.promptText;
        computeDisplayText();
        typedValue = "";
        inputEl.value = promptPlain;
        setCaretToTyped();
        renderGhost();
      }
    } catch (e) {
      // ignore; keep existing prompt
    }
  }

  async function extendPrompt(minChars = 120) {
    if (cfg.ranked) return false;
    const remaining = promptPlain.length - typedValue.length;
    if (remaining > minChars) return false;
    try {
      const res = await fetch("/api/prompt");
      const j = await res.json();
      if (!j || !j.prompt) return false;
      const extra = String(j.prompt).trim();
      if (!extra) return false;
      cfg.promptText = `${promptPlain} ${extra}`.trim();
      if (ghostEl) ghostEl.dataset.prompt = cfg.promptText;
      computeDisplayText();
      inputEl.value = promptPlain;
      setCaretToTyped();
      renderGhost();
      return true;
    } catch (e) {
      return false;
    }
  }

  function getLineHeightPx(el) {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    if (Number.isFinite(lh)) return lh;
    const fs = parseFloat(cs.fontSize) || 16;
    return fs * 1.55;
  }

  function updateLineScroll() {
    if (!lineEnds.length) return;
    const typedLen = Math.min(typedValue.length, promptPlain.length);
    let completedLines = 0;
    for (let i = 0; i < lineEnds.length; i++) {
      if (typedLen >= lineEnds[i]) completedLines = i + 1;
    }
    if (completedLines >= 1) {
      const lh = getLineHeightPx(inputEl);
      const scrollLines = Math.max(0, completedLines);
      inputEl.scrollTop = scrollLines * lh;
      syncGhostScroll();
    }
  }

  function renderGhost() {
    if (!ghostEl) return;

    const typed = typedValue;
    const target = displayText || promptPlain;

    const parts = [];
    const n = target.length;
    let typedIndex = 0;

    for (let i = 0; i < n; i++) {
      const ch = target[i];
      if (ch === "\n") {
        if (typedIndex < typed.length && typed[typedIndex] === " ") {
          typedIndex += 1;
        }
        parts.push("<br/>");
        continue;
      }
      let cls = "pending";
      if (typedIndex < typed.length) {
        cls = typed[typedIndex] === ch ? "correct" : "incorrect";
      }
      parts.push(`<span class="${cls}">${escapeHtml(ch)}</span>`);
      typedIndex += 1;
    }

    if (typed.length > promptPlain.length) {
      const extra = typed.slice(promptPlain.length);
      parts.push(`<span class="incorrect extra">${escapeHtml(extra)}</span>`);
    }

    ghostEl.innerHTML = parts.join("");
    placeGhostCaret();
    syncGhostScroll();

    if (needsLineEnds) {
      computeLineEndsFromGhost();
      needsLineEnds = false;
    }
  }

  function placeGhostCaret() {
    if (!ghostEl) return;
    let caret = ghostEl.querySelector(".ghost-caret");
    if (!caret) {
      caret = document.createElement("div");
      caret.className = "ghost-caret";
      ghostEl.appendChild(caret);
    }
    const spans = ghostEl.querySelectorAll("span");
    if (!spans.length) return;
    const atEnd = typedValue.length >= spans.length;
    const idx = Math.min(typedValue.length, spans.length - 1);
    const ref = spans[idx];
    const ghostRect = ghostEl.getBoundingClientRect();
    const refRect = ref.getBoundingClientRect();
    const left = atEnd ? refRect.right : refRect.left;
    caret.style.left = `${left - ghostRect.left}px`;
    caret.style.top = `${refRect.top - ghostRect.top}px`;
  }

  function updateLineScroll() {
    if (!lineEnds.length) return;
    const typedLen = Math.min(typedValue.length, promptPlain.length);
    let completedLines = 0;
    for (let i = 0; i < lineEnds.length; i++) {
      if (typedLen >= lineEnds[i]) completedLines = i + 1;
    }
    const lh = getLineHeightPx(inputEl);
    const scrollLines = Math.max(0, completedLines - 1);
    const desired = scrollLines * lh;
    desiredScrollTop = desired;
    if (desired !== inputEl.scrollTop) {
      smoothScrollTo(desired);
    }
  }

  function smoothScrollTo(target) {
    if (scrollAnim) cancelAnimationFrame(scrollAnim);
    const start = inputEl.scrollTop;
    const delta = target - start;
    if (Math.abs(delta) < 1) {
      inputEl.scrollTop = target;
      syncGhostScroll();
      return;
    }
    const duration = 140;
    const startTs = performance.now();
    isAutoScroll = true;
    const tick = (now) => {
      const t = Math.min(1, (now - startTs) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      inputEl.scrollTop = start + delta * eased;
      syncGhostScroll();
      if (t < 1) {
        scrollAnim = requestAnimationFrame(tick);
      } else {
        isAutoScroll = false;
        scrollAnim = null;
      }
    };
    scrollAnim = requestAnimationFrame(tick);
  }

  function computeLineEndsFromGhost() {
    if (!ghostEl) return;
    const spans = Array.from(ghostEl.querySelectorAll("span")).filter(
      (el) => !el.classList.contains("measure-span")
    );
    if (!spans.length) return;

    lineEnds = [];
    let lastTop = spans[0].offsetTop;
    const limit = Math.min(promptPlain.length, spans.length);
    for (let i = 0; i < limit; i++) {
      const top = spans[i].offsetTop;
      if (top > lastTop + 0.5) {
        lineEnds.push(i);
        lastTop = top;
      }
    }
    lineEnds.push(limit);
    window.__lineEnds = lineEnds.slice();
    window.__promptPlain = promptPlain;
    window.__displayText = displayText;
    window.__lineHeightPx = getLineHeightPx(inputEl);
  }

  function setCaretToTyped() {
    const pos = Math.max(0, typedValue.length);
    try {
      inputEl.setSelectionRange(pos, pos);
    } catch (e) {
      // ignore for non-focusable states
    }
  }

  function onTypedChanged() {
    if (!started) {
      started = true;
      startTs = Date.now();
      timer = setInterval(tick, 1000);
      if (statusEl) statusEl.textContent = "Typing…";
      if (homeTimerEl) homeTimerEl.classList.remove("hidden");
      if (testTimerEl) testTimerEl.classList.remove("hidden");
      if (trainingTimerEl) trainingTimerEl.classList.remove("hidden");
      document.body.classList.add("typing-active");
    }
    inputEl.focus();

    inputEl.value = promptPlain;
    setCaretToTyped();
    renderGhost();
    updateLineScroll();
    window.__typedLen = typedValue.length;

    if (!cfg.ranked && !cfg.training) {
      extendPrompt();
    }

    if (cfg.training) {
      const correct = getCorrectWordCount();
      const required = Number(cfg.trainingRequiredWords || 0);
      if (trainingCounterEl && required > 0) {
        trainingCounterEl.textContent = `${Math.min(correct, required)}/${required}`;
      }
      if (required > 0 && correct >= required) {
        endTest("completed");
      }
    } else if (typedValue === promptPlain) {
      if (!cfg.ranked) {
        extendPrompt();
      } else {
        endTest("completed");
      }
    }
  }

  function getLockedIndex() {
    if (!cfg.training) return 0;
    let last = 0;
    const n = Math.min(typedValue.length, promptPlain.length);
    for (let i = 0; i < n; i++) {
      if (typedValue[i] !== promptPlain[i]) break;
      if (promptPlain[i] === " ") last = i + 1;
    }
    return last;
  }

  function getCorrectWordCount() {
    const typedWords = typedValue.trim().split(/\s+/).filter(Boolean);
    const promptWords = promptPlain.trim().split(/\s+/).filter(Boolean);
    let correct = 0;
    for (let i = 0; i < typedWords.length && i < promptWords.length; i++) {
      if (typedWords[i] === promptWords[i]) correct += 1;
    }
    return correct;
  }

  inputEl.addEventListener("beforeinput", (e) => {
    if (finished) return;
    if (ignoreBeforeInput) {
      ignoreBeforeInput = false;
      e.preventDefault();
      return;
    }
    const type = e.inputType || "";

    const start = inputEl.selectionStart ?? typedValue.length;
    const end = inputEl.selectionEnd ?? typedValue.length;
    let next = typedValue;

    if (start !== end) {
      next = typedValue.slice(0, start) + typedValue.slice(end);
    }

    if (type.startsWith("delete")) {
      if (cfg.training) {
        const lockedIndex = getLockedIndex();
        if (typedValue.length <= lockedIndex) {
          e.preventDefault();
          setCaretToTyped();
          return;
        }
      }
      if (start !== end) {
        // handled above
      } else if (type === "deleteContentBackward" && next.length) {
        next = next.slice(0, -1);
      }
    } else if (cfg.training) {
      const required = Number(cfg.trainingRequiredWords || 0);
      if (required > 0) {
        const correct = getCorrectWordCount();
        if (correct >= required) {
          e.preventDefault();
          setCaretToTyped();
          return;
        }
      }
    } else if (type === "insertText" || type === "insertCompositionText") {
      const data = e.data || "";
      next = next + data;
    } else if (type === "insertFromPaste") {
      const data = (e.dataTransfer?.getData("text") || "").replace(/\s+/g, " ");
      next = next + data;
    } else {
      const data = e.data || "";
      if (data) next = next + data;
    }

    typedValue = next;
    e.preventDefault();
    onTypedChanged();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (finished) return;
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      e.preventDefault();
      setCaretToTyped();
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let next = typedValue;
    if (e.key === "Backspace") {
      if (cfg.training) {
        const lockedIndex = getLockedIndex();
        if (typedValue.length <= lockedIndex) {
          e.preventDefault();
          setCaretToTyped();
          return;
        }
      }
      if (next.length) next = next.slice(0, -1);
    } else if (e.key === "Enter") {
      next = next + "\n";
    } else if (e.key.length === 1) {
      next = next + e.key;
    } else {
      return;
    }

    typedValue = next;
    ignoreBeforeInput = true;
    e.preventDefault();
    onTypedChanged();
  });

  inputEl.addEventListener("scroll", () => {
    if (!isAutoScroll && inputEl.scrollTop !== desiredScrollTop) {
      inputEl.scrollTop = desiredScrollTop;
    }
    syncGhostScroll();
  });

  inputEl.addEventListener("wheel", (e) => {
    e.preventDefault();
  }, { passive: false });

  inputEl.addEventListener("touchmove", (e) => {
    e.preventDefault();
  }, { passive: false });

  inputEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    inputEl.focus();
    setCaretToTyped();
  });
  inputEl.addEventListener("mouseup", (e) => {
    e.preventDefault();
    setCaretToTyped();
  });
  inputEl.addEventListener("touchstart", (e) => {
    e.preventDefault();
    inputEl.focus();
    setCaretToTyped();
  }, { passive: false });

  if (restartBtn) {
    restartBtn.addEventListener("click", (e) => {
      e.preventDefault();
      reset();
    });
  }

  function syncDurationPills() {
    durationRows.forEach((row) => {
      const pills = Array.from(row.querySelectorAll(".duration-pill"));
      pills.forEach((pill) => {
        const val = Number(pill.dataset.duration || "0");
        pill.classList.toggle("is-active", val === cfg.durationSeconds);
      });
    });
  }

  if (durationRows.length) {
    durationRows.forEach((row) => {
      row.addEventListener("click", (e) => {
        const btn = e.target.closest(".duration-pill");
        if (!btn) return;
        const next = Number(btn.dataset.duration || "0");
        if (!Number.isFinite(next) || next <= 0) return;
        cfg.durationSeconds = next;
        localStorage.setItem("typing_duration_seconds", String(next));
        if (durationEl) durationEl.textContent = String(next);
        if (!started) {
          remaining = next;
          if (timeEl) timeEl.textContent = String(next);
        }
        syncDurationPills();
      });
    });
    syncDurationPills();
  }

  window.__setPrompt = (promptText, durationSeconds, levelId, requiredWords) => {
    if (typeof promptText === "string") {
      cfg.promptText = promptText;
      if (ghostEl) ghostEl.dataset.prompt = cfg.promptText;
      computeDisplayText();
    }
    if (Number.isFinite(durationSeconds)) {
      cfg.durationSeconds = durationSeconds;
      if (durationEl) durationEl.textContent = String(durationSeconds);
      if (timeEl) timeEl.textContent = String(durationSeconds);
    }
    if (Number.isFinite(levelId)) {
      cfg.trainingLevelId = levelId;
    }
    if (Number.isFinite(requiredWords)) {
      cfg.trainingRequiredWords = requiredWords;
    }
    reset();
    if (trainingTypeboxEl) trainingTypeboxEl.classList.remove("hidden");
  };

  function renderChart() {
    if (!chartEl) return;
    const ctx = chartEl.getContext("2d");
    if (!ctx) return;
    // Make canvas crisp on retina displays
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = chartEl.clientWidth || 700;
    const cssH = chartEl.clientHeight || 220;
    chartEl.width = Math.floor(cssW * dpr);
    chartEl.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;

    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 34;

    const series = wpmSeries.slice();
    if (series.length < 2) {
      chartState = null;
      return;
    }

    const steps = series.length;
    const maxY = Math.max(30, ...series) * 1.08;
    const minY = 0;

    const varHost = document.querySelector(".typing-vars") || document.body;
    const styles = getComputedStyle(varHost);

    const bg = styles.getPropertyValue("--chart-bg").trim() || "rgba(0,0,0,0.30)";
    const grid = styles.getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.08)";
    const axis = styles.getPropertyValue("--chart-axis").trim() || "rgba(255,255,255,0.70)";
    const line = styles.getPropertyValue("--chart-line").trim() || "rgba(124,58,237,0.95)";
    const glow = styles.getPropertyValue("--chart-glow").trim() || "rgba(124,58,237,0.35)";

    const fontFamily =
      styles.getPropertyValue("font-family").trim() ||
      "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const xFor = (i) => padL + (plotW * i) / (steps - 1);
    const yFor = (v) => padT + plotH - (plotH * (v - minY)) / (maxY - minY);

    // Background (rounded)
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, w, h, 12);
    ctx.fill();

    // Grid (subtle)
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    const yGridLines = 5;
    for (let i = 0; i <= yGridLines; i++) {
      const y = padT + (plotH * i) / yGridLines;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = axis;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, h - padB);
    ctx.lineTo(w - padR, h - padB);
    ctx.stroke();

    // Line (glow pass)
    ctx.save();
    ctx.strokeStyle = glow;
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = glow;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    for (let i = 0; i < steps; i++) {
      const x = xFor(i);
      const y = yFor(series[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // Line (main pass)
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 3.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < steps; i++) {
      const x = xFor(i);
      const y = yFor(series[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // Markers: peak + final
    const maxVal = Math.max(...series);
    const maxIdx = series.indexOf(maxVal);
    const lastIdx = steps - 1;
    drawDot(ctx, xFor(maxIdx), yFor(series[maxIdx]), 5, "rgba(34,197,94,0.95)");
    drawDot(ctx, xFor(lastIdx), yFor(series[lastIdx]), 5, "rgba(255,255,255,0.90)");

    // Labels
    ctx.fillStyle = axis;
    ctx.font = `12px ${fontFamily}`;

    // Y labels
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yLabels = 4;
    for (let i = 0; i <= yLabels; i++) {
      const v = Math.round((maxY * (yLabels - i)) / yLabels);
      const y = padT + (plotH * i) / yLabels;
      ctx.fillText(String(v), padL - 8, y);
    }

    // X labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const maxT = Math.max(1, steps - 1);
    for (let i = 0; i <= 4; i++) {
      const t = Math.round((maxT * i) / 4);
      const x = padL + (plotW * t) / maxT;
      ctx.fillText(String(t), x, h - padB + 8);
    }

    // Axis titles
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `12px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Time (s)", padL + plotW / 2, h - 10);
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("WPM", 0, 0);
    ctx.restore();

    // Tiny callouts
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `12px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`Peak ${maxVal.toFixed(1)}`, padL + 6, padT + 6);
    ctx.textAlign = "right";

    // Hover tooltip (if any)
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < series.length) {
      const hx = xFor(hoverIndex);
      const hy = yFor(series[hoverIndex]);

      // vertical guide
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, h - padB);
      ctx.stroke();
      ctx.restore();

      // point highlight
      drawDot(ctx, hx, hy, 5, "rgba(255,255,255,0.95)");

      // tooltip box
      const label = `${hoverIndex + 1}s · ${series[hoverIndex].toFixed(1)} WPM`;
      ctx.font = `12px ${fontFamily}`;
      const textW = ctx.measureText(label).width;
      const boxW = textW + 16;
      const boxH = 22;
      const bx = Math.min(Math.max(padL, hx - boxW / 2), w - padR - boxW);
      const by = Math.max(padT + 6, hy - 30);
      ctx.save();
      ctx.fillStyle = "rgba(7,10,20,0.9)";
      roundRect(ctx, bx, by, boxW, boxH, 8);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + boxW / 2, by + boxH / 2);
      ctx.restore();
    }

    // update chart state for hover mapping
    chartState = { padL, padR, padT, padB, plotW, plotH, w, h, steps };

    function roundRect(c, x, y, ww, hh, r) {
      const rr = Math.min(r, ww / 2, hh / 2);
      c.beginPath();
      c.moveTo(x + rr, y);
      c.arcTo(x + ww, y, x + ww, y + hh, rr);
      c.arcTo(x + ww, y + hh, x, y + hh, rr);
      c.arcTo(x, y + hh, x, y, rr);
      c.arcTo(x, y, x + ww, y, rr);
      c.closePath();
    }

    function drawDot(c, x, y, r, color) {
      c.save();
      c.fillStyle = color;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  if (chartEl) {
    chartEl.addEventListener("mousemove", (e) => {
      if (!chartState || wpmSeries.length < 2) return;
      const rect = chartEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { padL, plotW, steps } = chartState;
      const t = (x - padL) / plotW;
      const idx = Math.round(t * (steps - 1));
      const clamped = Math.max(0, Math.min(steps - 1, idx));
      if (hoverIndex !== clamped) {
        hoverIndex = clamped;
        renderChart();
      }
    });
    chartEl.addEventListener("mouseleave", () => {
      if (hoverIndex !== null) {
        hoverIndex = null;
        renderChart();
      }
    });
  }

  function wpmColor(wpm) {
    if (wpm <= 70) {
      const t = Math.max(0, Math.min(1, wpm / 70));
      return lerpColor("#ef4444", "#facc15", t);
    }
    const t = Math.max(0, Math.min(1, (wpm - 70) / 80));
    return lerpColor("#facc15", "#22c55e", t);
  }

  function lerpColor(a, b, t) {
    const ar = parseInt(a.slice(1, 3), 16);
    const ag = parseInt(a.slice(3, 5), 16);
    const ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16);
    const bg = parseInt(b.slice(3, 5), 16);
    const bb = parseInt(b.slice(5, 7), 16);
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `rgb(${rr}, ${rg}, ${rb})`;
  }

  function animateElo(newRating, delta) {
    if (!eloValueEl || !eloDeltaEl) return;
    if (typeof delta !== "number") delta = 0;
    const sign = delta >= 0 ? "+" : "";
    eloDeltaEl.textContent = `${sign}${delta}`;
    eloDeltaEl.classList.remove("positive", "negative");
    eloDeltaEl.classList.add(delta >= 0 ? "positive" : "negative");

    const start = parseInt(eloValueEl.textContent || "1500", 10) || 1500;
    const end = newRating;
    const duration = 3000;
    const startTs = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - startTs) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(start + (end - start) * eased);
      eloValueEl.textContent = String(val);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  if (restartHomeBtn) {
    restartHomeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      reset();
    });
  }

  reset();
  computeDisplayText();
  renderGhost();

  window.addEventListener("resize", () => {
    computeDisplayText();
    renderGhost();
  });

  async function updateTrainingProgressUI() {
    if (!cfg.userId) return;
    let total = 0;
    try {
      const res = await fetch("/api/training_progress");
      const j = await res.json();
      if (j && j.ok && j.progress) {
        const easy = j.progress.easy || { 1: 0, 2: 0, 3: 0 };
        const adv = j.progress.advanced || { 1: 0, 2: 0, 3: 0 };
        const hard = j.progress.hard || { 1: 0, 2: 0, 3: 0 };
        const vals = [
          easy[1] || 0,
          easy[2] || 0,
          easy[3] || 0,
          adv[1] || 0,
          adv[2] || 0,
          adv[3] || 0,
          hard[1] || 0,
          hard[2] || 0,
          hard[3] || 0,
        ];
        total = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      }
    } catch (e) {
      // ignore
    }
    const ringHome = document.getElementById("homeTrainingProgressRing");
    const valHome = document.getElementById("homeTrainingProgressValue");
    const ringTraining = document.getElementById("trainingProgressRing");
    const valTraining = document.getElementById("trainingProgressValue");
    if (ringHome) ringHome.style.setProperty("--progress", total);
    if (valHome) valHome.textContent = `${total}%`;
    if (ringTraining) ringTraining.style.setProperty("--progress", total);
    if (valTraining) valTraining.textContent = `${total}%`;
  }

  window.__updateTrainingProgress = updateTrainingProgressUI;
  updateTrainingProgressUI();
})();
