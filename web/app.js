const state = {
  config: null,
  accounts: [],
  providers: [],
  metrics: [],
  recent: [],
  gfnProfiles: [],
};

const $ = (id) => document.getElementById(id);

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function fmtRelative(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function phaseBadge(phase) {
  return `<span class="badge ${phase}">${phase}</span>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function renderConfig() {
  const c = state.config ?? {};
  $("cfg-appId").value = c.appId ?? "";
  
  const selectZone = $("cfg-zone");
  const savedZone = c.zone ?? "";
  const optionExists = [...selectZone.options].some(o => o.value === savedZone);
  if (savedZone && !optionExists) {
    const opt = document.createElement("option");
    opt.value = savedZone;
    opt.textContent = `${savedZone} (Custom / Saved)`;
    selectZone.appendChild(opt);
  }
  selectZone.value = savedZone;

  $("cfg-resolution").value = c.resolution ?? "1920x1080";
  $("cfg-fps").value = c.fps ?? 60;
  $("cfg-poll").value = c.pollIntervalMs ?? 4000;
  $("cfg-cooldown").value = c.cooldownMs ?? 20000;
  $("cfg-max").value = c.maxQueueMs ?? 1800000;
  $("cfg-maxConcurrentHolding").value = c.maxConcurrentHolding ?? 2;
  $("cfg-maxConcurrentQueueing").value = c.maxConcurrentQueueing ?? 64;
  $("cfg-staggerDelay").value = c.staggerDelayMs ?? 720000;
  $("cfg-preemptive").value = c.preemptiveQueueMs ?? 600000;
  $("cfg-sessionHold").value = c.sessionHoldMs ?? 3300000;
  $("cfg-sessionBuffer").value = c.sessionBufferMs ?? 300000;
}

function renderProviders() {
  const sel = $("login-provider");
  sel.innerHTML = "";
  for (const p of state.providers) {
    const opt = document.createElement("option");
    opt.value = p.idpId;
    opt.textContent = `${p.displayName} (${p.code})`;
    sel.appendChild(opt);
  }
}

function renderAccounts() {
  const container = $("accounts-list");
  container.innerHTML = "";
  if (state.accounts.length === 0) {
    container.innerHTML = `<p class="hint">No accounts yet. Add one above.</p>`;
    return;
  }
  for (const a of state.accounts) {
    const enabled = (state.config?.enabledAccountIds ?? []).includes(a.userId);
    const currentProfile = state.config?.profileAssignments?.[a.userId] ?? "";

    const profileOptions = state.gfnProfiles.map(p => {
      const selected = p.name === currentProfile ? "selected" : "";
      return `<option value="${escapeHtml(p.name)}" ${selected}>${escapeHtml(p.name)} (${escapeHtml(p.username)})</option>`;
    }).join("");

    const node = document.createElement("div");
    node.className = "account-pill";
    if (a.phase === "needs_relogin") node.classList.add("needs-relogin");
    const needsRelogin = a.phase === "needs_relogin";
    node.innerHTML = `
      <div class="name">${escapeHtml(a.displayName ?? a.userId)} ${phaseBadge(a.phase)}</div>
      <div class="email">${escapeHtml(a.email ?? "")}</div>
      ${needsRelogin
        ? `<div class="relogin-banner">Re-login required. Tokens could not be refreshed.</div>`
        : ""}
      <div class="metric-row"><span>Scheduler</span><strong>${enabled ? "enabled" : "disabled"}</strong></div>
      <div class="metric-row"><span>Session</span><strong>${a.sessionId ? a.sessionId.slice(0, 8) + "…" : "—"}</strong></div>
      <div class="metric-row"><span>Queue</span><strong>${a.queuePosition ?? "—"}</strong></div>
      <div class="metric-row"><span>Last error</span><strong>${escapeHtml(a.lastError ?? "—")}</strong></div>
      <div class="metric-row">
        <span>GFN Profile</span>
        <select class="profile-select" data-uid="${a.userId}">
          <option value="">-- None --</option>
          ${profileOptions}
        </select>
      </div>
      <div class="row" style="margin-top: 8px;">
        ${needsRelogin
          ? `<button class="primary" data-action="retry-auth" data-uid="${a.userId}">Retry auth</button>`
          : enabled
            ? `<button class="ghost" data-action="stop" data-uid="${a.userId}">Disable</button>`
            : `<button data-action="start" data-uid="${a.userId}">Enable</button>`}
        <button class="danger" data-action="remove" data-uid="${a.userId}">Remove</button>
      </div>
    `;

    const selectEl = node.querySelector(".profile-select");
    if (selectEl) {
      selectEl.addEventListener("change", async (e) => {
        const profileName = e.target.value;
        try {
          const res = await api("/api/accounts/assign-profile", {
            method: "POST",
            body: { userId: a.userId, profileName }
          });
          if (res.config) {
            state.config = res.config;
            render();
          }
        } catch (err) {
          showToast(`Failed to assign profile: ${err.message}`, "error");
        }
      });
    }

    container.appendChild(node);
  }
}

function renderStatus() {
  const container = $("status-list");
  container.innerHTML = "";
  if (state.accounts.length === 0) {
    container.innerHTML = `<p class="hint">Add an account to start probing.</p>`;
    return;
  }
  for (const a of state.accounts) {
    const node = document.createElement("div");
    node.className = "status-pill";
    const posClass = a.phase === "ready" ? "ready" : a.queuePosition ? "" : "empty";
    node.innerHTML = `
      <div class="header">
        <div class="name">${escapeHtml(a.displayName ?? a.userId)}</div>
        ${phaseBadge(a.phase)}
      </div>
      <div class="queue-pos ${posClass}">${a.queuePosition ?? "—"}</div>
      <div class="metric-row"><span>Session</span><strong>${a.sessionId ? a.sessionId.slice(0, 8) + "…" : "—"}</strong></div>
      <div class="metric-row"><span>Server</span><strong>${escapeHtml(a.serverIp ?? "—")}</strong></div>
      <div class="metric-row"><span>Started</span><strong>${fmtRelative(a.startedAt)}</strong></div>
      <div class="metric-row"><span>Last update</span><strong>${fmtTime(a.lastUpdateAt)}</strong></div>
    `;
    container.appendChild(node);
  }
}

function renderMetrics() {
  const body = $("rank-body");
  body.innerHTML = "";
  if (state.metrics.length === 0) {
    body.innerHTML = `<tr><td colspan="11" class="hint">No samples yet — start a queue cycle.</td></tr>`;
    return;
  }
  const accountById = new Map(state.accounts.map((a) => [a.userId, a]));
  state.metrics.forEach((m, idx) => {
    const account = accountById.get(m.userId);
    const name = account?.displayName ?? m.userId.slice(0, 8);
    const tr = document.createElement("tr");
    if (idx === 0 && m.readyCount > 0) tr.classList.add("best");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(m.appId)}</td>
      <td>${m.sampleCount}</td>
      <td>${m.readyCount}</td>
      <td>${m.errorCount}</td>
      <td>${m.avgQueueMs != null ? fmtMs(m.avgQueueMs) : "—"}</td>
      <td>${m.p50QueueMs != null ? fmtMs(m.p50QueueMs) : "—"}</td>
      <td>${m.p95QueueMs != null ? fmtMs(m.p95QueueMs) : "—"}</td>
      <td>${m.fastestQueueMs != null ? fmtMs(m.fastestQueueMs) : "—"}</td>
      <td>${fmtRelative(m.lastReadyAt)}</td>
    `;
    body.appendChild(tr);
  });
}

