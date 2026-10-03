/**
 * Antigravity Hub - Dashboard Client Application
 * Mobile-first PWA dashboard with virtual terminal keypad, live SSE,
 * dynamic workdir widget, token metrics, and interactive question answering.
 */

let currentConvId = null;
let currentQuestionStep = null;
let sseSource = null;
let fallbackPollInterval = null;
let lastLimitsData = null;
let lastTaskData = null;

const BASE_PATH = window.location.pathname.startsWith("/agydash") ? "/agydash" : "";

// 1. PWA Service Worker Registration with scope /agydash/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/agydash/sw.js', { scope: '/agydash/' })
      .then(reg => {
        console.log('PWA ServiceWorker registered with scope:', reg.scope);
      })
      .catch(err => {
        console.warn('PWA ServiceWorker registration failed:', err);
      });
  });
}

// Initialization on DOM Ready
document.addEventListener("DOMContentLoaded", () => {
  setupTerminalControls();
  initDataFeed();

  const refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchDashboardData();
      showToast("Dashboard refreshed");
    });
  }
});

// 2. Terminal Keypad Controls
function setupTerminalControls() {
  const keypad = document.getElementById("terminal-controls");
  if (!keypad) return;

  const buttons = keypad.querySelectorAll("button[data-key]");
  buttons.forEach(btn => {
    // Touchstart for rapid mobile responsiveness
    btn.addEventListener("touchstart", (e) => {
      triggerKeyFeedback(btn);
    }, { passive: true });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const keyName = btn.getAttribute("data-key");
      if (keyName) {
        sendKeyCommand(keyName, btn);
      }
    });
  });
}

function triggerKeyFeedback(btn) {
  if (navigator.vibrate) {
    try { navigator.vibrate(12); } catch (e) {}
  }
  if (btn) {
    btn.classList.add("active-press");
    setTimeout(() => btn.classList.remove("active-press"), 150);
  }
}

