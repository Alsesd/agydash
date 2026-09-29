// Antigravity Web Dashboard Client Application

let currentConvId = null;
let currentTailscaleIp = null;
let currentQuestionStep = null;
let sseSource = null;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  initSSE();
  fetchInitialData();

  // Manual refresh button
  document.getElementById("refresh-btn").addEventListener("click", () => {
    fetchInitialData();
    showToast("Dashboard refreshed");
  });
});

// Tab Navigation
function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-tab");
      switchTab(target);
    });
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
  });

  document.querySelectorAll(".tab-content").forEach(content => {
    content.classList.toggle("active", content.id === `tab-${tabId}`);
  });
}

// Server-Sent Events (SSE) Stream
function initSSE() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource("/api/stream");

  sseSource.onmessage = (event) => {
    try {
      const data = jsonParseSafe(event.data);
      if (data) {
        if (data.limits) updateLimitsUI(data.limits);
        if (data.task) updateTaskUI(data.task);
      }
      document.getElementById("live-indicator").style.opacity = "1";
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  };

  sseSource.onerror = () => {
    document.getElementById("live-indicator").style.opacity = "0.4";
    // Fallback polling if SSE disconnects
    setTimeout(fetchInitialData, 3000);
  };
}

// REST Data Fetch
async function fetchInitialData() {
  try {
    const [limitsRes, statusRes, tsRes] = await Promise.all([
      fetch("/api/limits").then(r => r.json()),
      fetch("/api/status").then(r => r.json()),
      fetch("/api/tailscale").then(r => r.json())
    ]);

    updateLimitsUI(limitsRes);
    updateTaskUI(statusRes);
    updateTailscaleUI(tsRes);
  } catch (err) {
    console.error("Error fetching initial dashboard data:", err);
  }
}

// Tailscale UI
function updateTailscaleUI(ts) {
  const pill = document.getElementById("tailscale-pill");
  const val = document.getElementById("tailscale-val");
  const statIp = document.getElementById("stat-tailscale-ip");
  const statNode = document.getElementById("stat-tailscale-node");
  const sshCmd = document.getElementById("ssh-cmd-text");

  if (ts.available && ts.ip) {
    currentTailscaleIp = ts.ip;
    pill.classList.add("connected");
    val.textContent = `${ts.hostname || 'nixos'} (${ts.ip})`;
    statIp.textContent = ts.ip;
    statNode.textContent = `Node: ${ts.hostname || 'nixos'} (Tailscale Connected)`;
    sshCmd.textContent = `ssh alsesd@${ts.ip} -t "tmux new -A -s agy"`;
  } else {
    val.textContent = "0.0.0.0 (Local)";
    statIp.textContent = "127.0.0.1";
    statNode.textContent = "Tailscale offline or disconnected";
  }
}

// Limits & Quota UI
function updateLimitsUI(limits) {
  if (!limits || !limits.groups) return;

  const quotaBadge = document.getElementById("quota-source");
  if (limits.status === "live") {
    quotaBadge.textContent = "Connected Live";
    quotaBadge.style.color = "var(--accent-green)";
    quotaBadge.style.borderColor = "rgba(0, 230, 118, 0.3)";
  } else if (limits.status === "cached") {
    quotaBadge.textContent = "Cached";
    quotaBadge.style.color = "var(--accent-amber)";
    quotaBadge.style.borderColor = "rgba(255, 179, 0, 0.3)";
  } else {
    quotaBadge.textContent = "Offline";
    quotaBadge.style.color = "var(--text-muted)";
  }

  // Iterate groups
  limits.groups.forEach(group => {
    const isGemini = group.displayName && group.displayName.toLowerCase().includes("gemini");
    const is3p = group.displayName && (group.displayName.toLowerCase().includes("claude") || group.displayName.toLowerCase().includes("gpt"));

    if (group.buckets) {
      group.buckets.forEach(bucket => {
        const remaining = (bucket.remainingFraction !== undefined) ? bucket.remainingFraction : 1.0;
        const pct = Math.round(remaining * 100);
        const resetText = formatResetTime(bucket.resetTime);

        if (isGemini) {
          if (bucket.window === "weekly" || bucket.bucketId === "gemini-weekly") {
            setMeter("gemini-weekly", pct, resetText, "fill-green");
          } else if (bucket.window === "5h" || bucket.bucketId === "gemini-5h") {
            setMeter("gemini-5h", pct, resetText, "fill-green");
          }
        } else if (is3p) {
          if (bucket.window === "weekly" || bucket.bucketId === "3p-weekly") {
            setMeter("3p-weekly", pct, resetText, "fill-purple");
          } else if (bucket.window === "5h" || bucket.bucketId === "3p-5h") {
            setMeter("3p-5h", pct, resetText, "fill-purple");
          }
        }
      });
    }
  });

  if (limits.description) {
    document.getElementById("quota-desc-text").textContent = limits.description;
  }
}