function renderRecent() {
  const body = $("recent-body");
  body.innerHTML = "";
  if (state.recent.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="hint">No samples yet.</td></tr>`;
    return;
  }
  const accountById = new Map(state.accounts.map((a) => [a.userId, a]));
  for (const s of state.recent.slice().reverse()) {
    const account = accountById.get(s.userId);
    const name = account?.displayName ?? s.userId.slice(0, 8);
    const tr = document.createElement("tr");
    const queueMs = s.reachedReadyAt && s.startedAt ? s.reachedReadyAt - s.startedAt : null;
    tr.innerHTML = `
      <td>${fmtTime(s.startedAt)}</td>
      <td>${escapeHtml(name)}</td>
      <td>${phaseBadge(s.outcome)}</td>
      <td>${queueMs != null ? fmtMs(queueMs) : "—"}</td>
      <td>${s.reachedReadyQueuePosition ?? "—"}</td>
      <td>${escapeHtml(s.errorMessage ?? "")}</td>
    `;
    body.appendChild(tr);
  }
}

function render() {
  renderConfig();
  renderProviders();
  renderAccounts();
  renderGfnSwitcher();
  renderStatus();
  renderRotation();
  renderMetrics();
  renderRecent();
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadZones() {
  try {
    const data = await api("/api/zones");
    const select = $("cfg-zone");
    select.innerHTML = '<option value="">Default (Auto / Closest)</option>';
    
    const regions = {};
    for (const zone of data.zones) {
      if (!regions[zone.region]) {
        regions[zone.region] = [];
      }
      regions[zone.region].push(zone);
    }
    
    for (const [region, zones] of Object.entries(regions)) {
      const grp = document.createElement("optgroup");
      grp.label = region;
      for (const z of zones) {
        const opt = document.createElement("option");
        opt.value = z.id;
        let etaText = "";
        if (z.etaMs) {
          const mins = Math.ceil(z.etaMs / 60000);
          etaText = `, ~${mins}m eta`;
        }
        opt.textContent = `${z.id} (Queue: ${z.queuePosition}${etaText})`;
        grp.appendChild(opt);
      }
      select.appendChild(grp);
    }
  } catch (error) {
    console.error("Failed to load GFN zones", error);
  }
}

async function loadState() {
  try {
    const [data, dataProfiles] = await Promise.all([
      api("/api/state"),
      api("/api/gfn-profiles").catch(() => ({ profiles: [] }))
    ]);
    state.config = data.config;
    state.accounts = data.accounts;
    state.providers = data.providers;
    state.metrics = data.metrics;
    state.recent = data.recent;
    state.gfnProfiles = dataProfiles.profiles || [];
    await autoAssignProfilesByEmail();
    render();
  } catch (error) {
    console.error("loadState failed:", error);
  }
}

function renderGfnSwitcher() {
  const container = $("gfn-profile-list");
  if (!container) return;

  if (state.gfnProfiles.length === 0) {
    container.innerHTML = `<p class="hint" style="grid-column: 1/-1;">No saved GFN profiles yet. Log into GeForce NOW, then save the current login here.</p>`;
    return;
  }

  container.innerHTML = "";
  for (const profile of state.gfnProfiles) {
    const assignedCount = Object.values(state.config?.profileAssignments ?? {})
      .filter((profileName) => profileName === profile.name).length;
    const node = document.createElement("div");
    node.className = "profile-card";
    node.innerHTML = `
      <div>
        <div class="profile-name">${escapeHtml(profile.name)}</div>
        <div class="profile-meta">${escapeHtml(profile.username)} · ${escapeHtml(profile.email)}</div>
      </div>
      <div class="profile-footer">
        <span class="hint">${assignedCount} assignment${assignedCount === 1 ? "" : "s"}</span>
        <div class="profile-buttons">
          <button class="ghost" data-action="gfn-load" data-profile="${escapeHtml(profile.name)}">Switch</button>
          <button class="danger" data-action="gfn-delete" data-profile="${escapeHtml(profile.name)}">Delete</button>
        </div>
      </div>
    `;
    container.appendChild(node);
  }
}

async function refreshGfnProfiles() {
  const data = await api("/api/gfn-profiles");
  state.gfnProfiles = data.profiles || [];
}

async function saveGfnProfile(overwrite = false, force = false) {
  const input = $("gfn-profile-name");
  const profileName = input.value.trim();
  if (!profileName) {
    showToast("Enter a profile name first.", "error");
    input.focus();
    return;
  }

  try {
    const res = await api("/api/gfn-profiles/save", {
      method: "POST",
      body: { profileName, overwrite, force },
    });
    if (res.status === "running_warning") {
      if (confirm(res.message)) await saveGfnProfile(overwrite, true);
      return;
    }
    state.gfnProfiles = res.profiles || [];
    input.value = "";
    render();
    showToast(`Saved GFN profile "${profileName}".`, "success");
  } catch (error) {
    if (!overwrite && error.message.includes("409:")) {
      if (confirm(`Profile "${profileName}" already exists. Overwrite it with the current GFN login?`)) {
        await saveGfnProfile(true, force);
      }
      return;
    }
    showToast(`Save profile failed: ${error.message}`, "error");
  }
}

async function loadGfnProfile(profileName, force = false) {
  try {
    const res = await api("/api/gfn-profiles/load", {
      method: "POST",
      body: { profileName, force },
    });
    if (res.status === "running_warning") {
      if (confirm(res.message)) await loadGfnProfile(profileName, true);
      return;
    }
    state.gfnProfiles = res.profiles || state.gfnProfiles;
    render();
    showToast(`Switched GeForce NOW to "${profileName}".`, "success");
  } catch (error) {
    showToast(`Switch profile failed: ${error.message}`, "error");
  }
}

async function deleteGfnProfile(profileName) {
  if (!confirm(`Delete GFN profile "${profileName}"? Account assignments using it will be cleared.`)) return;
  try {
    const res = await api("/api/gfn-profiles/delete", {
      method: "POST",
      body: { profileName },
    });
    state.gfnProfiles = res.profiles || [];
    if (res.config) state.config = res.config;
    render();
    showToast(`Deleted GFN profile "${profileName}".`, "success");
  } catch (error) {
    showToast(`Delete profile failed: ${error.message}`, "error");
  }
}

async function startNewGfnLogin(force = false) {
  try {
    const res = await api("/api/gfn-profiles/new-login", {
      method: "POST",
      body: { force },
    });
    if (res.status === "running_warning") {
      if (confirm(res.message)) await startNewGfnLogin(true);
      return;
    }
    state.gfnProfiles = res.profiles || state.gfnProfiles;
    render();
    showToast("GeForce NOW opened with a blank login. Sign in, then save it as a profile.", "success");
  } catch (error) {
    showToast(`New GFN login failed: ${error.message}`, "error");
  }
}

async function autoAssignProfilesByEmail() {
  if (!state.config || state.gfnProfiles.length === 0) return;

  const assigned = state.config.profileAssignments ?? {};
  const updates = [];
  for (const account of state.accounts) {
    if (assigned[account.userId] || !account.email) continue;
    const matched = state.gfnProfiles.find(
      (profile) => profile.email?.toLowerCase() === account.email.toLowerCase()
    );
    if (matched) {
      updates.push(() => api("/api/accounts/assign-profile", {
        method: "POST",
        body: { userId: account.userId, profileName: matched.name },
      }));
    }
  }

  if (updates.length === 0) return;

  try {
    for (const update of updates) {
      const result = await update();
      if (result.config) state.config = result.config;
    }
  } catch (error) {
    console.error("Auto-assign failed:", error);
  }
}

async function saveConfig() {
  const patch = {
    appId: $("cfg-appId").value.trim(),
    zone: $("cfg-zone").value.trim() || undefined,
    resolution: $("cfg-resolution").value.trim() || "1920x1080",
    fps: Number($("cfg-fps").value) || 60,
    pollIntervalMs: Number($("cfg-poll").value) || 4000,
    cooldownMs: Number($("cfg-cooldown").value) || 20000,
    maxQueueMs: Number($("cfg-max").value) || 1800000,
    maxConcurrentHolding: Number($("cfg-maxConcurrentHolding").value) || 2,
    maxConcurrentQueueing: Number($("cfg-maxConcurrentQueueing").value) || 64,
    staggerDelayMs: Number($("cfg-staggerDelay").value) || 720000,
    preemptiveQueueMs: Number($("cfg-preemptive").value) || 600000,
    sessionHoldMs: Number($("cfg-sessionHold").value) || 3300000,
    sessionBufferMs: Number($("cfg-sessionBuffer").value) || 300000,
  };
  state.config = await api("/api/config", { method: "POST", body: patch });
  render();
}

async function startLogin() {
  const providerIdpId = $("login-provider").value;
  $("login-hint").textContent = "Opening browser… complete the sign-in there.";
  try {
    await api("/api/login", { method: "POST", body: { providerIdpId, openInBrowser: true } });
  } catch (error) {
    $("login-hint").textContent = `Login error: ${error.message}`;
  }
}

async function resolveGame() {
  const appIdOrUuid = $("cfg-appId").value.trim();
  if (!appIdOrUuid) {
    $("resolve-hint").textContent = "Enter a UUID or appId first.";
    return;
  }
  $("resolve-hint").textContent = "Resolving…";
  try {
    const result = await api("/api/resolve-game", { method: "POST", body: { appIdOrUuid } });
    $("cfg-appId").value = result.appId;
    $("resolve-hint").textContent = `Resolved: ${result.title} (${result.appId})`;
    await saveConfig();
  } catch (error) {
    $("resolve-hint").textContent = `Resolve failed: ${error.message}`;
  }
}

async function searchGames() {
  const query = $("search-input").value.trim();
  if (!query) {
    $("search-hint").textContent = "Enter a search query first.";
    return;
  }
  $("search-hint").textContent = "Searching games...";
  const container = $("search-results-container");
  container.innerHTML = "";
  try {
    const result = await api(`/api/games?q=${encodeURIComponent(query)}`);
    renderGameResults(result.games);
    $("search-hint").textContent = `Found ${result.games.length} games.`;
  } catch (error) {
    $("search-hint").textContent = `Search failed: ${error.message}`;
  }
}

function renderGameResults(games) {
  const container = $("search-results-container");
  container.innerHTML = "";
  if (!games || games.length === 0) {
    container.innerHTML = `<p class="hint" style="grid-column: 1/-1;">No games found.</p>`;
    return;
  }

  for (const game of games) {
    const node = document.createElement("div");
    const hasNumericId = !!game.launchAppId;
    node.className = `game-result${hasNumericId ? "" : " unavailable"}`;
    
    const storesHtml = (game.availableStores ?? [])
      .map(store => `<span class="store-badge">${escapeHtml(store)}</span>`)
      .join(" ");

    node.innerHTML = `
      <div class="thumbnail-wrapper">
        ${game.imageUrl ? `<img class="thumbnail" src="${escapeHtml(game.imageUrl)}" alt="${escapeHtml(game.title)}" />` : ""}
      </div>
      <div class="title" title="${escapeHtml(game.title)}">${escapeHtml(game.title)}</div>
      <div class="meta">
        <span>ID: ${escapeHtml(game.launchAppId ?? "Unavailable")}</span>
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">${storesHtml}</div>
      </div>
    `;

    if (hasNumericId) {
      node.addEventListener("click", async () => {
        $("cfg-appId").value = game.launchAppId;
        $("resolve-hint").textContent = `Selected: ${game.title} (${game.launchAppId})`;
        await saveConfig();
      });
    } else {
      node.addEventListener("click", () => {
        alert("This game does not have a numeric GFN launch ID and cannot be queued by the queue bot.");
      });
    }

    container.appendChild(node);
  }
}

async function controlAccount(userId, action) {
  if (action === "remove") {
    if (!confirm(`Remove account ${userId}?`)) return;
    await api("/api/accounts/remove", { method: "POST", body: { userId } });
  } else {
    await api(`/api/accounts/${action}`, { method: "POST", body: { userId } });
  }
  await loadState();
}

function renderRotation() {
  const container = $("rotation-list");
  container.innerHTML = "";
  
  const holding = state.accounts.filter(
    (a) => a.phase === "ready" || a.phase === "holding" || a.phase === "claimed"
  );
  
  if (holding.length === 0) {
    container.innerHTML = `<p class="hint" style="grid-column: 1/-1;">No holding sessions available. Accounts are staggering queues to prepare them.</p>`;
    return;
  }
  
  for (const a of holding) {
    const isBuffer = a.isBuffering === true;
    const bufferLimit = (state.config?.sessionBufferMs ?? 300000);
    const reached = a.reachedReadyAt ?? Date.now();
    const elapsed = Date.now() - reached;
    const bufferRemaining = Math.max(0, bufferLimit - elapsed);
    const holdRemaining = Math.max(0, (a.holdExpiresAt ?? Date.now()) - Date.now());
    
    const node = document.createElement("div");
    node.className = `session-card${!isBuffer ? " ready-to-claim" : ""}`;
    node.id = `rotation-session-${a.userId}`;
    
    let timerHtml = "";
    if (isBuffer) {
      timerHtml = `
        <div class="hint">Game loading buffer...</div>
        <div class="buffer-countdown" data-timestamp="${reached + bufferLimit}" data-type="buffer">
          ${fmtMs(bufferRemaining)}
        </div>
      `;
    } else {
      timerHtml = `
        <div class="hint">Time remaining in hold window:</div>
        <div class="time-remaining" data-timestamp="${a.holdExpiresAt}" data-type="hold">
          ${fmtMs(holdRemaining)}
        </div>
      `;
    }
    
    const hasProfile = !!(state.config?.profileAssignments?.[a.userId]);
    const profileName = state.config?.profileAssignments?.[a.userId] ?? "";
    
    node.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <strong style="font-size: 15px;">${escapeHtml(a.displayName ?? a.userId)}</strong>
          <div class="hint" style="margin-top: 2px;">Session: ${a.sessionId ? a.sessionId.slice(0, 8) : "—"}</div>
        </div>
        <span class="badge ${a.phase}">${a.phase}</span>
      </div>
      <div class="profile-line">
        ${hasProfile
          ? `GFN profile: <strong>${escapeHtml(profileName)}</strong>`
          : `<span class="warning">No GFN profile assigned</span>`
        }
      </div>
      
      ${timerHtml}
      
      <div class="actions">
        ${isBuffer 
          ? `<button class="claim-btn" disabled>Waiting for Buffer...</button>`
          : hasProfile
            ? `
              <button class="ghost" data-action="rotation-switch" data-uid="${a.userId}">Switch</button>
              <button class="claim-btn" data-action="play" data-uid="${a.userId}">Play</button>
            `
            : `<button class="claim-btn" disabled style="opacity: 0.6;" title="Assign a GFN Profile in the Accounts section first">Assign GFN Profile to Play</button>`
        }
      </div>
    `;
    container.appendChild(node);
  }
}

