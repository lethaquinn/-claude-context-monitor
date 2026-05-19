// Content script: injects the page-level interceptor and manages the widget UI.

(function () {
  // --- Inject fetch interceptor into page world ---
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // --- State ---
  const state = {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    model: null,
    history: [],
    debug: false,
    collapsed: false,
  };

  const MODEL_CONTEXT_LIMITS = {
    "claude-sonnet-4-20250514": 200000,
    "claude-haiku-4-20250506": 200000,
    "claude-opus-4-20250514": 200000,
    "claude-sonnet-4-6-20250627": 200000,
    "claude-opus-4-6-20250725": 200000,
  };
  const DEFAULT_LIMIT = 200000;

  // --- Listen for messages from injected script ---
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;

    if (msg.type === "CCM_USAGE") {
      const u = msg.usage;
      if (u.input_tokens != null) state.inputTokens = u.input_tokens;
      if (u.output_tokens != null)
        state.outputTokens += u.output_tokens;
      if (u.cache_read_input_tokens != null)
        state.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null)
        state.cacheWrite = u.cache_creation_input_tokens;

      state.history.push({
        time: Date.now(),
        input: state.inputTokens,
        output: state.outputTokens,
      });

      updateWidget();
    }

    if (msg.type === "CCM_MODEL") {
      state.model = msg.model;
      updateWidget();
    }

    if (msg.type === "CCM_RAW_EVENT" && state.debug) {
      console.log("[CCM debug]", msg.data);
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
        <span class="ccm-toggle" title="Toggle">—</span>
      </div>
      <div class="ccm-body">
        <div class="ccm-bar-container">
          <div class="ccm-bar-fill" id="ccm-bar-fill"></div>
        </div>
        <div class="ccm-stats" id="ccm-stats"></div>
        <div class="ccm-detail" id="ccm-detail"></div>
      </div>
    `;
    document.body.appendChild(widget);

    widget.querySelector(".ccm-toggle").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      widget.classList.toggle("ccm-collapsed", state.collapsed);
      widget.querySelector(".ccm-toggle").textContent = state.collapsed
        ? "+"
        : "—";
    });

    widget.querySelector(".ccm-header").addEventListener("dblclick", () => {
      state.debug = !state.debug;
      console.log("[CCM] debug mode:", state.debug);
    });

    makeDraggable(widget);
    updateWidget();
  }

  function updateWidget() {
    if (!widget) return;

    const limit =
      MODEL_CONTEXT_LIMITS[state.model] || DEFAULT_LIMIT;
    const totalUsed = state.inputTokens + state.outputTokens;
    const pct = Math.min((totalUsed / limit) * 100, 100);
    const remaining = Math.max(limit - totalUsed, 0);

    const bar = widget.querySelector("#ccm-bar-fill");
    bar.style.width = pct + "%";
    bar.className = "ccm-bar-fill";
    if (pct > 80) bar.classList.add("ccm-danger");
    else if (pct > 50) bar.classList.add("ccm-warning");

    widget.querySelector("#ccm-stats").textContent =
      `${formatK(totalUsed)} / ${formatK(limit)} (${pct.toFixed(1)}%)`;

    widget.querySelector("#ccm-detail").innerHTML = [
      `in: ${formatK(state.inputTokens)}`,
      `out: ${formatK(state.outputTokens)}`,
      state.cacheRead ? `cr: ${formatK(state.cacheRead)}` : null,
      state.cacheWrite ? `cw: ${formatK(state.cacheWrite)}` : null,
      `rem: ${formatK(remaining)}`,
      state.model
        ? `model: ${state.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function formatK(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function makeDraggable(el) {
    let dragging = false;
    let offsetX, offsetY;
    const header = el.querySelector(".ccm-header");

    header.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ccm-toggle")) return;
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