function setMeter(idPrefix, pct, resetText, defaultClass) {
  const valElem = document.getElementById(`${idPrefix}-val`);
  const barElem = document.getElementById(`${idPrefix}-bar`);
  const resetElem = document.getElementById(`${idPrefix}-reset`);

  if (valElem) valElem.textContent = `${pct}%`;
  if (resetElem) resetElem.textContent = resetText ? `Resets: ${resetText}` : "Limit fully available";

  if (barElem) {
    barElem.style.width = `${pct}%`;
    barElem.className = `progress-bar-fill ${getMeterColorClass(pct, defaultClass)}`;
  }
}

function getMeterColorClass(pct, defaultClass) {
  if (pct < 20) return "fill-red";
  if (pct < 50) return "fill-amber";
  return defaultClass;
}

function formatResetTime(isoStr) {
  if (!isoStr) return "";
  try {
    const target = new Date(isoStr);
    const now = new Date();
    const diffMs = target - now;
    if (diffMs <= 0) return "Refreshing soon";

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `in ${days}d ${hours % 24}h`;
    }
    return `in ${hours}h ${mins}m`;
  } catch (e) {
    return isoStr;
  }
}

// Current Task UI
function updateTaskUI(task) {
  if (!task) return;

  currentConvId = task.conversation_id;

  // Agent Pill
  const agentPill = document.getElementById("agent-pill");
  const agentVal = document.getElementById("agent-val");
  const statState = document.getElementById("stat-state");

  const isRunning = task.not_fully_idle || task.status === "CASCADE_RUN_STATUS_RUNNING";
  if (isRunning) {
    agentPill.className = "status-pill agent-pill running";
    agentVal.textContent = "Running";
    statState.textContent = "RUNNING";
    statState.style.color = "var(--accent-cyan)";
  } else {
    agentPill.className = "status-pill agent-pill connected";
    agentVal.textContent = "Idle";
    statState.textContent = "IDLE";
    statState.style.color = "var(--accent-green)";
  }

  // Conversation Info
  if (task.conversation_id) {
    document.getElementById("task-id-text").textContent = task.conversation_id.substring(0, 18) + "...";
    document.getElementById("stat-steps").textContent = task.steps_count || 0;
    document.getElementById("stat-conv-title").textContent = task.title || "Active Session";
    document.getElementById("task-header-subtitle").textContent = task.title || "Active Session";
  }

  // User Request
  if (task.user_request) {
    document.getElementById("task-user-request").textContent = task.user_request.trim();
  }

  // Current Action Card
  const actionCard = document.getElementById("active-action-card");
  if (task.current_action) {
    actionCard.style.display = "block";
    document.getElementById("action-tool-name").textContent = task.current_action.tool || "executing";
    document.getElementById("action-desc").textContent = task.current_action.action || task.current_action.summary || "Agent working on task...";
    document.getElementById("action-args").textContent = JSON.stringify(task.current_action.args || {}, null, 2);
  } else if (!isRunning) {
    document.getElementById("action-tool-name").textContent = "idle";
    document.getElementById("action-desc").textContent = "Agent is waiting for next instruction.";
    document.getElementById("action-args").textContent = "No active tool call in progress.";
  }

  // Timeline
  if (task.recent_steps && task.recent_steps.length > 0) {
    renderTimeline(task.recent_steps);
  }

  // Questions Banner & Pane
  handleQuestionState(task.pending_question);

  // Notifications
  renderNotifications(task.notifications || []);
}