async function playSession(userId, force = false) {
  try {
    const res = await api("/api/accounts/play", { method: "POST", body: { userId, force } });
    if (res.status === "running_warning") {
      if (confirm(res.message)) {
        await playSession(userId, true);
      }
      return;
    }
    if (res.ok && res.claim) {
      const c = res.claim;
      showToast(`GFN is launching for ${c.displayName} (${c.sessionId.slice(0, 8)}).`, "success");
      await loadState();
    }
  } catch (error) {
    showToast(`Play failed: ${error.message}`, "error");
  }
}

async function switchHeldSession(userId, force = false) {
  try {
    const res = await api("/api/accounts/play", { method: "POST", body: { userId, force } });
    if (res.status === "running_warning") {
      if (confirm(res.message)) {
        await switchHeldSession(userId, true);
      }
      return;
    }
    if (res.ok && res.claim) {
      const c = res.claim;
      showToast(`Switched GFN to ${c.displayName}; bot detached from this session.`, "success");
      await loadState();
    }
  } catch (error) {
    showToast(`Switch failed: ${error.message}`, "error");
  }
}

function showToast(message, type = "info") {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => toast.classList.add("visible"), 20);
  window.setTimeout(() => {
    toast.classList.remove("visible");
    window.setTimeout(() => toast.remove(), 220);
  }, 4500);
}

