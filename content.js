// Content script: injects interceptor, estimates tokens from DOM + SSE deltas,
// renders context monitor widget, warns before compression,
// tracks per-turn costs, and detects conversation switches.

(function () {
  // --- Inject into page world ---
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // --- Constants ---
  const STORAGE_KEY_POS = "ccm-widget-pos";
  const STORAGE_KEY_SP = "ccm-system-prompt-offset";
  const COMPRESSION_TARGET = 0.75;
  const COMPRESSION_DROP_RATIO = 0.3;
  const DEFAULT_LIMIT = 200000;
  const DEFAULT_SP_OFFSET = 2500;

  const MODEL_LIMITS = {
    "claude-sonnet-4-20250514": 200000,
    "claude-haiku-4-20250506": 200000,
    "claude-opus-4-20250514": 200000,
    "claude-sonnet-4-6-20250627": 200000,
    "claude-opus-4-6-20250725": 200000,
  };

  const THRESHOLDS = {
    watch: 0.5,
    warning: 0.65,
    danger: 0.75,
    critical: 0.85,
  };

  // --- Token estimator ---
  function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0;
    let latin = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk++;
      } else {
        latin++;
      }
    }
    return Math.ceil(cjk * 1.5 + latin * 0.25);
  }

  // --- Read conversation from DOM ---
  function readConversationTokens() {
    let totalText = "";
    const scrollContainer = document.querySelector(
      "[data-autoscroll-container='true']"
    );
    if (scrollContainer) {
      totalText = scrollContainer.textContent || "";
    }
    if (!totalText.trim()) {
      const main = document.querySelector("#main-content");
      if (main) totalText = main.textContent || "";
    }
    if (!totalText.trim()) {
      const el =
        document.querySelector("[class*='conversation']") ||
        document.querySelector("[role='main']");
      if (el) totalText = el.textContent || "";
    }
    return {
      text: totalText,
      tokens: estimateTokens(totalText),
      charCount: totalText.length,
    };
  }

  // --- Get conversation ID from URL ---
  function getConversationId() {
    const match = location.pathname.match(
      /\/chat\/([0-9a-f-]+)/
    );
    return match ? match[1] : location.pathname;
  }

  // --- State ---
  const state = {
    model: null,
    currentOutputChars: 0,
    totalOutputTokensEstimated: 0,
    turnCount: 0,
    rateLimit: null,
    inputTokensFromAPI: null,
    outputTokensFromAPI: null,
    prevCharCount: 0,
    compressionDetected: false,
    compressionCount: 0,
    alertLevel: "normal",
    alertDismissed: false,
    // v0.4 additions
    conversationId: getConversationId(),
    turnTokenHistory: [],
    prevTurnTokenSnapshot: null, // DOM tokens at end of last turn
    systemPromptOffset: loadSystemPromptOffset(),
    collapsed: false,
    settingsOpen: false,
  };

  function loadSystemPromptOffset() {
    try {
      const v = localStorage.getItem(STORAGE_KEY_SP);
      return v ? parseInt(v, 10) : DEFAULT_SP_OFFSET;
    } catch {
      return DEFAULT_SP_OFFSET;
    }
  }

  function saveSystemPromptOffset(val) {
    try {
      localStorage.setItem(STORAGE_KEY_SP, String(val));
    } catch {}
  }

  function resetForNewConversation() {
    state.currentOutputChars = 0;
    state.totalOutputTokensEstimated = 0;
    state.turnCount = 0;
    state.rateLimit = null;
    state.inputTokensFromAPI = null;
    state.outputTokensFromAPI = null;
    state.prevCharCount = 0;
    state.compressionDetected = false;
    state.compressionCount = 0;
    state.alertLevel = "normal";
    state.alertDismissed = false;
    state.turnTokenHistory = [];
    state.prevTurnTokenSnapshot = null;
  }

  // --- Conversation switch detection ---
  function checkConversationSwitch() {
    const newId = getConversationId();
    if (newId !== state.conversationId) {
      state.conversationId = newId;
      resetForNewConversation();
      updateWidget();
    }
  }

  // Watch for URL changes (claude.ai uses client-side navigation)
  let lastHref = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(checkConversationSwitch, 500);
    }
  });
  urlObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("popstate", () =>
    setTimeout(checkConversationSwitch, 500)
  );

  // --- Turns-to-compression estimate ---
  function estimateTurnsLeft(totalUsed, limit) {
    if (state.turnTokenHistory.length === 0) return null;
    const avgPerTurn =
      state.turnTokenHistory.reduce((a, b) => a + b, 0) /
      state.turnTokenHistory.length;
    if (avgPerTurn <= 0) return null;
    const compressionThreshold = limit * COMPRESSION_TARGET;
    const remaining = compressionThreshold - totalUsed;
    if (remaining <= 0) return 0;
    return Math.floor(remaining / avgPerTurn);
  }

  // --- Listen for messages from inject.js ---
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;

    switch (msg.type) {
      case "CCM_MSG_START":
        if (msg.model) state.model = msg.model;
        if (msg.usage?.input_tokens) {
          state.inputTokensFromAPI = msg.usage.input_tokens;
        }
        break;

      case "CCM_DELTA":
        state.currentOutputChars += msg.text.length;
        break;

      case "CCM_MSG_DELTA":
        if (msg.usage?.output_tokens) {
          state.outputTokensFromAPI = msg.usage.output_tokens;
        }
        break;

      case "CCM_TURN_START":
        state.currentOutputChars = 0;
        break;

      case "CCM_TURN_END": {
        const turnTokens = estimateTokens(
          "x".repeat(state.currentOutputChars)
        );
        state.totalOutputTokensEstimated += turnTokens;
        state.turnCount++;

        // record per-turn cost: delta in DOM tokens + output tokens
        const conv = readConversationTokens();
        const domTokensNow = conv.tokens + state.systemPromptOffset;

        let turnCost;
        if (state.prevTurnTokenSnapshot === null) {
          // first turn since load: only count user message + response,
          // not the entire pre-existing conversation
          turnCost = turnTokens + estimateTokens("x".repeat(state.currentOutputChars > 0 ? 200 : 0));
        } else {
          // subsequent turns: measure how much DOM grew + output
          const inputDelta = Math.max(domTokensNow - state.prevTurnTokenSnapshot, 0);
          turnCost = inputDelta + turnTokens;
        }
        state.prevTurnTokenSnapshot = domTokensNow;
        state.turnTokenHistory.push(Math.max(turnCost, 100));

        state.currentOutputChars = 0;
        updateWidget();
        break;
      }

      case "CCM_RATE_LIMIT":
        state.rateLimit = msg.message_limit;
        updateWidget();
        break;

      case "CCM_MODEL":
        state.model = msg.model;
        updateWidget();
        break;
    }
  });

  // --- Widget ---
  let widget = null;

  function createWidget() {
    widget = document.createElement("div");
    widget.id = "ccm-widget";
    widget.innerHTML = `
      <div class="ccm-header">
        <span class="ccm-title">ctx</span>
        <span class="ccm-actions">
          <span class="ccm-btn ccm-settings-btn" title="Settings">⚙</span>
          <span class="ccm-btn ccm-refresh" title="Refresh count">↻</span>
          <span class="ccm-btn ccm-toggle" title="Toggle">—</span>
        </span>
      </div>
      <div class="ccm-body">
        <div class="ccm-bar-container">
          <div class="ccm-bar-fill" id="ccm-bar-fill"></div>
          <div class="ccm-bar-marker" id="ccm-bar-marker" title="Est. compression zone"></div>
        </div>
        <div class="ccm-stats" id="ccm-stats">loading...</div>
        <div class="ccm-detail" id="ccm-detail"></div>
        <div class="ccm-turns-left" id="ccm-turns-left"></div>
        <div class="ccm-alert" id="ccm-alert"></div>
        <div class="ccm-rate" id="ccm-rate"></div>
        <div class="ccm-settings" id="ccm-settings">
          <label class="ccm-settings-label">
            System prompt offset (tokens):
            <input type="number" id="ccm-sp-input" class="ccm-sp-input"
              min="0" max="50000" step="500" value="${state.systemPromptOffset}">
          </label>
          <div class="ccm-settings-hint">
            Includes claude.ai's built-in system prompt + your project instructions.
            Default: 2500. If you have long project instructions, increase this.
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(widget);

    // --- Toggle ---
    widget.querySelector(".ccm-toggle").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      widget.classList.toggle("ccm-collapsed", state.collapsed);
      widget.querySelector(".ccm-toggle").textContent = state.collapsed
        ? "+"
        : "—";
    });

    // --- Refresh ---
    widget.querySelector(".ccm-refresh").addEventListener("click", () => {
      updateWidget();
    });

    // --- Settings ---
    widget
      .querySelector(".ccm-settings-btn")
      .addEventListener("click", () => {
        state.settingsOpen = !state.settingsOpen;
        widget.querySelector("#ccm-settings").style.display =
          state.settingsOpen ? "block" : "none";
      });

    widget
      .querySelector("#ccm-sp-input")
      .addEventListener("change", (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 0) {
          state.systemPromptOffset = val;
          saveSystemPromptOffset(val);
          updateWidget();
        }
      });

    // --- Dismiss alert ---
    widget.querySelector("#ccm-alert").addEventListener("click", () => {
      state.alertDismissed = true;
      widget.querySelector("#ccm-alert").style.display = "none";
      widget.classList.remove("ccm-pulse");
    });

    makeDraggable(widget);
    restorePosition(widget);

    setTimeout(updateWidget, 1500);
    setInterval(updateWidget, 15000);
  }

  function updateWidget() {
    if (!widget) return;

    const conv = readConversationTokens();
    const limit = MODEL_LIMITS[state.model] || DEFAULT_LIMIT;

    // --- Compression detection ---
    if (
      state.prevCharCount > 500 &&
      conv.charCount > 0 &&
      conv.charCount < state.prevCharCount * (1 - COMPRESSION_DROP_RATIO)
    ) {
      state.compressionDetected = true;
      state.compressionCount++;
      state.alertDismissed = false;
      state.totalOutputTokensEstimated = 0;
      state.inputTokensFromAPI = null;
      state.outputTokensFromAPI = null;
      state.turnTokenHistory = [];
    }
    state.prevCharCount = conv.charCount;

    // --- Token calculation (include system prompt offset) ---
    const inputTokens =
      state.inputTokensFromAPI ||
      conv.tokens + state.systemPromptOffset;
    const outputTokens =
      state.outputTokensFromAPI || state.totalOutputTokensEstimated;
    const totalUsed = inputTokens + outputTokens;
    const pct = Math.min((totalUsed / limit) * 100, 100);
    const ratio = totalUsed / limit;
    const remaining = Math.max(limit - totalUsed, 0);

    // --- Alert level ---
    let newLevel = "normal";
    if (ratio >= THRESHOLDS.critical) newLevel = "critical";
    else if (ratio >= THRESHOLDS.danger) newLevel = "danger";
    else if (ratio >= THRESHOLDS.warning) newLevel = "warning";
    else if (ratio >= THRESHOLDS.watch) newLevel = "watch";

    if (newLevel !== state.alertLevel) {
      state.alertDismissed = false;
      state.alertLevel = newLevel;
    }

    // --- Bar ---
    const bar = widget.querySelector("#ccm-bar-fill");
    bar.style.width = pct + "%";
    bar.className = "ccm-bar-fill";
    if (newLevel === "critical") bar.classList.add("ccm-critical");
    else if (newLevel === "danger") bar.classList.add("ccm-danger");
    else if (newLevel === "warning") bar.classList.add("ccm-warning");

    // compression zone marker on bar
    const marker = widget.querySelector("#ccm-bar-marker");
    marker.style.left = COMPRESSION_TARGET * 100 + "%";

    // --- Pulse ---
    if (
      (newLevel === "danger" || newLevel === "critical") &&
      !state.alertDismissed
    ) {
      widget.classList.add("ccm-pulse");
    } else {
      widget.classList.remove("ccm-pulse");
    }

    // --- Stats ---
    const apiTag = state.inputTokensFromAPI ? "" : " ~";
    widget.querySelector("#ccm-stats").textContent =
      `${apiTag}${fmtK(totalUsed)} / ${fmtK(limit)} (${pct.toFixed(1)}%)`;

    // --- Detail ---
    const details = [
      `in: ${apiTag}${fmtK(inputTokens)}`,
      `out: ${apiTag}${fmtK(outputTokens)}`,
      `rem: ${fmtK(remaining)}`,
      `turns: ${state.turnCount}`,
      `chars: ${fmtK(conv.charCount)}`,
    ];
    if (state.systemPromptOffset > 0) {
      details.push(`sp: ~${fmtK(state.systemPromptOffset)}`);
    }
    if (state.model) {
      details.push(
        `model: ${state.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}`
      );
    }
    widget.querySelector("#ccm-detail").innerHTML = details.join(" · ");

    // --- Turns left estimate ---
    const turnsLeftEl = widget.querySelector("#ccm-turns-left");
    const turnsLeft = estimateTurnsLeft(totalUsed, limit);
    if (turnsLeft !== null) {
      const avgPerTurn =
        state.turnTokenHistory.reduce((a, b) => a + b, 0) /
        state.turnTokenHistory.length;
      turnsLeftEl.textContent =
        `~${turnsLeft} turns to compression (avg ${fmtK(Math.round(avgPerTurn))}/turn)`;
      turnsLeftEl.style.display = "block";
      turnsLeftEl.className = "ccm-turns-left";
      if (turnsLeft <= 3) turnsLeftEl.classList.add("ccm-turns-critical");
      else if (turnsLeft <= 8) turnsLeftEl.classList.add("ccm-turns-warning");
    } else {
      turnsLeftEl.style.display = "none";
    }

    // --- Alert ---
    const alertEl = widget.querySelector("#ccm-alert");
    if (state.compressionDetected) {
      alertEl.textContent = `context compressed (#${state.compressionCount}) — estimates reset`;
      alertEl.className = "ccm-alert ccm-alert-compression";
      alertEl.style.display = "block";
      state.compressionDetected = false;
    } else if (newLevel !== "normal" && !state.alertDismissed) {
      const msg = {
        normal: "",
        watch: "50% — context half used",
        warning: "65% — compression zone approaching",
        danger: "75% — compression likely soon",
        critical: "85% — compression imminent",
      };
      alertEl.textContent = msg[newLevel];
      alertEl.className = `ccm-alert ccm-alert-${newLevel}`;
      alertEl.style.display = "block";
    } else {
      alertEl.style.display = "none";
    }

    // --- Rate limit ---
    const rateEl = widget.querySelector("#ccm-rate");
    if (state.rateLimit?.windows) {
      const w = state.rateLimit.windows;
      const parts = [];
      if (w["5h"])
        parts.push(`5h: ${(w["5h"].utilization * 100).toFixed(0)}%`);
      if (w["7d"])
        parts.push(`7d: ${(w["7d"].utilization * 100).toFixed(0)}%`);
      rateEl.textContent = `rate limit: ${parts.join(" · ")}`;
      rateEl.style.display = "block";
    } else {
      rateEl.style.display = "none";
    }
  }

  function fmtK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  // --- Draggable + position persistence ---
  function makeDraggable(el) {
    let dragging = false;
    let offsetX, offsetY;
    const header = el.querySelector(".ccm-header");

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".ccm-btn")) return;
      dragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - offsetX + "px";
      el.style.top = e.clientY - offsetY + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        savePosition(el);
      }
    });
  }

  function savePosition(el) {
    try {
      const rect = el.getBoundingClientRect();
      localStorage.setItem(
        STORAGE_KEY_POS,
        JSON.stringify({ left: rect.left, top: rect.top })
      );
    } catch {}
  }

  function restorePosition(el) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_POS);
      if (saved) {
        const pos = JSON.parse(saved);
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 40;
        if (pos.left >= 0 && pos.left < maxX && pos.top >= 0 && pos.top < maxY) {
          el.style.left = pos.left + "px";
          el.style.top = pos.top + "px";
          el.style.right = "auto";
          el.style.bottom = "auto";
        }
      }
    } catch {}
  }

  // --- Init ---
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget);
  } else {
    createWidget();
  }
})();
