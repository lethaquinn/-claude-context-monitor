// Injected into claude.ai's main world to intercept fetch responses.
// Communicates back to content script via window.postMessage.

(function () {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (!isCompletionEndpoint(url)) return response;

    const cloned = response.clone();
    parseSSEStream(cloned.body).catch(() => {});
    return response;
  };

  function isCompletionEndpoint(url) {
    return (
      url.includes("/completion") ||
      url.includes("/chat_conversations") ||
      url.includes("/api/append_message") ||
      url.includes("/api/organizations")
    );
  }

  async function parseSSEStream(body) {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const data = JSON.parse(raw);
          handleSSEEvent(data);
        } catch {
          // not JSON, skip
        }
      }
    }
  }

  function handleSSEEvent(data) {
    // Claude.ai SSE format varies — try multiple known shapes

    // Shape 1: usage in message_delta or message_stop
    if (data.type === "message_stop" || data.type === "message_delta") {
      if (data.usage) {
        postUsage(data.usage);
      }
    }

    // Shape 2: usage at top level
    if (data.usage) {
      postUsage(data.usage);
    }

    // Shape 3: nested in message
    if (data.message?.usage) {
      postUsage(data.message.usage);
    }

    // Shape 4: completion event with model info
    if (data.model) {
      window.postMessage(
        { type: "CCM_MODEL", model: data.model },
        "*"
      );
    }

    // Shape 5: error events
    if (data.type === "error") {
      window.postMessage(
        { type: "CCM_ERROR", error: data.error },
        "*"
      );
    }

    // Debug: forward all SSE events so we can inspect the format
    window.postMessage(
      { type: "CCM_RAW_EVENT", data: summarize(data) },
      "*"
    );
  }

  function postUsage(usage) {
    window.postMessage(
      {
        type: "CCM_USAGE",
        usage: {
          input_tokens: usage.input_tokens ?? null,
          output_tokens: usage.output_tokens ?? null,
          cache_creation_input_tokens:
            usage.cache_creation_input_tokens ?? null,
          cache_read_input_tokens:
            usage.cache_read_input_tokens ?? null,
        },
      },
      "*"
    );
  }

  function summarize(obj) {
    const s = JSON.stringify(obj);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  }
})();
