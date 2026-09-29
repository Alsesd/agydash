// Antigravity Web Dashboard Client Application (Gruvbox Edition)

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
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchInitialData();
      showToast("Refreshed");
    });
  }
});

// Tab Navigation (both desktop and mobile)
function setupTabs() {
  const desktopTabs = document.querySelectorAll(".nav-tab");
  const mobileTabs = document.querySelectorAll(".mobile-nav-btn");

  function handleTabClick(btn) {
    const target = btn.getAttribute("data-tab");
    switchTab(target);
  }

  desktopTabs.forEach(tab => tab.addEventListener("click", () => handleTabClick(tab)));
  mobileTabs.forEach(tab => tab.addEventListener("click", () => handleTabClick(tab)));
}

function switchTab(tabId) {
  // Update desktop tabs
  document.querySelectorAll(".nav-tab").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
  });

  // Update mobile bottom nav buttons
  document.querySelectorAll(".mobile-nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
  });

  // Update panels
  document.querySelectorAll(".view-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `tab-${tabId}`);
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
      const data = JSON.parse(event.data);
      if (data) {
        if (data.limits) updateLimitsUI(data.limits);
        if (data.task) updateTaskUI(data.task);
      }
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  };

  sseSource.onerror = () => {
    // Retry polling if stream drops
    setTimeout(fetchInitialData, 4000);
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
    console.error("Error fetching dashboard data:", err);
  }
}

// Tailscale UI
function updateTailscaleUI(ts) {
  const chip = document.getElementById("tailscale-chip");
  const label = document.getElementById("tailscale-label");
  const statIp = document.getElementById("stat-tailscale-ip");
  const sshCmd = document.getElementById("ssh-cmd-text");

  if (ts.available && ts.ip) {
    currentTailscaleIp = ts.ip;
    chip.classList.add("connected");
    label.textContent = `${ts.hostname || 'nixos'}: ${ts.ip}`;
    statIp.textContent = ts.ip;
    if (sshCmd) {
      sshCmd.textContent = `ssh alsesd@${ts.ip} -t "tmux new -A -s agy"`;
    }
  } else {
    label.textContent = "0.0.0.0 (Local)";
    statIp.textContent = "127.0.0.1";
  }
}

// Limits & Quota UI
function updateLimitsUI(limits) {
  if (!limits || !limits.groups) return;

  const quotaPill = document.getElementById("quota-status-pill");
  if (quotaPill) {
    if (limits.status === "live") {
      quotaPill.textContent = "Connected Live";
      quotaPill.style.color = "var(--gb-green)";
    } else if (limits.status === "cached") {
      quotaPill.textContent = "Cached";
      quotaPill.style.color = "var(--gb-yellow)";
    } else {
      quotaPill.textContent = "Offline";
      quotaPill.style.color = "var(--gb-fg-muted)";
    }
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
    const desc = document.getElementById("quota-desc-text");
    if (desc) desc.textContent = limits.description;
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
    barElem.className = `meter-fill ${getMeterColorClass(pct, defaultClass)}`;
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

    if (days > 0) return `in ${days}d ${hours % 24}h`;
    return `in ${hours}h ${mins}m`;
  } catch (e) {
    return isoStr;
  }
}

