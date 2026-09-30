// Antigravity Hub - Single Page Application

let currentConvId = null;
let currentTailscaleIp = null;
let currentQuestionStep = null;
let sseSource = null;
let isTerminalLoaded = false;
let fallbackPollInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  setupTerminalDrawer();
  initDataFeed();

  const refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchData();
      showToast("Refreshed");
    });
  }
});

const BASE_PATH = window.location.pathname.startsWith("/agydash") ? "/agydash" : "";

// SSE Stream with Polling Fallback
function initDataFeed() {
  fetchData(); // initial fetch immediately

  if (window.EventSource) {
    try {
      if (sseSource) sseSource.close();
      sseSource = new EventSource(`${BASE_PATH}/api/stream`);

      sseSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data) {
            if (data.limits) renderLimits(data.limits);
            if (data.task) renderTask(data.task);
          }
        } catch (e) {
          console.error("SSE parse error", e);
        }
      };

      sseSource.onerror = () => {
        // SSE disconnected, fallback to polling
        startFallbackPolling();
      };
    } catch (e) {
      startFallbackPolling();
    }
  } else {
    startFallbackPolling();
  }
}

function startFallbackPolling() {
  if (fallbackPollInterval) return;
  fallbackPollInterval = setInterval(fetchData, 3000);
}

async function fetchData() {
  try {
    const [limitsRes, statusRes, tsRes] = await Promise.all([
      fetch(`${BASE_PATH}/api/limits`).then(r => r.json()).catch(() => null),
      fetch(`${BASE_PATH}/api/status`).then(r => r.json()).catch(() => null),
      fetch(`${BASE_PATH}/api/tailscale`).then(r => r.json()).catch(() => null)
    ]);

    if (limitsRes) renderLimits(limitsRes);
    if (statusRes) renderTask(statusRes);
    if (tsRes) renderTailscale(tsRes);
  } catch (err) {
    console.error("Error fetching dashboard data:", err);
  }
}

// Render Quota & Limits
function renderLimits(data) {
  if (!data || !data.groups) return;

  const syncStatus = document.getElementById("quota-sync-status");
  if (syncStatus) {
    if (data.status === "live") {
      syncStatus.textContent = "🟢 Live Synced";
      syncStatus.style.color = "var(--gb-green)";
    } else if (data.status === "cached") {
      syncStatus.textContent = "🟡 Cached";
      syncStatus.style.color = "var(--gb-yellow)";
    } else {
      syncStatus.textContent = "⚪ Offline";
      syncStatus.style.color = "var(--gb-fg-muted)";
    }
  }

  data.groups.forEach(group => {
    const isGemini = group.displayName && group.displayName.toLowerCase().includes("gemini");
    const is3p = group.displayName && (group.displayName.toLowerCase().includes("claude") || group.displayName.toLowerCase().includes("gpt"));

    if (group.buckets) {
      group.buckets.forEach(bucket => {
        const remaining = (bucket.remainingFraction !== undefined) ? bucket.remainingFraction : 1.0;
        const pct = Math.round(remaining * 100);
        const resetText = bucket.formattedReset || formatResetTime(bucket.resetTime);

        if (isGemini) {
          if (bucket.window === "weekly" || bucket.bucketId === "gemini-weekly") {
            setMeter("gemini-weekly", pct, resetText);
          } else if (bucket.window === "5h" || bucket.bucketId === "gemini-5h") {
            setMeter("gemini-5h", pct, resetText);
          }
        } else if (is3p) {
          if (bucket.window === "weekly" || bucket.bucketId === "3p-weekly") {
            setMeter("3p-weekly", pct, resetText, true);
          } else if (bucket.window === "5h" || bucket.bucketId === "3p-5h") {
            setMeter("3p-5h", pct, resetText, true);
          }
        }
      });
    }
  });
}

function setMeter(idPrefix, pct, resetText, isPurple = false) {
  const valEl = document.getElementById(`${idPrefix}-val`);
  const barEl = document.getElementById(`${idPrefix}-bar`);
  const resetEl = document.getElementById(`${idPrefix}-reset`);

  if (valEl) valEl.textContent = `${pct}%`;
  if (barEl) {
    barEl.style.width = `${pct}%`;
    barEl.className = "meter-bar";
    if (isPurple) {
      barEl.classList.add("fill-purple");
    } else {
      if (pct > 40) barEl.classList.add("fill-green");
      else if (pct > 15) barEl.classList.add("fill-yellow");
      else barEl.classList.add("fill-red");
    }
  }
  if (resetEl && resetText) {
    resetEl.textContent = `Resets: ${resetText}`;
  }
}

function formatResetTime(isoStr) {
  if (!isoStr) return "--";
  try {
    const target = new Date(isoStr);
    const now = new Date();
    const diffMs = target - now;
    if (diffMs <= 0) return "Ready";
    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return `${days}d ${remH}h`;
    }
    return `${hours}h ${mins}m`;
  } catch (e) {
    return isoStr;
  }
}