function updateTimers() {
  const elements = document.querySelectorAll("[data-timestamp]");
  for (const el of elements) {
    const timestamp = Number(el.dataset.timestamp);
    const type = el.dataset.type;
    const remaining = Math.max(0, timestamp - Date.now());
    
    if (type === "buffer") {
      el.textContent = fmtMs(remaining);
      if (remaining <= 0) {
        loadState().catch(() => {});
      }
    } else if (type === "hold") {
      el.textContent = fmtMs(remaining);
      if (remaining <= 0) {
        loadState().catch(() => {});
      }
    }
  }
}

$("btn-save-config").addEventListener("click", () => saveConfig().catch((e) => alert(e.message)));
$("btn-login").addEventListener("click", () => startLogin().catch((e) => alert(e.message)));
$("btn-resolve").addEventListener("click", () => resolveGame().catch((e) => alert(e.message)));
$("btn-search-games").addEventListener("click", () => searchGames().catch((e) => alert(e.message)));
$("btn-save-gfn-profile").addEventListener("click", () => saveGfnProfile().catch((e) => showToast(e.message, "error")));
$("btn-new-gfn-login").addEventListener("click", () => startNewGfnLogin().catch((e) => showToast(e.message, "error")));
$("gfn-profile-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    saveGfnProfile().catch((e) => showToast(e.message, "error"));
  }
});
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    searchGames().catch((e) => alert(e.message));
  }
});
document.body.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.action) {
    const { action, uid, profile } = target.dataset;
    if (action === "play") {
      playSession(uid).catch((e) => alert(e.message));
    } else if (action === "rotation-switch" && uid) {
      switchHeldSession(uid).catch((e) => showToast(e.message, "error"));
    } else if (action === "retry-auth" && uid) {
      retryAuth(uid).catch((e) => showToast(e.message, "error"));
    } else if (action === "gfn-load" && profile) {
      loadGfnProfile(profile).catch((e) => showToast(e.message, "error"));
    } else if (action === "gfn-delete" && profile) {
      deleteGfnProfile(profile).catch((e) => showToast(e.message, "error"));
    } else if (action && uid) {
      controlAccount(uid, action).catch((e) => alert(e.message));
    }
  }
});