// Current Task UI
function updateTaskUI(task) {
  if (!task) return;

  currentConvId = task.conversation_id;

  // Header Agent Chip
  const agentChip = document.getElementById("agent-chip");
  const agentLabel = document.getElementById("agent-state-label");
  const statState = document.getElementById("stat-state");

  const isRunning = task.not_fully_idle || task.status === "CASCADE_RUN_STATUS_RUNNING";
  if (isRunning) {
    agentChip.className = "agent-chip running";
    agentLabel.textContent = "Running";
    statState.textContent = "RUNNING";
    statState.style.color = "var(--gb-aqua)";
  } else {
    agentChip.className = "agent-chip connected";
    agentLabel.textContent = "Idle";
    statState.textContent = "IDLE";
    statState.style.color = "var(--gb-green)";
  }

  // Conversation Stats
  if (task.conversation_id) {
    const shortId = task.conversation_id.substring(0, 16) + "...";
    document.getElementById("task-id-text").textContent = shortId;
    document.getElementById("stat-steps").textContent = task.steps_count || 0;
  }

  // User Request
  if (task.user_request) {
    document.getElementById("task-user-request").textContent = task.user_request.trim();
  }

  // Current Action
  if (task.current_action) {
    document.getElementById("active-action-card").style.display = "block";
    document.getElementById("action-tool-name").textContent = task.current_action.tool || "executing";
    document.getElementById("action-desc").textContent = task.current_action.action || task.current_action.summary || "Agent working on task...";
    document.getElementById("action-args").textContent = JSON.stringify(task.current_action.args || {}, null, 2);
  } else if (!isRunning) {
    document.getElementById("action-tool-name").textContent = "idle";
    document.getElementById("action-desc").textContent = "Agent is waiting for next instruction.";
    document.getElementById("action-args").textContent = "No active tool call.";
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
    item.className = "timeline-entry";

    const type = st.type || "GENERIC";
    let title = type;
    let snippet = st.content || "";

    if (st.tool_calls && st.tool_calls.length > 0) {
      const tc = st.tool_calls[0];
      title = `${tc.name}`;
      snippet = tc.args ? (tc.args.toolSummary || tc.args.toolAction || JSON.stringify(tc.args)) : "";
    } else if (st.thinking) {
      title = "Reasoning";
      snippet = st.thinking.substring(0, 140) + (st.thinking.length > 140 ? "..." : "");
    }

    const timeStr = st.created_at ? new Date(st.created_at).toLocaleTimeString() : "";

    item.innerHTML = `
      <span class="timeline-idx font-mono">#${st.step_index !== undefined ? st.step_index : '-'}</span>
      <div class="timeline-meta">
        <div class="timeline-heading">
          <span class="text-aqua font-mono">${escapeHtml(title)}</span>
          <span class="text-muted text-xs">${escapeHtml(timeStr)}</span>
        </div>
        ${snippet ? `<div class="timeline-text">${escapeHtml(snippet)}</div>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

function handleQuestionState(q) {
  const banner = document.getElementById("question-banner");
  const qBadge = document.getElementById("q-badge");
  const mobileQBadge = document.getElementById("mobile-q-badge");
  const qPrompt = document.getElementById("q-prompt-text");
  const qForm = document.getElementById("question-form");
  const optionsDiv = document.getElementById("q-options-container");

  if (q && q.questions && q.questions.length > 0) {
    currentQuestionStep = q;
    banner.style.display = "flex";
    if (qBadge) qBadge.style.display = "inline-block";
    if (mobileQBadge) mobileQBadge.style.display = "flex";

    const questionObj = q.questions[0];
    document.getElementById("banner-title").textContent = "Question from Antigravity Agent";
    document.getElementById("banner-text").textContent = questionObj.question || "Tap to answer";

    qPrompt.textContent = questionObj.question;
    qForm.style.display = "block";
    optionsDiv.innerHTML = "";

    const isMulti = questionObj.is_multi_select;
    const inputType = isMulti ? "checkbox" : "radio";

    if (questionObj.options) {
      questionObj.options.forEach((opt, idx) => {
        const label = document.createElement("label");
        label.className = "q-option-item";
        label.innerHTML = `
          <input type="${inputType}" name="q-option" value="${escapeHtml(opt)}" ${idx === 0 && !isMulti ? 'checked' : ''}>
          <span>${escapeHtml(opt)}</span>
        `;
        optionsDiv.appendChild(label);
      });
    }
  } else {
    currentQuestionStep = null;
    banner.style.display = "none";
    if (qBadge) qBadge.style.display = "none";
    if (mobileQBadge) mobileQBadge.style.display = "none";
    qPrompt.textContent = "No pending questions from Antigravity.";
    qForm.style.display = "none";
  }
}

async function submitQuestionAnswer(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-submit-answer");
  btn.disabled = true;
  btn.innerHTML = `Sending...`;

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
      showToast("Please select an answer or type a note");
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
    container.innerHTML = `<div class="empty-state">No active notifications.</div>`;
    return;
  }

  container.innerHTML = "";
  notifs.forEach(n => {
    const div = document.createElement("div");
    div.className = "timeline-entry";
    div.innerHTML = `
      <span class="font-mono text-xs">🔔</span>
      <div class="timeline-meta">
        <div class="timeline-heading">${escapeHtml(n.type || "Notice")}</div>
        <div class="timeline-text">${escapeHtml(n.snippet || "")}</div>
      </div>
    `;
    container.appendChild(div);
  });
}

// Terminal Helpers & Mobile Virtual Keys
function reloadTerminal() {
  const iframe = document.getElementById("terminal-iframe");
  iframe.src = iframe.src;
  showToast("Terminal reconnected");
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

function sendKeyToTerm(key) {
  const iframe = document.getElementById("terminal-iframe");
  if (!iframe || !iframe.contentWindow) return;

  try {
    // Focus iframe
    iframe.contentWindow.focus();

    // Map keys to ANSI sequences or keyboard events
    let charCode = 0;
    let eventKey = key;
    if (key === 'Escape') charCode = 27;
    else if (key === 'Tab') charCode = 9;
    else if (key === 'Enter') charCode = 13;
    else if (key === 'CtrlC') charCode = 3;
    else if (key === 'Up') eventKey = 'ArrowUp';
    else if (key === 'Down') eventKey = 'ArrowDown';

    const evt = new KeyboardEvent('keydown', {
      key: eventKey,
      keyCode: charCode,
      which: charCode,
      bubbles: true,
      cancelable: true
    });
    iframe.contentDocument.dispatchEvent(evt);
  } catch (e) {
    console.log("Virtual key dispatch note:", e);
  }
}

function copySshCommand() {
  const ip = currentTailscaleIp || "100.109.108.22";
  const cmd = `ssh alsesd@${ip} -t "tmux new -A -s agy"`;
  navigator.clipboard.writeText(cmd).then(() => {
    showToast("Copied: " + cmd);
  });
}

function copyConvId() {
  if (currentConvId) {
    navigator.clipboard.writeText(currentConvId).then(() => {
      showToast("Copied Conversation ID");
    });
  }
}

// Toast
function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
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