// Render Active Task
function renderTask(task) {
  if (!task) return;

  currentConvId = task.conversation_id;

  // Header status & model
  const statusChip = document.getElementById("agent-status-chip");
  const statusText = document.getElementById("agent-status-text");
  const modelText = document.getElementById("active-model-name");

  if (modelText && task.model) {
    modelText.textContent = task.model;
  }

  const isRunning = task.status === "CASCADE_RUN_STATUS_RUNNING" || task.not_fully_idle;
  if (statusChip && statusText) {
    statusChip.className = "status-chip " + (isRunning ? "running" : "idle");
    if (isRunning) {
      if (task.current_action && task.current_action.tool) {
        statusText.textContent = `Tool: ${task.current_action.tool}`;
      } else {
        statusText.textContent = "Running";
      }
    } else {
      statusText.textContent = "Idle";
    }
  }

  // Conversation Info
  const titleEl = document.getElementById("task-title");
  if (titleEl) titleEl.textContent = task.title || "Antigravity Session";

  const convIdShort = document.getElementById("conv-id-short");
  if (convIdShort && currentConvId) {
    convIdShort.textContent = `ID: ${currentConvId.slice(0, 8)}...`;
  }

  const promptEl = document.getElementById("task-prompt-content");
  if (promptEl) {
    promptEl.textContent = task.user_request || "No active prompt";
  }

  const stepsEl = document.getElementById("task-steps-count");
  if (stepsEl) {
    stepsEl.textContent = `Steps: ${task.steps_count || 0}`;
  }

  // Live Current Action
  const actionToolBadge = document.getElementById("action-tool-badge");
  const actionSummary = document.getElementById("action-summary-text");
  const actionArgs = document.getElementById("action-args-preview");

  if (task.current_action && task.current_action.tool) {
    if (actionToolBadge) actionToolBadge.textContent = task.current_action.tool;
    if (actionSummary) actionSummary.textContent = task.current_action.action || task.current_action.summary || "Executing";
    if (actionArgs) actionArgs.textContent = JSON.stringify(task.current_action.args || {}, null, 2);
  } else {
    if (actionToolBadge) actionToolBadge.textContent = isRunning ? "AGENT" : "IDLE";
    if (actionSummary) actionSummary.textContent = isRunning ? "Thinking / Planning..." : "Awaiting next user instruction";
    if (actionArgs) actionArgs.textContent = "Ready for instructions.";
  }

  // Interactive Question Card
  renderQuestion(task.pending_question);

  // Timeline
  renderTimeline(task.recent_steps);
}

// Interactive Question Answering
function renderQuestion(q) {
  const card = document.getElementById("question-card");
  if (!card) return;

  if (!q || !q.questions || q.questions.length === 0) {
    card.style.display = "none";
    currentQuestionStep = null;
    return;
  }

  currentQuestionStep = q.step_index;
  card.style.display = "block";

  const promptEl = document.getElementById("q-prompt-text");
  const optionsContainer = document.getElementById("q-options-list");

  const questionObj = q.questions[0];
  if (promptEl) {
    promptEl.textContent = questionObj.question || "Antigravity needs your input to proceed:";
  }

  if (optionsContainer) {
    optionsContainer.innerHTML = "";
    const isMulti = Boolean(questionObj.is_multi_select);
    const inputType = isMulti ? "checkbox" : "radio";

    if (questionObj.options && questionObj.options.length > 0) {
      questionObj.options.forEach((opt, idx) => {
        const label = document.createElement("label");
        label.className = "q-option-label";

        const input = document.createElement("input");
        input.type = inputType;
        input.name = "agent_q_option";
        input.value = opt;
        if (idx === 0) input.checked = true;

        const span = document.createElement("span");
        span.textContent = opt;

        label.appendChild(input);
        label.appendChild(span);
        optionsContainer.appendChild(label);
      });
    }
  }
}

