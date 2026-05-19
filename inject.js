// Injected into claude.ai's main world to intercept SSE streaming.
// Since claude.ai does NOT expose token usage in SSE, we:
// 1. Count output chars from content_block_delta events
// 2. Extract message_limit (rate limit) info
// 3. Signal turn boundaries (message_stop)

(function () {
  console.log("[CCM inject] loaded");

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    const response = await originalFetch.apply(this, args);

    if (!isStreamEndpoint(url)) return response;

    console.log("[CCM inject] intercepted:", url.slice(0, 100));
    post("CCM_TURN_START", {});

    try {
      const cloned = response.clone();
      const reader = cloned.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        (async () => {
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) processLine(line.trim());
            }
            if (buffer.trim()) processLine(buffer.trim());
          } catch (e) {
            console.log("[CCM inject] stream error:", e.message);
          }
        })();
      }
    } catch {}

    return response;
  };

  function isStreamEndpoint(url) {
    return (
      url.includes("/completion") ||
      url.includes("/retry_completion") ||
      url.includes("/append_message")
    );
  }

  function processLine(line) {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const d = JSON.parse(raw);
      route(d);
    } catch {}
  }

  function route(d) {
    const t = d.type;

    if (t === "message_start" && d.message) {
      post("CCM_MSG_START", {
        model: d.message.model || null,
        usage: d.message.usage || null,
      });
    }

    if (t === "content_block_delta" && d.delta?.text) {
      post("CCM_DELTA", { text: d.delta.text });
    }

    if (t === "message_delta") {
      post("CCM_MSG_DELTA", {
        usage: d.usage || null,
        stop_reason: d.delta?.stop_reason || null,
      });
    }

    if (t === "message_limit") {
      post("CCM_RATE_LIMIT", { message_limit: d.message_limit });
    }

    if (t === "message_stop") {
      post("CCM_TURN_END", {});
    }
  }

  function post(type, payload) {
    window.postMessage({ type, ...payload }, "*");
  }
})();