async function retryAuth(userId) {
  try {
    const res = await api("/api/accounts/retry-auth", { method: "POST", body: { userId } });
    if (res.ok) {
      showToast(`Auth recovered for account. Re-entering rotation.`, "success");
      await loadState();
    }
  } catch (error) {
    showToast(`Auth still invalid: ${error.message}`, "error");
  }
}

const evtSource = new EventSource("/api/events");
evtSource.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === "hello") return;
    if (msg.type === "config") state.config = msg.config;
    if (msg.type === "status") {
      const idx = state.accounts.findIndex((a) => a.userId === msg.status.userId);
      if (idx >= 0) state.accounts[idx] = msg.status;
    }
    if (
      msg.type === "account-added" ||
      msg.type === "account-removed" ||
      msg.type === "account-control" ||
      msg.type === "session-available" ||
      msg.type === "session-claimed" ||
      msg.type === "auth-expired" ||
      msg.type === "auth-recovered"
    ) {
      if (msg.type === "auth-expired" && msg.status?.displayName) {
        showToast(`${msg.status.displayName} needs re-login.`, "error");
      }
      if (msg.type === "auth-recovered" && msg.status?.displayName) {
        showToast(`${msg.status.displayName} recovered; re-entering rotation.`, "success");
      }
      loadState().catch(() => {});
      return;
    }
    render();
  } catch (error) {
    console.error("sse parse error", error);
  }
};

evtSource.addEventListener("error", () => {
  console.warn("SSE connection lost; will retry on next page load");
});

async function init() {
  await loadZones();
  await loadState();
  setInterval(updateTimers, 1000);
}

init().catch((e) => console.error(e));
setInterval(() => {
  loadState().catch(() => {});
}, 5000);