async function submitAnswer(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-submit-answer");
  if (btn) btn.disabled = true;

  try {
    const selected = [];
    document.querySelectorAll("input[name='agent_q_option']:checked").forEach(inp => {
      selected.push(inp.value);
    });

    const customText = (document.getElementById("q-custom-input")?.value || "").trim();
    let finalAnswer = selected.join(", ");
    if (customText) {
      finalAnswer = finalAnswer ? `${finalAnswer} (${customText})` : customText;
    }

    if (!finalAnswer) {
      finalAnswer = "Proceed";
    }

    const res = await fetch(`${BASE_PATH}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: currentConvId,
        answer: finalAnswer,
        stepIndex: currentQuestionStep
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast("✓ Answer submitted to Antigravity!");
      const card = document.getElementById("question-card");
      if (card) card.style.display = "none";
      setTimeout(fetchData, 1000);
    } else {
      showToast("Error: " + (data.error || "Failed to submit"));
    }
  } catch (err) {
    showToast("Network error submitting answer");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Render Timeline
function renderTimeline(steps) {
  const container = document.getElementById("timeline-stream");
  const countBadge = document.getElementById("timeline-count-badge");
  if (!container) return;

  if (!steps || steps.length === 0) {
    container.innerHTML = `<div class="empty-state">No recorded steps yet.</div>`;
    return;
  }

  if (countBadge) countBadge.textContent = `${steps.length} steps`;

  let html = "";
  // Show most recent at top
  const reversed = [...steps].reverse();

  reversed.forEach(s => {
    let icon = "⚡";
    if (s.tool === "run_command") icon = "💻";
    else if (s.tool === "replace_file_content" || s.tool === "write_to_file") icon = "📝";
    else if (s.tool === "view_file") icon = "👁️";
    else if (s.tool === "ask_question") icon = "❓";
    else if (s.type === "USER_INPUT") icon = "👤";

    const desc = s.action || s.summary || (s.tool ? s.tool : "Action");

    html += `
      <div class="timeline-item">
        <span class="step-num font-mono">#${s.step_index !== undefined ? s.step_index : "-"}</span>
        <span class="step-icon">${icon}</span>
        <div class="step-desc">
          ${s.tool ? `<span class="step-tool font-mono">${s.tool}:</span>` : ""}
          <span>${escapeHtml(desc)}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Render Tailscale Info
function renderTailscale(ts) {
  if (!ts) return;

  const badgeText = document.getElementById("ts-badge-text");
  const connBadge = document.getElementById("ts-connection-badge");
  const textIp = document.getElementById("text-ts-ip");
  const dnsLink = document.getElementById("link-ts-dns");
  const portLink = document.getElementById("link-direct-port");
  const sshCode = document.getElementById("ssh-command-code");

  if (ts.available && ts.ip) {
    currentTailscaleIp = ts.ip;
    if (badgeText) badgeText.textContent = ts.hostname || "nixos";
    if (connBadge) connBadge.textContent = "Tailscale Connected";
    if (textIp) textIp.textContent = ts.ip;

    const dnsHost = ts.magic_dns || `${ts.hostname}.tail42f05a.ts.net`;
    if (dnsLink) {
      dnsLink.textContent = `https://${dnsHost}/agydash`;
      dnsLink.href = `https://${dnsHost}/agydash`;
    }

    if (portLink) {
      portLink.textContent = `http://127.0.0.1:8765`;
      portLink.href = `http://127.0.0.1:8765`;
    }

    if (sshCode) {
      sshCode.textContent = `ssh alsesd@${ts.ip} -t "tmux new -A -s agy"`;
    }
  } else {
    if (badgeText) badgeText.textContent = "Local";
    if (connBadge) connBadge.textContent = "Binding to 127.0.0.1:8765";
  }
}

// Terminal Drawer Controls
function setupTerminalDrawer() {
  const drawer = document.getElementById("terminal-drawer");
  const backdrop = document.getElementById("terminal-backdrop");
  const openBtn = document.getElementById("btn-open-terminal");
  const closeBtn = document.getElementById("btn-close-terminal");
  const placeholder = document.getElementById("terminal-placeholder");

  function openDrawer() {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    loadTerminalIframe();
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
  }

  if (openBtn) openBtn.addEventListener("click", openDrawer);
  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  if (backdrop) backdrop.addEventListener("click", closeDrawer);
  if (placeholder) placeholder.addEventListener("click", loadTerminalIframe);
}

function loadTerminalIframe() {
  const viewport = document.querySelector(".drawer-viewport");
  if (!viewport || isTerminalLoaded) return;

  viewport.innerHTML = `<iframe id="terminal-iframe" src="${BASE_PATH}/terminal/" frameborder="0" allowfullscreen></iframe>`;
  isTerminalLoaded = true;
}

function reloadTerminal() {
  const iframe = document.getElementById("terminal-iframe");
  if (iframe) {
    iframe.src = iframe.src;
    showToast("Terminal reloaded");
  } else {
    loadTerminalIframe();
  }
}

function sendKey(key) {
  const iframe = document.getElementById("terminal-iframe");
  if (!iframe) return;

  // Sends simulated key event to terminal iframe if reachable
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const canvas = doc.querySelector(".xterm-helper-textarea") || doc.querySelector("textarea") || doc.body;
    let char = "";
    if (key === "Enter") char = "\r";
    else if (key === "Tab") char = "\t";
    else if (key === "Escape") char = "\x1b";
    else if (key === "CtrlC") char = "\x03";
    else if (key === "Up") char = "\x1b[A";
    else if (key === "Down") char = "\x1b[B";
    else if (key === "Clear") char = "\x0c";

    if (canvas && char) {
      canvas.focus();
      canvas.value = char;
      const evt = new CustomEvent("input", { bubbles: true });
      canvas.dispatchEvent(evt);
    }
  } catch (e) {
    // Cross-origin restriction fallback
  }
}

// Utilities
function copyConversationId() {
  if (!currentConvId) return;
  navigator.clipboard.writeText(currentConvId).then(() => {
    showToast("Copied conversation ID");
  });
}

function copySSHCommand() {
  const code = document.getElementById("ssh-command-code")?.textContent;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    showToast("Copied SSH command");
  });
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