async function sendKeyCommand(keyName, btn) {
  triggerKeyFeedback(btn);

  try {
    const res = await fetch(`${BASE_PATH}/api/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: keyName })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error ? `Key error: ${data.error}` : `Failed to send ${keyName}`);
    }
  } catch (err) {
    showToast(`Key error: ${err.message || err}`);
  }
}

// 3. SSE Stream Connection with Polling Fallback
function initDataFeed() {
  fetchDashboardData();

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
        startPollingFallback();
      };
    } catch (e) {
      startPollingFallback();
    }
  } else {
    startPollingFallback();
  }
}

function startPollingFallback() {
  if (fallbackPollInterval) return;
  fallbackPollInterval = setInterval(fetchDashboardData, 3000);
}

async function fetchDashboardData() {
  try {
    const [limitsRes, statusRes] = await Promise.all([
      fetch(`${BASE_PATH}/api/limits`).then(r => r.json()).catch(() => null),
      fetch(`${BASE_PATH}/api/status`).then(r => r.json()).catch(() => null)
    ]);

    if (limitsRes) renderLimits(limitsRes);
    if (statusRes) renderTask(statusRes);
  } catch (err) {
    console.error("Error fetching dashboard data:", err);
  }
}

// 4. Update #workdir-widget and Session Info dynamically
function renderTask(task) {
  if (!task) return;
  lastTaskData = task;
  currentConvId = task.conversation_id;

  const isRunning = Boolean(task.active && (task.status === "CASCADE_RUN_STATUS_RUNNING" || task.not_fully_idle));

  // Top Bar updates
  const statusChip = document.getElementById("agent-status-chip");
  const statusText = document.getElementById("agent-status-text");
  const modelText = document.getElementById("active-model-name");

  if (modelText && task.model) {
    modelText.textContent = task.model;
  }

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

  // #workdir-widget updates
  const sessionStatusBadge = document.getElementById("session-status-badge");
  if (sessionStatusBadge) {
    sessionStatusBadge.textContent = isRunning ? "ACTIVE" : "IDLE";
    sessionStatusBadge.className = "badge " + (isRunning ? "active" : "");
  }

  const taskTitle = document.getElementById("task-title");
  if (taskTitle) {
    taskTitle.textContent = task.title || "Antigravity Session";
  }

  const workdirEl = document.getElementById("workdir-path");
  if (workdirEl) {
    let resolvedWorkdir = task.workdir || task.cwd || task.workspace_path || task.working_dir;
    if (!resolvedWorkdir && task.current_action && task.current_action.args && task.current_action.args.Cwd) {
      resolvedWorkdir = task.current_action.args.Cwd;
    }
    if (!resolvedWorkdir) {
      resolvedWorkdir = "/home/alsesd";
    }
    workdirEl.textContent = resolvedWorkdir;
  }

  const convIdEl = document.getElementById("conv-id-short");
  if (convIdEl) {
    convIdEl.textContent = currentConvId ? `ID: ${currentConvId.slice(0, 8)}...` : "ID: --------";
  }

  // Prompt and Current Action Box
  const promptEl = document.getElementById("task-prompt-content");
  if (promptEl) {
    const hasPrompt = Boolean(task.user_request && task.user_request.trim());
    if (isRunning && hasPrompt) {
      promptEl.textContent = task.user_request.trim();
      promptEl.classList.remove("prompt-idle");
    } else {
      promptEl.textContent = "No active session prompt";
      promptEl.classList.add("prompt-idle");
    }
  }

  const stepsEl = document.getElementById("task-steps-count");
  if (stepsEl) {
    stepsEl.textContent = `Steps: ${task.steps_count || task.step_count || 0}`;
  }

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

  // Update token counts in #token-usage-widget
  renderTokens(task);

  // Render question card if pending
  renderQuestion(task.pending_question);
}

// 5. Update #token-usage-widget with active session tokens & quota progress
function renderTokens(task) {
  const inputEl = document.getElementById("tokens-input");
  const outputEl = document.getElementById("tokens-output");
  const totalEl = document.getElementById("tokens-total");
  const stepsEl = document.getElementById("tokens-steps");

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let stepCount = 0;

  if (task && task.token_usage) {
    inputTokens = task.token_usage.input_tokens || 0;
    outputTokens = task.token_usage.output_tokens || 0;
    totalTokens = task.token_usage.total_tokens || task.token_usage.total || (inputTokens + outputTokens);
    stepCount = task.token_usage.step_count || task.steps_count || 0;
  } else if (task && task.steps_count) {
    stepCount = task.steps_count;
    totalTokens = stepCount * 1250;
    inputTokens = Math.round(totalTokens * 0.7);
    outputTokens = Math.round(totalTokens * 0.3);
  }

  if (inputEl) inputEl.textContent = formatNumber(inputTokens);
  if (outputEl) outputEl.textContent = formatNumber(outputTokens);
  if (totalEl) totalEl.textContent = formatNumber(totalTokens);
  if (stepsEl) stepsEl.textContent = formatNumber(stepCount);
}

function renderLimits(data) {
  if (!data || !data.groups) return;
  lastLimitsData = data;

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
            setQuotaMeter("gemini-weekly", pct, resetText);
          } else if (bucket.window === "5h" || bucket.bucketId === "gemini-5h") {
            setQuotaMeter("gemini-5h", pct, resetText);
          }
        } else if (is3p) {
          // Updates both Claude and GPT pool meters
          if (bucket.window === "weekly" || bucket.bucketId === "3p-weekly") {
            setQuotaMeter("claude-weekly", pct, resetText);
            setQuotaMeter("gpt-weekly", pct, resetText);
          } else if (bucket.window === "5h" || bucket.bucketId === "3p-5h") {
            setQuotaMeter("claude-5h", pct, resetText);
            setQuotaMeter("gpt-5h", pct, resetText);
          }
        }
      });
    }
  });
}

function setQuotaMeter(idPrefix, pct, resetText) {
  const valEl = document.getElementById(`${idPrefix}-val`);
  const barEl = document.getElementById(`${idPrefix}-bar`);
  const resetEl = document.getElementById(`${idPrefix}-reset`);

  if (valEl) valEl.textContent = `${pct}%`;
  if (barEl) {
    barEl.style.width = `${pct}%`;
  }
  if (resetEl && resetText) {
    resetEl.textContent = `Resets: ${resetText}`;
  }
}

// 6. Interactive Question Answering
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
    promptEl.textContent = questionObj.question || "Antigravity requires your input to proceed:";
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
      setTimeout(fetchDashboardData, 1000);
    } else {
      showToast("Error: " + (data.error || "Failed to submit"));
    }
  } catch (err) {
    showToast("Network error submitting answer");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 7. Terminal Reload
function reloadTerminal() {
  const iframe = document.getElementById("terminal-iframe");
  if (iframe) {
    iframe.src = iframe.src;
    showToast("Terminal session reloaded");
  }
}

// 8. Utilities
function copyConversationId() {
  if (!currentConvId) return;
  navigator.clipboard.writeText(currentConvId).then(() => {
    showToast("Copied Session ID");
  }).catch(() => {
    showToast(currentConvId);
  });
}

function formatNumber(num) {
  if (!num) return "0";
  return Number(num).toLocaleString();
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

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}
