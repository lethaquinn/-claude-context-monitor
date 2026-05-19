// Content script: injects interceptor, estimates tokens from DOM + SSE deltas,
// and renders the context monitor widget.

(function () {
  // --- Inject into page world ---
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // --- Token estimator ---
  // Rough heuristic: CJK ≈ 1.5 tokens/char, Latin ≈ 0.25 tokens/char, mixed ≈ 0.6
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
    // claude.ai uses content-visibility:auto on message containers,
    // which makes innerText return empty for off-screen messages.
    // Use textContent instead — it reads regardless of visibility.

    let totalText = "";

    // Primary: grab the autoscroll container (holds all message turns)
    const scrollContainer = document.querySelector(
      "[data-autoscroll-container='true']"
    );
    if (scrollContainer) {
      totalText = scrollContainer.textContent || "";
    }

    // Fallback: #main-content
    if (!totalText.trim()) {
      const main = document.querySelector("#main-content");
      if (main) totalText = main.textContent || "";
    }

    // Fallback 2: anything with the conversation classes
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

  // --- State ---
  const state = {
    model: null,
    currentOutputChars: 0,
    totalOutputTokensEstimated: 0,
    turnCount: 0,
    rateLimit: null,
    inputTokensFromAPI: null,
    outputTokensFromAPI: null,
  };

  const MODEL_LIMITS = {
    "claude-sonnet-4-20250514": 200000,
    "claude-haiku-4-20250506": 200000,
    "claude-opus-4-20250514": 200000,
    "claude-sonnet-4-6-20250627": 200000,
    "claude-opus-4-6-20250725": 200000,
  };
  const DEFAULT_LIMIT = 200000;

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

      case "CCM_TURN_END":
        state.totalOutputTokensEstimated += estimateTokens(
          "x".repeat(state.currentOutputChars)
        );
        state.turnCount++;
        state.currentOutputChars = 0;
        updateWidget();
        break;

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
          <span class="ccm-btn ccm-refresh" title="Refresh count">↻</span>
          <span class="ccm-btn ccm-toggle" title="Toggle">—</span>
        </span>
      </div>
      <div class="ccm-body">
        <div class="ccm-bar-container">
          <div class="ccm-bar-fill" id="ccm-bar-fill"></div>
        </div>
        <div class="ccm-stats" id="ccm-stats">loading...</div>
        <div class="ccm-detail" id="ccm-detail"></div>
        <div class="ccm-rate" id="ccm-rate"></div>
      </div>
    `;
    document.body.appendChild(widget);

    let collapsed = false;
    widget.querySelector(".ccm-toggle").addEventListener("click", () => {
      collapsed = !collapsed;
      widget.classList.toggle("ccm-collapsed", collapsed);
      widget.querySelector(".ccm-toggle").textContent = collapsed ? "+" : "—";
    });

    widget.querySelector(".ccm-refresh").addEventListener("click", () => {
      updateWidget();
    });

    makeDraggable(widget);

    // initial read
    setTimeout(updateWidget, 1500);
    // periodic refresh
    setInterval(updateWidget, 15000);
  }

  function updateWidget() {
    if (!widget) return;

    const conv = readConversationTokens();
    const limit = MODEL_LIMITS[state.model] || DEFAULT_LIMIT;

    // best estimate of context usage
    // If API gave us input tokens, use that; otherwise estimate from DOM
    const inputTokens = state.inputTokensFromAPI || conv.tokens;
    const outputTokens = state.outputTokensFromAPI || state.totalOutputTokensEstimated;
    const totalUsed = inputTokens + outputTokens;
    const pct = Math.min((totalUsed / limit) * 100, 100);
    const remaining = Math.max(limit - totalUsed, 0);

    // bar
    const bar = widget.querySelector("#ccm-bar-fill");
    bar.style.width = pct + "%";
    bar.className = "ccm-bar-fill";
    if (pct > 80) bar.classList.add("ccm-danger");
    else if (pct > 50) bar.classList.add("ccm-warning");

    // stats
    const apiTag = state.inputTokensFromAPI ? "" : " ~";
    widget.querySelector("#ccm-stats").textContent =
      `${apiTag}${fmtK(totalUsed)} / ${fmtK(limit)} (${pct.toFixed(1)}%)`;

    // detail
    const details = [
      `in: ${apiTag}${fmtK(inputTokens)}`,
      `out: ${apiTag}${fmtK(outputTokens)}`,
      `rem: ${fmtK(remaining)}`,
      `turns: ${state.turnCount}`,
      `chars: ${fmtK(conv.charCount)}`,
    ];
    if (state.model) {
      details.push(
        `model: ${state.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}`
      );
    }
    widget.querySelector("#ccm-detail").innerHTML = details.join(" · ");

    // rate limit
    const rateEl = widget.querySelector("#ccm-rate");
    if (state.rateLimit?.windows) {
      const w = state.rateLimit.windows;
      const parts = [];
      if (w["5h"]) parts.push(`5h: ${(w["5h"].utilization * 100).toFixed(0)}%`);
      if (w["7d"]) parts.push(`7d: ${(w["7d"].utilization * 100).toFixed(0)}%`);
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
      dragging = false;
    });
  }

  // --- Init ---
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget);
  } else {
    createWidget();
  }
})();