function renderTimeline(steps) {
  const container = document.getElementById("timeline-list");
  container.innerHTML = "";

  steps.slice().reverse().forEach(st => {
    const item = document.createElement("div");
    item.className = "timeline-item";

    const type = st.type || "GENERIC";
    let title = type;
    let snippet = st.content || "";

    if (st.tool_calls && st.tool_calls.length > 0) {
      const tc = st.tool_calls[0];
      title = `Tool: ${tc.name}`;
      snippet = tc.args ? (tc.args.toolSummary || tc.args.toolAction || JSON.stringify(tc.args)) : "";
    } else if (st.thinking) {
      title = "Agent Reasoning";
      snippet = st.thinking.substring(0, 160) + (st.thinking.length > 160 ? "..." : "");
    }

    const timeStr = st.created_at ? new Date(st.created_at).toLocaleTimeString() : "";

    item.innerHTML = `
      <div class="timeline-step-badge">#${st.step_index !== undefined ? st.step_index : '-'}</div>
      <div class="timeline-body">
        <div class="timeline-title">
          <span>${escapeHtml(title)}</span>
          <span class="timeline-time">${escapeHtml(timeStr)}</span>
        </div>
        ${snippet ? `<div class="timeline-content">${escapeHtml(snippet)}</div>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

function handleQuestionState(q) {
  const banner = document.getElementById("question-banner");
  const tabBadge = document.getElementById("tab-notif-count");
  const notifBadge = document.getElementById("notif-badge");
  const qContainer = document.getElementById("question-container");
  const qPrompt = document.getElementById("q-prompt-text");
  const qForm = document.getElementById("question-form");
  const optionsDiv = document.getElementById("q-options-container");

  if (q && q.questions && q.questions.length > 0) {
    currentQuestionStep = q;
    banner.style.display = "flex";
    tabBadge.style.display = "inline-block";
    tabBadge.textContent = "1";
    notifBadge.style.display = "flex";
    notifBadge.textContent = "1";

    const questionObj = q.questions[0];
    document.getElementById("banner-title").textContent = "Question from Antigravity Agent";
    document.getElementById("banner-text").textContent = questionObj.question || "Please select an option or answer to proceed.";

    qPrompt.textContent = questionObj.question;
    qForm.style.display = "block";
    optionsDiv.innerHTML = "";

    const isMulti = questionObj.is_multi_select;
    const inputType = isMulti ? "checkbox" : "radio";

    if (questionObj.options) {
      questionObj.options.forEach((opt, idx) => {
        const tile = document.createElement("label");
        tile.className = "option-tile";
        tile.innerHTML = `
          <input type="${inputType}" name="q-option" value="${escapeHtml(opt)}" ${idx === 0 && !isMulti ? 'checked' : ''}>
          <span>${escapeHtml(opt)}</span>
        `;
        optionsDiv.appendChild(tile);
      });
    }
  } else {
    currentQuestionStep = null;
    banner.style.display = "none";
    tabBadge.style.display = "none";
    notifBadge.style.display = "none";
    qPrompt.textContent = "No pending questions from Antigravity.";
    qForm.style.display = "none";
  }
}

async function submitQuestionAnswer(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-submit-answer");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-ring"></span> Sending...`;

  try {
    const selected = [];
    document.querySelectorAll("input[name='q-option']:checked").forEach(cb => {
      selected.push(cb.value);
    });

    const customText = document.getElementById("q-custom-text").value.trim();
    let finalAnswer = selected.join("; ");
    if (customText) {
      finalAnswer = finalAnswer ? `${finalAnswer} (Note: ${customText})` : customText;
    }

    if (!finalAnswer) {
      showToast("Please select an option or enter an answer");
      btn.disabled = false;
      btn.innerHTML = `Submit Answer to Agent`;
      return;
    }

    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: currentConvId,
        answer: finalAnswer
      })
    }).then(r => r.json());

    if (res.success) {
      showToast("Answer sent to Antigravity!");
      document.getElementById("q-custom-text").value = "";
      handleQuestionState(null);
    } else {
      showToast(`Error: ${res.error || "Failed to submit"}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Submit Answer to Agent`;
  }
}

function renderNotifications(notifs) {
  const container = document.getElementById("notifications-list");
  if (!notifs || notifs.length === 0) {
    container.innerHTML = `<div class="timeline-empty">No active notifications.</div>`;
    return;
  }

  container.innerHTML = "";
  notifs.forEach(n => {
    const div = document.createElement("div");
    div.className = "timeline-item";
    div.innerHTML = `
      <div class="timeline-step-badge">🔔</div>
      <div class="timeline-body">
        <div class="timeline-title">${escapeHtml(n.type || "System Notice")}</div>
        <div class="timeline-content">${escapeHtml(n.snippet || "")}</div>
      </div>
    `;
    container.appendChild(div);
  });
}

// Terminal Helpers
function reloadTerminal() {
  const iframe = document.getElementById("terminal-iframe");
  iframe.src = iframe.src;
  showToast("Reconnected terminal session");
}

function toggleTerminalFullscreen() {
  const container = document.getElementById("terminal-container");
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(err => {
      console.warn("Fullscreen request error:", err);
    });
  } else {
    document.exitFullscreen();
  }
}

function copySshCommand() {
  const ip = currentTailscaleIp || "100.109.108.22";
  const cmd = `ssh alsesd@${ip} -t "tmux new -A -s agy"`;
  navigator.clipboard.writeText(cmd).then(() => {
    showToast("SSH command copied to clipboard!");
  });
}

function copyConvId() {
  if (currentConvId) {
    navigator.clipboard.writeText(currentConvId).then(() => {
      showToast("Conversation ID copied!");
    });
  }
}

// Toast
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

// Utility
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function jsonParseSafe(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}
