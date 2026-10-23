const STORAGE_KEY = "xiaoyu-assistant-state-v1";
const DIFFICULTY = { simple: 1, normal: 1.5, hard: 2.5 };
const TYPE_LABEL = { regular: "Regular Task", standalone: "Standalone Task", "long-term": "Long-term Task", subtask: "Sub-task" };
const TAG_COLORS = ["#8EA1B5", "#9CAF88", "#C08A8A", "#CDBBA0", "#A697B5", "#D9A05B", "#86A3A3", "#D8B4B4"];
const DEFAULT_TAG_COLOR = { regular: "#8EA1B5", standalone: "#D9A05B", "long-term": "#86A3A3", subtask: "#8EA1B5" };
const PENDING_SYNC_KEY = `${STORAGE_KEY}:pending-cloud`;
const CLOUD_BACKUP_KEY = `${STORAGE_KEY}:cloud-backup`;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SUPABASE_URL = "https://wqbrteepiwfzgznsuahs.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_c3IgjWyKNWBXI8Fa3XV7jA_0RdSj_1H";
const CLOUD_SYNC_DELAY = 700;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const isoDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const parseDate = (value) => new Date(`${value}T00:00:00`);
const todayIso = () => isoDate(new Date());
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const defaultHabits = [
  { id: "habit-exercise", name: "锻炼", frequency: "weekly", cadence: "weekly", kpi: 3, checkins: [] },
  { id: "habit-reading", name: "阅读", frequency: "weekly", cadence: "weekly", kpi: 4, checkins: [] },
  { id: "habit-water", name: "喝水", frequency: "weekly", cadence: "weekly", kpi: 7, checkins: [] },
  { id: "habit-skincare", name: "护肤", frequency: "weekly", cadence: "weekly", kpi: 5, checkins: [] },
  { id: "habit-words", name: "背单词", frequency: "weekly", cadence: "weekly", kpi: 5, checkins: [] },
  { id: "habit-podcast", name: "听博客", frequency: "monthly", cadence: "monthly", kpi: 8, checkins: [] },
];

const state = loadState();
let selectedDate = todayIso();
let currentTab = "board";
let currentView = "assignment";
let showIncompleteOnly = false;
let pendingImport = null;
let currentDetailTaskId = null;
let currentDetailMode = "readonly";
let pendingCompletion = null;
let supabaseClient = null;
let cloudSession = null;
let cloudSyncTimer = null;
let cloudSyncInFlight = false;
let cloudSyncReady = false;
let cloudClientReady = false;
let cloudStateVersion = 0;
let cloudSyncedVersion = 0;
let cloudRealtimeChannel = null;
let cloudSyncError = "";

function readPendingCloudState() {
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_SYNC_KEY));
    return pending?.state && typeof pending.state === "object" ? pending : null;
  } catch (error) {
    console.warn("Could not read pending cloud changes", error);
    return null;
  }
}

function markPendingCloudState(updatedAt) {
  localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify({ state: JSON.parse(JSON.stringify(state)), updatedAt }));
}

function clampProgress(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function normalizeTaskChild(child, parent, index) {
  const { actualSeconds: legacySeconds, actualMinutes: legacyMinutes, ...childData } = child;
  const legacyDuration = legacySeconds != null ? Number(legacySeconds) / 60 : legacyMinutes != null ? Number(legacyMinutes) : 0;
  const actualDuration = Math.max(0, Math.round(Number(child.actualDuration ?? legacyDuration) || 0));
  const progress = clampProgress(child.progress);
  return {
    ...childData,
    id: child.id || uid("subtask"),
    title: String(child.title || `Subtask ${index + 1}`).trim(),
    date: dateKey(child.date || parent.scheduledDate || todayIso()),
    startTime: child.startTime || "",
    endTime: child.endTime || "",
    estimateHours: Math.max(.25, Number(child.estimateHours || 1) || 1),
    actualDuration,
    progress,
    status: child.status || (progress >= 100 ? "pending_confirmation" : progress > 0 ? "in_progress" : "not_started"),
    sortOrder: Number.isFinite(Number(child.sortOrder)) ? Number(child.sortOrder) : index,
  };
}
function normalizeTask(task, index) {
  const { actualSeconds: legacySeconds, actualMinutes: legacyMinutes, ...taskData } = task;
  const legacyDuration = legacySeconds != null ? Number(legacySeconds) / 60 : legacyMinutes != null ? Number(legacyMinutes) : 0;
  const actualDuration = Math.max(0, Math.round(Number(task.actualDuration ?? legacyDuration) || 0));
  const normalized = {
    ...taskData,
    id: task.id || uid("task"),
    title: String(task.title || "Untitled task").trim(),
    scheduledDate: dateKey(task.scheduledDate || todayIso()),
    deadline: task.deadline ? dateKey(task.deadline) : "",
    estimateHours: Math.max(.25, Number(task.estimateHours || 1) || 1),
    progress: clampProgress(task.progress),
    status: task.status || "not_started",
    actualDuration,
    startTime: task.startTime || "",
    endTime: task.endTime || "",
    children: [],
    sortOrder: Number.isFinite(Number(task.sortOrder)) ? Number(task.sortOrder) : index,
  };
  normalized.children = Array.isArray(task.children) ? task.children.map((child, childIndex) => normalizeTaskChild(child, normalized, childIndex)) : [];
  return normalized;
}

function normalizeState(saved = {}) {
  return {
    ...saved,
    tasks: (saved.tasks || []).filter((task) => task && task.title).map(normalizeTask),
    courses: saved.courses || [],
    events: saved.events || [],
    habits: (saved.habits || defaultHabits).map((habit) => ({ ...habit, frequency: habit.frequency || habit.cadence || "weekly", cadence: habit.frequency || habit.cadence || "weekly", checkins: habit.checkins || [] })),
    courseMeta: saved.courseMeta || null,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return normalizeState(saved);
  } catch (error) { console.warn("Could not load local data", error); }
  return {
    tasks: [
      { id: "demo-1", type: "regular", title: "整理本周学习计划", notes: "把课程、作业和可用时间放到同一条时间轴里。", scheduledDate: todayIso(), deadline: todayIso(), estimateHours: 1.5, difficulty: "normal", progress: 60, status: "in_progress", actualDuration: 42, startTime: "09:00", endTime: "10:30", children: [], tagColor: "#8EA1B5", createdAt: new Date().toISOString() },
      { id: "demo-2", type: "standalone", title: "回复一封重要邮件", notes: "", scheduledDate: todayIso(), deadline: todayIso(), estimateHours: 0.5, difficulty: "simple", progress: 0, status: "not_started", actualDuration: 0, startTime: "16:00", endTime: "16:30", children: [], tagColor: "#D9A05B", createdAt: new Date().toISOString() },
      { id: "demo-long", type: "long-term", title: "建立个人学习系统", notes: "第一版先完成任务、课程和习惯基础。", scheduledDate: todayIso(), deadline: "2026-12-31", estimateHours: 20, difficulty: "hard", progress: 33, status: "in_progress", actualDuration: 90, children: [
        { id: "demo-long-1", title: "整理需求文档", date: todayIso(), progress: 100, status: "done", estimateHours: 2 },
        { id: "demo-long-2", title: "搭建任务页", date: todayIso(), progress: 100, status: "done", estimateHours: 4 },
        { id: "demo-long-3", title: "接入课程导入", date: "2026-10-24", progress: 0, status: "not_started", estimateHours: 3 },
      ], tagColor: "#86A3A3", createdAt: new Date().toISOString() },
    ],
    courses: [],
    events: [],
    habits: defaultHabits,
    courseMeta: null,
  };
}

function saveState({ immediate = true } = {}) {
  const updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(`${STORAGE_KEY}:updatedAt`, updatedAt);
  markPendingCloudState(updatedAt);
  cloudStateVersion += 1;
  updateCloudControls();
  if (immediate) {
    clearTimeout(cloudSyncTimer);
    return syncStateToCloud();
  }
  queueCloudSync();
  return Promise.resolve({ ok: false, queued: true });
}

function setSyncStatus(message, tone = "local") {
  const element = $("#syncStatus");
  if (!element) return;
  element.innerHTML = `<span class="status-dot ${tone}"></span><span class="storage-status-text">${escapeHtml(message)}</span>`;
}

function updateCloudControls() {
  const button = $("#cloudLoginButton");
  const signOut = $("#authSignOutButton");
  const github = $("#authGithubButton");
  const submit = $("#authSubmitButton");
  if (!button) return;
  if (cloudSession) {
    button.textContent = "Cloud account connected";
    if (signOut) signOut.hidden = false;
    if (github) github.hidden = true;
    if (submit) submit.hidden = true;
    if (submit) submit.disabled = false;
    const identity = cloudSession.user.email || cloudSession.user.app_metadata?.provider || "account";
    const hasPending = Boolean(readPendingCloudState());
    const syncLabel = cloudSyncReady ? (hasPending ? "Pending local changes" : "Cloud ready") : cloudSyncError || "Connecting to cloud…";
    setSyncStatus(`${syncLabel} · ${identity}`, cloudSyncReady && !hasPending ? "cloud" : cloudSyncError ? "error" : "pending");
  } else {
    button.textContent = "Connect cloud sync";
    if (signOut) signOut.hidden = true;
    if (github) { github.hidden = false; github.disabled = !cloudClientReady; }
    if (submit) submit.hidden = false;
    if (submit) submit.disabled = !cloudClientReady;
    setSyncStatus(readPendingCloudState() ? "Local workspace · pending cloud changes" : "Local workspace", readPendingCloudState() ? "pending" : "local");
  }
}

function queueCloudSync() {
  if (!cloudSession || !supabaseClient || !cloudSyncReady) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(syncStateToCloud, CLOUD_SYNC_DELAY);
}

async function syncStateToCloud() {
  if (!cloudSession || !supabaseClient) return { ok: false, reason: "not-connected" };
  if (cloudSyncInFlight) {
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(syncStateToCloud, 250);
    return { ok: false, reason: "queued" };
  }
  if (!cloudSyncReady) return { ok: false, reason: "cloud-not-ready" };
  cloudSyncInFlight = true;
  const versionAtStart = cloudStateVersion;
  const snapshot = JSON.parse(JSON.stringify(state));
  setSyncStatus("Saving to cloud…", "pending");
  let error = null;
  try {
    ({ error } = await supabaseClient.from("workspace_state").upsert({ user_id: cloudSession.user.id, state: snapshot, updated_at: new Date().toISOString() }, { onConflict: "user_id" }));
  } catch (caught) {
    error = { message: caught?.message || "Network request failed" };
  }
  cloudSyncInFlight = false;
  if (error) {
    console.error("Cloud save failed", error);
    cloudSyncError = `Cloud save failed: ${error.message}`;
    setSyncStatus(cloudSyncError, "error");
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(syncStateToCloud, 5000);
    return { ok: false, reason: "cloud-error", message: error.message };
  }
  cloudSyncError = "";
  cloudSyncedVersion = versionAtStart;
  if (cloudStateVersion === versionAtStart) localStorage.removeItem(PENDING_SYNC_KEY);
  cloudSyncReady = true;
  updateCloudControls();
  if (cloudStateVersion > cloudSyncedVersion) queueCloudSync();
  return { ok: true };
}

function applyIncomingCloudState(nextState, updatedAt) {
  if (!nextState || typeof nextState !== "object") return;
  if (cloudStateVersion > cloudSyncedVersion || readPendingCloudState()) {
    setSyncStatus("Local changes waiting to sync", "pending");
    return;
  }
  Object.assign(state, normalizeState(nextState));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(`${STORAGE_KEY}:updatedAt`, updatedAt || new Date().toISOString());
  cloudSyncedVersion = cloudStateVersion;
  cloudSyncError = "";
  render();
  setSyncStatus("Cloud workspace ready", "cloud");
}

function subscribeToCloudChanges() {
  if (!supabaseClient || !cloudSession) return;
  if (cloudRealtimeChannel) supabaseClient.removeChannel(cloudRealtimeChannel);
  cloudRealtimeChannel = supabaseClient
    .channel(`workspace-state-${cloudSession.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "workspace_state", filter: `user_id=eq.${cloudSession.user.id}` }, (payload) => {
      applyIncomingCloudState(payload.new?.state, payload.new?.updated_at);
    })
    .subscribe();
}

async function hydrateStateFromCloud() {
  if (!cloudSession || !supabaseClient) return;
  const localVersionAtLoadStart = cloudStateVersion;
  cloudSyncReady = false;
  setSyncStatus("Syncing…", "pending");
  let data = null;
  let error = null;
  try {
    ({ data, error } = await supabaseClient.from("workspace_state").select("state, updated_at").eq("user_id", cloudSession.user.id).maybeSingle());
  } catch (caught) {
    error = { message: caught?.message || "Network request failed" };
  }
  if (error) {
    console.error("Cloud load failed", error);
    cloudSyncReady = false;
    cloudSyncError = error.message?.includes("workspace_state") ? "Cloud table unavailable — run the Supabase schema" : `Cloud load failed: ${error.message}`;
    setSyncStatus(cloudSyncError, "error");
    return;
  }
  const pending = readPendingCloudState();
  if (pending) {
    if (data?.state && typeof data.state === "object") {
      localStorage.setItem(CLOUD_BACKUP_KEY, JSON.stringify({ state: data.state, updatedAt: data.updated_at || new Date().toISOString() }));
    }
    Object.assign(state, normalizeState(pending.state));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(`${STORAGE_KEY}:updatedAt`, pending.updatedAt || new Date().toISOString());
    cloudSyncReady = true;
    render();
    updateCloudControls();
    await syncStateToCloud();
    return;
  }
  if (data?.state && typeof data.state === "object") {
    if (cloudStateVersion === localVersionAtLoadStart) {
      Object.assign(state, normalizeState(data.state));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.setItem(`${STORAGE_KEY}:updatedAt`, data.updated_at || new Date().toISOString());
      cloudSyncedVersion = cloudStateVersion;
      render();
    }
  } else {
    cloudSyncReady = true;
    await syncStateToCloud();
  }
  cloudSyncError = "";
  cloudSyncReady = true;
  updateCloudControls();
  if (cloudStateVersion > cloudSyncedVersion) queueCloudSync();
}

async function initCloudSync() {
  setSyncStatus("Local workspace", "local");
  if (!window.supabase?.createClient) {
    await new Promise((resolve) => {
      const fallback = document.createElement("script");
      fallback.src = "https://unpkg.com/@supabase/supabase-js@2";
      fallback.onload = resolve;
      fallback.onerror = resolve;
      document.head.appendChild(fallback);
    });
  }
  if (!window.supabase?.createClient) {
    setSyncStatus("Cloud client unavailable", "error");
    updateCloudControls();
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  cloudClientReady = true;
  const { data } = await supabaseClient.auth.getSession();
  cloudSession = data.session;
  updateCloudControls();
  if (cloudSession) await hydrateStateFromCloud();
  if (cloudSession) subscribeToCloudChanges();
  supabaseClient.auth.onAuthStateChange((event, session) => {
    cloudSession = session;
    updateCloudControls();
    if (event === "SIGNED_IN") setTimeout(async () => { await hydrateStateFromCloud(); subscribeToCloudChanges(); }, 0);
    if (event === "SIGNED_OUT" && cloudRealtimeChannel) {
      supabaseClient.removeChannel(cloudRealtimeChannel);
      cloudRealtimeChannel = null;
    }
  });
}
function formatDate(value, options = { month: "long", day: "numeric", weekday: "long" }) { return new Intl.DateTimeFormat("en-US", options).format(parseDate(value)); }
function formatEnglishDate(value, options = { month: "short", day: "numeric" }) { return new Intl.DateTimeFormat("en-US", options).format(parseDate(value)); }
function formatShortDate(value) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parseDate(value)); }
function difficultyWeight(task) { return Number(task.estimateHours || 0) * (DIFFICULTY[task.difficulty] || 1); }
function isTaskCompleted(task) { return task.status === "done"; }
function deriveLongTermProgress(task) {
  if (task?.type !== "long-term") return clampProgress(task?.progress);
  const children = Array.isArray(task.children) ? task.children : [];
  if (!children.length) return 0;
  const totalEstimatedHours = Math.max(.25, Number(task.estimateHours) || children.reduce((sum, child) => sum + Math.max(.25, Number(child.estimateHours) || 0), 0));
  const completedEstimatedHours = children.reduce((sum, child) => child.status === "done" ? sum + Math.max(.25, Number(child.estimateHours) || 0) : sum, 0);
  return Math.round(Math.min(100, completedEstimatedHours / totalEstimatedHours * 100));
}
function progressForTask(task) {
  if (task.type === "long-term") return deriveLongTermProgress(task);
  if (task.status === "done") return 100;
  if (task.children?.length && task.progressOverride == null) return Math.round(task.children.filter((child) => child.status === "done").length / task.children.length * 100);
  if (task.progressOverride != null) return Math.max(0, Math.min(100, Number(task.progressOverride)));
  return Math.max(0, Math.min(100, Number(task.progress || 0)));
}
function taskColor(task) { return task.tagColor || DEFAULT_TAG_COLOR[task.type] || DEFAULT_TAG_COLOR.subtask; }
function hexToRgba(hex, alpha = 0.1) { const clean = hex.replace("#", ""); const value = clean.length === 3 ? clean.split("").map((part) => part + part).join("") : clean; const number = Number.parseInt(value, 16); return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`; }
function taskStatusLabel(task) { const progress = task.type === "long-term" ? deriveLongTermProgress(task) : taskProgress(task); return progress >= 100 ? "Completed" : progress > 0 ? "In progress" : "Not started"; }

function dateKey(value) {
  if (!value) return "";
  if (value instanceof Date) return isoDate(value);
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const slash = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (slash) return `${slash[3]}-${String(slash[1]).padStart(2, "0")}-${String(slash[2]).padStart(2, "0")}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : isoDate(parsed);
}

function tasksForDate(date) {
  const targetDate = dateKey(date);
  return state.tasks.flatMap((task) => {
    if (task.type === "long-term") return (task.children || []).filter((child) => dateKey(child.date) === targetDate).map((child) => ({ ...child, parentId: task.id, parentTitle: task.title, type: "subtask", estimateHours: child.estimateHours || 1, difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, scheduledDate: dateKey(child.date), actualDuration: child.actualDuration }));
    if (task.children?.length) return task.children.filter((child) => dateKey(child.date) === targetDate).map((child) => ({ ...child, parentId: task.id, parentTitle: task.title, type: "subtask", estimateHours: child.estimateHours || task.estimateHours / task.children.length, difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, scheduledDate: dateKey(child.date), actualDuration: child.actualDuration }));
    return dateKey(task.scheduledDate) === targetDate ? [{ ...task, scheduledDate: dateKey(task.scheduledDate) }] : [];
  }).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.startTime || "").localeCompare(String(b.startTime || "")) || String(a.title).localeCompare(String(b.title)));
}
function taskSortKey(task) { return task.parentId ? `${task.parentId}::${task.id}` : task.id; }
function updateTaskSortOrder(item, sortOrder) {
  if (item.parentId) {
    const parent = state.tasks.find((task) => task.id === item.parentId);
    const child = parent?.children?.find((entry) => entry.id === item.id);
    if (child) child.sortOrder = sortOrder;
  } else {
    const task = state.tasks.find((entry) => entry.id === item.id);
    if (task) task.sortOrder = sortOrder;
  }
}
function reorderTodayTasks(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const ordered = tasksForDate(selectedDate);
  const sourceIndex = ordered.findIndex((item) => taskSortKey(item) === sourceKey);
  const targetIndex = ordered.findIndex((item) => taskSortKey(item) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = ordered.splice(sourceIndex, 1);
  ordered.splice(ordered.findIndex((item) => taskSortKey(item) === targetKey), 0, moved);
  ordered.forEach(updateTaskSortOrder);
  saveState();
  render();
  toast("Today’s order updated.");
}

function taskProgress(task) { return task.type === "subtask" ? task.status === "done" ? 100 : Math.max(0, Math.min(100, Number(task.progress || 0))) : progressForTask(task); }
function dailyProgress(date) {
  const tasks = tasksForDate(date);
  if (!tasks.length) return null;
  const denominator = tasks.reduce((sum, task) => sum + difficultyWeight(task), 0);
  if (!denominator) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + taskProgress(task) * difficultyWeight(task), 0) / denominator);
}
function colorClass(progress) { return progress < 30 ? "red" : progress < 60 ? "yellow" : "green"; }
function batteryProgressBar(progress, weight = 1, orientation = "horizontal", showValue = true) {
  const value = progress == null ? 0 : Math.max(0, Math.min(100, Number(progress)));
  const filled = Math.floor(value / 10);
  const partial = value % 10;
  const color = colorClass(value);
  const face = value >= 100 ? " ^-^" : "";
  return `<div class="battery-progress ${orientation}" data-weight="${weight}" aria-label="Progress ${value}%, weight ${weight}"><div class="energy-grid">${Array.from({ length: 10 }, (_, index) => { const isPartial = index === filled && partial > 0 && filled < 10; return `<span class="energy-cell ${index < filled ? `filled ${color}` : isPartial ? `partial ${color}` : ""}" ${isPartial ? `style="--partial-fill:${partial * 10}%"` : ""}></span>`; }).join("")}</div>${showValue ? `<span class="battery-value">${value}%${face}</span>` : ""}</div>`;
}
function energyMarkup(progress, extraClass = "") { return batteryProgressBar(progress, 1, extraClass.includes("vertical") ? "vertical" : "horizontal", false); }

function render() {
  renderDateHeader();
  renderStats();
  renderTimeline();
  renderTasks();
  renderLongTerm();
  renderInsights();
  renderActiveTab();
}

function renderDateHeader() {
  $("#currentDateLabel").textContent = formatDate(selectedDate);
  $("#dateNote").textContent = "";
}

function renderStats() {
  const tasks = tasksForDate(selectedDate);
  const completed = tasks.filter((task) => taskProgress(task) >= 100 && task.status === "done").length;
  const active = tasks.filter((task) => task.status !== "done").length;
  $("#statsRow").innerHTML = [
    ["Done tasks", completed, "completed"],
    ["To do", active, "remaining"],
  ].map(([label, value, foot]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join("");
}

function renderTimeline() {
  const entries = [
    ...courseOccurrencesForDate(selectedDate).map((course) => ({ ...course, kind: "course" })),
    ...eventOccurrencesForDate(selectedDate).map((event) => ({ ...event, kind: "event" })),
    ...tasksForDate(selectedDate).filter((task) => task.startTime || task.endTime).map((task) => ({ ...task, kind: "task", title: task.title, start: task.startTime || "—", end: task.endTime || "" })),
  ].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (!entries.length) { $("#timeline").innerHTML = `<div class="timeline-empty">No scheduled blocks yet. Your day is open.</div>`; return; }
  $("#timeline").innerHTML = entries.map((entry) => {
    const conflict = entry.kind === "task" && courseOccurrencesForDate(selectedDate).some((course) => overlaps(entry.start, entry.end, course.start, course.end));
    const completed = entry.kind === "task" && entry.status === "done";
    const meta = entry.kind === "course" ? [entry.room, entry.teacher].filter(Boolean).join(" · ") : entry.kind === "event" ? "Event" : `${TYPE_LABEL[entry.type] || "Task"}${conflict ? " · overlaps a course" : ""}`;
    const color = entry.kind === "task" ? taskColor(entry) : entry.color || "#CDBBA0";
    const progress = entry.kind === "task" ? taskProgress(entry) : null;
    return `<div class="timeline-item ${entry.kind} ${completed ? "completed" : ""} ${conflict ? "conflict" : ""} ${entry.difficulty === "hard" ? "hard" : ""}" style="--task-color:${color};--task-tint:${hexToRgba(color)}"><div class="timeline-time">${entry.start}<br>${entry.end}</div><div class="timeline-line"></div><div><div class="timeline-title">${escapeHtml(entry.title || entry.name)}</div><div class="timeline-meta">${escapeHtml(meta || "Time block")}</div>${entry.kind === "task" ? `<div class="timeline-progress">${batteryProgressBar(progress, difficultyWeight(entry))}</div>` : ""}</div>${entry.kind === "task" ? `<button class="timeline-action" data-open-task="${entry.parentId || entry.id}">${completed ? "✓" : "Open"}</button>` : entry.kind === "event" ? `<button class="timeline-action" data-open-event="${entry.id}">Event</button>` : `<span class="timeline-action">Course</span>`}</div>`;
  }).join("");
  $("#timeline").querySelectorAll("[data-open-task]").forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.openTask)));
  $("#timeline").querySelectorAll("[data-open-event]").forEach((button) => button.addEventListener("click", () => openEventDetail(button.dataset.openEvent)));
}
function bindTodayTaskSorting() {
  const cards = [...$("#taskList").querySelectorAll("[data-today-sort-key]")];
  if (cards.length < 2) return;
  const clearSortTargets = () => cards.forEach((card) => card.classList.remove("sort-target"));
  const finishPointerSort = (card, pointerState, event) => {
    window.clearTimeout(pointerState.holdTimer);
    window.removeEventListener("pointermove", pointerState.onMove);
    window.removeEventListener("pointerup", pointerState.onUp);
    window.removeEventListener("pointercancel", pointerState.onCancel);
    clearSortTargets();
    if (pointerState.dragging) {
      event.preventDefault();
      card.dataset.dragSuppressed = "true";
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-today-sort-key]");
      if (target && target !== card) reorderTodayTasks(pointerState.sourceKey, target.dataset.todaySortKey);
      window.setTimeout(() => delete card.dataset.dragSuppressed, 0);
    }
    card.classList.remove("dragging");
  };
  cards.forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.todaySortKey);
      card.classList.add("dragging");
    });
    card.addEventListener("dragover", (event) => { event.preventDefault(); clearSortTargets(); card.classList.add("sort-target"); });
    card.addEventListener("drop", (event) => { event.preventDefault(); const sourceKey = event.dataTransfer.getData("text/plain"); reorderTodayTasks(sourceKey, card.dataset.todaySortKey); });
    card.addEventListener("dragend", () => { clearSortTargets(); card.classList.remove("dragging"); });
    card.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || event.target.closest("button")) return;
      const pointerState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, sourceKey: card.dataset.todaySortKey, holdTimer: 0, onMove: null, onUp: null, onCancel: null };
      pointerState.onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerState.pointerId) return;
        const distance = Math.hypot(moveEvent.clientX - pointerState.startX, moveEvent.clientY - pointerState.startY);
        if (!pointerState.dragging) { if (distance > 8) window.clearTimeout(pointerState.holdTimer); return; }
        moveEvent.preventDefault();
        clearSortTargets();
        document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest("[data-today-sort-key]")?.classList.add("sort-target");
      };
      pointerState.onUp = (upEvent) => { if (upEvent.pointerId === pointerState.pointerId) finishPointerSort(card, pointerState, upEvent); };
      pointerState.onCancel = (cancelEvent) => { if (cancelEvent.pointerId === pointerState.pointerId) finishPointerSort(card, pointerState, cancelEvent); };
      pointerState.holdTimer = window.setTimeout(() => { pointerState.dragging = true; card.classList.add("dragging"); card.setPointerCapture?.(event.pointerId); }, 320);
      window.addEventListener("pointermove", pointerState.onMove, { passive: false });
      window.addEventListener("pointerup", pointerState.onUp, { passive: false });
      window.addEventListener("pointercancel", pointerState.onCancel, { passive: false });
    }, { passive: true });
  });
}

function taskQuickButtonMarkup(task, taskId, childId = null) {
  const completed = task.status === "done";
  return `<button class="task-status-button ${completed ? "completed" : ""}" data-quick-task="${escapeHtml(taskId)}" data-quick-child="${escapeHtml(childId || "")}" type="button" aria-label="${completed ? "Open completed task actions" : "Open task progress actions"}">${completed ? "●" : "○"}</button>`;
}

function renderTasks() {
  const tasks = tasksForDate(selectedDate).filter((task) => !showIncompleteOnly || task.status !== "done");
  $("#showIncomplete").textContent = showIncompleteOnly ? "Showing incomplete" : "Show incomplete";
  if (!tasks.length) { $("#taskList").innerHTML = `<div class="empty-state">No task is assigned to this date. You can leave it open or add a small next step.</div>`; return; }
  $("#taskList").innerHTML = tasks.map((task) => {
    const progress = taskProgress(task);
    const status = task.status === "pending_confirmation" || progress >= 100 && task.status !== "done" ? "pending" : task.status === "done" ? "done" : "";
    const detailId = task.parentId || task.id;
    const sortKey = taskSortKey(task);
    const childText = task.type === "subtask" ? `<span class="subtask-marker" title="Sub-task">⌘</span> ${escapeHtml(task.parentTitle)}` : task.children?.length ? `${task.children.length} subtasks` : `${task.estimateHours || 0}h estimated`;
    const statusButton = taskQuickButtonMarkup(task, detailId, task.parentId ? task.id : null);
    const timeButton = `<button class="task-time-button" data-edit-time="${detailId}" type="button">${escapeHtml(detailTimeLabel(task.startTime, task.endTime))}</button>`;
  return `<article class="task-card ${task.difficulty === "hard" ? "hard" : ""} ${task.status === "done" ? "completed" : ""}" draggable="true" data-open-task="${detailId}" data-today-sort-key="${escapeHtml(sortKey)}" style="--task-color:${taskColor(task)};--task-tint:${hexToRgba(taskColor(task))}"><div class="task-card-top"><div><div class="task-card-title"><span class="task-color-dot"></span>${escapeHtml(task.title)}</div><div class="task-card-meta">${childText}</div></div><div class="task-card-actions"><span class="status-pill ${status}">${status === "pending" ? "Confirm" : status === "done" ? "Done" : task.status === "in_progress" ? "In progress" : "Not started"}</span><button class="icon-button detail-arrow" data-open-task="${detailId}" aria-label="打开任务">›</button></div></div><div class="progress-row">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div><div class="task-footer"><div class="task-footer-meta"><span data-timer-minutes="${detailId}">${trackedMinutes(task)} min focused</span>${timeButton}</div><div class="task-footer-actions">${statusButton}</div></div>${task.children?.length && task.type !== "long-term" ? `<div class="subtask-note">${task.children.map((child) => `${child.status === "done" ? "✓" : "○"} ${escapeHtml(child.title)}`).join("　")}</div>` : ""}</article>`;
  }).join("");
  $("#taskList").querySelectorAll(".task-card").forEach((card) => card.addEventListener("click", (event) => { if (!event.target.closest("button") && !card.dataset.dragSuppressed) openTaskDetail(card.dataset.openTask); }));
  $("#taskList").querySelectorAll("[data-open-task]").forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.openTask)));
  $("#taskList").querySelectorAll("[data-complete-task]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); completeTask(button.dataset.completeTask, button.dataset.completeChild || null); }));
  $("#taskList").querySelectorAll("[data-quick-task]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openTaskQuickAction(button.dataset.quickTask, button.dataset.quickChild || null); }));
  $("#taskList").querySelectorAll("[data-edit-time]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openTaskDetail(button.dataset.editTime, false, "edit"); }));
  bindTodayTaskSorting();
}

function renderLongTerm() {
  const tasks = state.tasks.filter((task) => task.type === "long-term");
  if (!tasks.length) { $("#longTermList").innerHTML = `<div class="empty-state">Long-term projects will appear here when you create one.</div>`; return; }
  $("#longTermList").innerHTML = tasks.map((task) => { const progress = progressForTask(task); const completeButton = ""; const status = progress >= 100 ? "done" : progress > 0 ? "in_progress" : ""; return `<article class="long-term-card" data-open-task="${task.id}" style="--task-color:${taskColor(task)};--task-tint:${hexToRgba(taskColor(task))}"><div class="task-card-top"><div><div class="task-card-title"><span class="task-color-dot"></span>${escapeHtml(task.title)}</div><div class="task-card-meta">${(task.children || []).filter((child) => child.status === "done").length} / ${(task.children || []).length} subtasks</div></div><span class="status-pill ${status}">${progress}%</span></div><div class="progress-row">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div><div class="task-footer"><span>${trackedMinutes(task)} min focused</span>${completeButton}</div></article>`; }).join("");
  $("#longTermList").querySelectorAll("[data-open-task]").forEach((card) => card.addEventListener("click", (event) => { if (!event.target.closest("button")) openTaskDetail(card.dataset.openTask); }));
  $("#longTermList").querySelectorAll("[data-complete-task]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); completeTask(button.dataset.completeTask); }));
}

function renderInsights() {
  const progress = dailyProgress(selectedDate);
  $("#progressPercent").textContent = progress == null ? "N/A" : `${progress}%`;
  $("#energyGrid").outerHTML = batteryProgressBar(progress, 1, "horizontal").replace("<div class=\"battery-progress horizontal\"", "<div class=\"battery-progress horizontal\" id=\"energyGrid\"");
  $("#progressCaption").textContent = progress == null ? "A free day is still a day." : progress >= 100 ? "All scheduled work is complete." : `${tasksForDate(selectedDate).length} task block${tasksForDate(selectedDate).length === 1 ? "" : "s"} in view.`;
  const active = tasksForDate(selectedDate).filter((task) => taskProgress(task) < 100);
  $("#activeTaskCount").textContent = `${active.length} task${active.length === 1 ? "" : "s"}`;
  $("#activeFocusList").innerHTML = active.length ? active.slice(0, 4).map((task) => `<div class="mini-item">${escapeHtml(task.title)}<span>${taskProgress(task)}%</span></div>`).join("") : `<div class="mini-item">Nothing pressing<span>—</span></div>`;
  const habitCount = currentHabitStats().filter((item) => item.achieved).length;
  $("#habitSummary").textContent = `${habitCount} / ${state.habits.length}`;
  $("#habitSummaryList").innerHTML = currentHabitStats().slice(0, 4).map((item) => `<div class="habit-line"><span>${escapeHtml(item.habit.name)}</span><small>${item.count}/${item.habit.kpi}</small></div>`).join("");
}

function renderActiveTab() {
  $("#boardView").classList.toggle("hidden", currentTab !== "board" || currentView !== "assignment");
  $("#assignmentView").classList.toggle("hidden", currentTab !== "today" || currentView !== "assignment");
  $("#weekView").classList.toggle("hidden", currentTab !== "week" || currentView !== "assignment");
  $("#heatmapView").classList.toggle("hidden", currentTab !== "heatmap" || currentView !== "assignment");
  $("#monthView").classList.toggle("hidden", currentTab !== "month" || currentView !== "assignment");
  $("#habitsView").classList.toggle("hidden", currentTab !== "habits" || currentView !== "assignment");
  if (currentView === "assignment") {
    $("#boardView").innerHTML = renderBoardView();
    $("#weekView").innerHTML = renderWeekView();
    $("#heatmapView").innerHTML = renderHeatmapView();
    $("#monthView").innerHTML = renderMonthView();
    $("#habitsView").innerHTML = renderHabitsView();
    bindBoardView();
    bindWeekView();
    bindEventButtons();
    bindHeatmapView();
    bindMonthView();
    bindHabitButtons();
  }
  $$(".view-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === currentTab));
  $("#placeholderView").classList.toggle("hidden", currentView === "assignment");
  if (currentView !== "assignment") { $("#placeholderTitle").textContent = placeholderText(currentView).title; $("#placeholderText").textContent = placeholderText(currentView).body; }
}

function addDays(value, amount) { const date = parseDate(value); date.setDate(date.getDate() + amount); return isoDate(date); }
function weekDatesFor(value = selectedDate) { const base = parseDate(value); const monday = new Date(base); const day = monday.getDay() || 7; monday.setDate(monday.getDate() - day + 1); return Array.from({ length: 7 }, (_, i) => addDays(isoDate(monday), i)); }
function boardItems() {
  return state.tasks.flatMap((task) => {
    if (task.children?.length && ["regular", "long-term"].includes(task.type)) return task.children.map((child) => ({ ...child, id: child.id, sourceId: child.id, parentId: task.id, parentTitle: task.title, type: "subtask", scheduledDate: dateKey(child.date), estimateHours: child.estimateHours || Math.max(.25, (task.estimateHours || 1) / task.children.length), difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, actualDuration: child.actualDuration }));
    return { ...task, scheduledDate: dateKey(task.scheduledDate) };
  }).filter((task) => task.scheduledDate);
}
function updateScheduledDate(item, date, startTime = null, endTime = null) {
  if (item.parentId) {
    const parent = state.tasks.find((task) => task.id === item.parentId); const child = parent?.children?.find((entry) => entry.id === item.id);
    if (!child) return false; child.date = date; if (startTime != null) child.startTime = startTime; if (endTime != null) child.endTime = endTime;
  } else {
    const task = state.tasks.find((entry) => entry.id === item.id); if (!task) return false; task.scheduledDate = date; if (startTime != null) task.startTime = startTime; if (endTime != null) task.endTime = endTime;
  }
  return true;
}
function boardBucket(date, today, tomorrow, week) { if (date === today) return "today"; if (date === tomorrow) return "tomorrow"; if (week.includes(date)) return "week"; return null; }
function renderBoardView() {
  const today = todayIso(); const tomorrow = addDays(today, 1); const week = weekDatesFor(today); const groups = { today: [], tomorrow: [], week: [] };
  boardItems().forEach((item) => { const bucket = boardBucket(item.scheduledDate, today, tomorrow, week); if (bucket) groups[bucket].push(item); });
  const columns = [["today", "Today", formatEnglishDate(today)], ["tomorrow", "Tomorrow", formatEnglishDate(tomorrow)], ["week", "This week", `${formatEnglishDate(week[0])} — ${formatEnglishDate(week[6])}`]];
  return `<div class="board-heading section-heading"><div><h2>Task board</h2></div><div class="board-hint">${boardItems().length} actionable items</div></div><div class="kanban-board">${columns.map(([key, title, subtitle]) => `<section class="kanban-column" data-board-column="${key}" data-drop-date="${key === "today" ? today : key === "tomorrow" ? tomorrow : addDays(today, 2)}"><div class="kanban-column-header"><div><h3>${title}</h3><span>${subtitle}</span></div><b>${groups[key].length}</b></div><div class="board-drop-zone">${groups[key].length ? groups[key].map((item) => { const progress = taskProgress(item); const owner = item.parentId || item.id; const statusButton = taskQuickButtonMarkup(item, owner, item.parentId ? item.id : null); return `<article class="kanban-card ${item.difficulty === "hard" ? "hard" : ""}" draggable="true" data-board-id="${item.id}" data-board-parent="${item.parentId || ""}" data-open-task="${owner}" style="--task-color:${taskColor(item)};--task-tint:${hexToRgba(taskColor(item))}"><div class="kanban-card-title"><span class="task-color-dot"></span><span>${escapeHtml(item.title)}</span></div><div class="kanban-card-meta"><span>${Number(item.estimateHours || 0).toLocaleString("en-US")}h${item.parentId ? ` · ${escapeHtml(item.parentTitle)}` : ""}</span><span>${item.scheduledDate === today ? "Today" : formatEnglishDate(item.scheduledDate)}</span></div><div class="kanban-card-footer">${batteryProgressBar(progress, difficultyWeight(item), "vertical")}<div class="kanban-card-actions">${statusButton}</div></div></article>`; }).join("") : `<div class="board-empty">Drop a task here</div>`}</div></section>`).join("")}</div>`;
}
function bindBoardView() {
  $$(`[data-board-id]`).forEach((card) => {
    card.addEventListener("dragstart", (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", JSON.stringify({ id: card.dataset.boardId, parentId: card.dataset.boardParent })); card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", (event) => { if (!event.target.closest("button")) openTaskDetail(card.dataset.openTask, true); });
  });
  $$(`[data-board-column]`).forEach((column) => {
    column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", (event) => { event.preventDefault(); column.classList.remove("drag-over"); try { const payload = JSON.parse(event.dataTransfer.getData("text/plain")); const source = boardItems().find((item) => item.id === payload.id && (item.parentId || "") === (payload.parentId || "")); if (!source) return; const targetDate = column.dataset.dropDate; if (updateScheduledDate(source, targetDate)) { saveState(); selectedDate = targetDate; render(); toast(`Scheduled for ${formatShortDate(targetDate)}.`); } } catch (error) { console.warn("Board drop ignored", error); } });
  });
  $("#boardView")?.querySelectorAll("[data-complete-task]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); completeTask(button.dataset.completeTask, button.dataset.completeChild || null); }));
  $("#boardView")?.querySelectorAll("[data-quick-task]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openTaskQuickAction(button.dataset.quickTask, button.dataset.quickChild || null); }));
}

const WEEK_DAY_START = 6 * 60;
const WEEK_DAY_END = 24 * 60;
const WEEK_HOUR_HEIGHT = 80;
function timeToMinutes(value) { if (!value) return null; const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function minutesToTime(value) { const minutes = Math.max(0, Math.round(value)); return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
function eventOccurrencesForDate(date) { const targetDate = dateKey(date); return (state.events || []).filter((event) => dateKey(event.date) === targetDate && event.start && event.end).map((event) => ({ ...event, date: targetDate, kind: "event", name: event.name || event.title || "Event" })); }
let currentEventId = null;
function openEventDetail(eventId = null) { const event = (state.events || []).find((item) => item.id === eventId); currentEventId = event?.id || null; $("#eventModalTitle").textContent = event ? "Edit event" : "Add an event"; $("#eventTitle").value = event?.name || event?.title || ""; $("#eventDate").value = event?.date || selectedDate; $("#eventStart").value = event?.start || "09:00"; $("#eventEnd").value = event?.end || "10:00"; $("#eventColor").value = event?.color || "#E8DCD1"; $("#eventNotes").value = event?.notes || ""; $("#eventImportant").checked = Boolean(event?.important); $("#deleteEventButton").hidden = !event; $("#eventModal").showModal(); }
function saveEventForm(event) { event.preventDefault(); if (event.submitter?.value === "cancel") { $("#eventModal").close(); currentEventId = null; return; } const title = $("#eventTitle").value.trim(); const date = $("#eventDate").value; const start = $("#eventStart").value; const end = $("#eventEnd").value; if (!title || !date || !start || !end) return; if (timeToMinutes(end) <= timeToMinutes(start)) { toast("End time must be after start time."); return; } const wasEditing = Boolean(currentEventId); state.events ||= []; const record = { id: currentEventId || uid("event"), name: title, title, date, start, end, color: $("#eventColor").value, notes: $("#eventNotes").value.trim(), important: $("#eventImportant").checked, kind: "event" }; if (currentEventId) { const index = state.events.findIndex((item) => item.id === currentEventId); if (index >= 0) state.events[index] = { ...state.events[index], ...record }; } else state.events.push(record); saveState(); $("#eventModal").close(); selectedDate = date; currentTab = currentTab === "month" ? "month" : "week"; render(); toast(wasEditing ? "Event updated." : "Event added."); currentEventId = null; }
function deleteEvent() { if (!currentEventId) return; const event = state.events.find((item) => item.id === currentEventId); if (!event) return; state.events = state.events.filter((item) => item.id !== currentEventId); saveState(); $("#eventModal").close(); currentEventId = null; render(); toast("Event deleted."); }
function weeklyEntriesForDate(date) {
  const targetDate = dateKey(date);
  const taskEntries = tasksForDate(targetDate).map((task) => ({
    id: `task:${task.parentId || task.id}:${task.id}`,
    ownerId: task.parentId || task.id,
    title: task.title,
    start: timeToMinutes(task.startTime),
    end: timeToMinutes(task.endTime),
    startLabel: task.startTime,
    endLabel: task.endTime,
    color: taskColor(task),
    kind: "task",
    task,
  }));
  const scheduledEntries = [...courseOccurrencesForDate(targetDate), ...eventOccurrencesForDate(targetDate)].map((entry) => ({
    id: `${entry.kind}:${entry.id}`,
    ownerId: entry.id,
    title: entry.name || entry.title || "Event",
    start: timeToMinutes(entry.start),
    end: timeToMinutes(entry.end),
    startLabel: entry.start,
    endLabel: entry.end,
    color: entry.kind === "event" ? (entry.color || "#CDBBA0") : "#B7C5CF",
    kind: entry.kind,
    entry,
  }));
  return [...taskEntries, ...scheduledEntries]
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start)
    .map((entry) => ({ ...entry, start: Math.max(WEEK_DAY_START, entry.start), end: Math.min(WEEK_DAY_END, entry.end) }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start || b.end - a.end || a.title.localeCompare(b.title));
}
function layoutWeekEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  const groups = [];
  sorted.forEach((entry) => {
    const group = groups.find((candidate) => candidate.end > entry.start);
    if (group) {
      group.entries.push(entry);
      group.end = Math.max(group.end, entry.end);
    } else groups.push({ entries: [entry], end: entry.end });
  });
  return groups.flatMap((group) => {
    const laneEnds = [];
    const placed = group.entries.map((entry) => {
      let lane = laneEnds.findIndex((end) => end <= entry.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(entry.end);
      } else laneEnds[lane] = entry.end;
      return { entry, lane };
    });
    const laneCount = Math.max(1, laneEnds.length);
    return placed.map((item) => ({ ...item, laneCount }));
  });
}
function weekBlockStyle(item) {
  const top = (item.entry.start - WEEK_DAY_START) / 60 * WEEK_HOUR_HEIGHT;
  const height = Math.max(8, (item.entry.end - item.entry.start) / 60 * WEEK_HOUR_HEIGHT);
  const width = 100 / item.laneCount;
  return `top:${top}px;height:${height}px;left:${item.lane * width}%;width:${width}%;background:${item.entry.color};`;
}
function weekEventLabel(title, durationMinutes) {
  if (durationMinutes <= 45) return "";
  const value = Array.from(String(title || "").trim()).slice(0, 4).join("");
  return `<span class="week-event-label">${escapeHtml(value)}${String(title || "").trim().length > 4 ? "..." : ""}</span>`;
}
function renderWeekDayColumn(date) {
  const targetDate = dateKey(date);
  const entries = weeklyEntriesForDate(targetDate);
  const blocks = layoutWeekEntries(entries).map((item) => {
    const { entry } = item;
    const label = `${entry.title}, ${entry.startLabel} to ${entry.endLabel}`;
    return `<button type="button" class="week-event-block ${entry.kind}-block" data-week-event data-week-date="${targetDate}" data-week-entry-id="${escapeHtml(entry.id)}" aria-label="${escapeHtml(label)}" style="${weekBlockStyle(item)}"><span class="week-event-swatch" aria-hidden="true"></span>${weekEventLabel(entry.title, entry.end - entry.start)}</button>`;
  }).join("");
  const trackHeight = (WEEK_DAY_END - WEEK_DAY_START) / 60 * WEEK_HOUR_HEIGHT;
  return `<div class="week-day-column-fixed" data-week-date="${targetDate}"><div class="week-day-track-fixed" style="height:${trackHeight}px">${blocks}${entries.length ? "" : `<span class="week-day-empty" aria-hidden="true"></span>`}</div></div>`;
}
function renderWeekView() {
  const days = weekDatesFor(selectedDate);
  const dayHeaders = days.map((date) => `<div class="week-day-header-fixed"><strong>${DAY_NAMES[parseDate(date).getDay()].slice(0, 3)}</strong><span>${formatShortDate(date)}</span></div>`).join("");
  const timeLabels = Array.from({ length: 19 }, (_, index) => { const hour = WEEK_DAY_START / 60 + index; return `<span style="top:${index * WEEK_HOUR_HEIGHT}px">${String(hour).padStart(2, "0")}:00</span>`; }).join("");
  return `<div class="section-heading week-view-heading"><div><div class="section-kicker">WEEK VIEW</div><h2>${formatDate(days[0], { month: "short", day: "numeric" })} — ${formatDate(days[6], { month: "short", day: "numeric" })}</h2></div><div class="calendar-nav week-nav"><button class="secondary-button" id="weekPrev" aria-label="Previous week">‹</button><button class="secondary-button" id="weekToday">Today</button><button class="secondary-button" id="weekNext" aria-label="Next week">›</button></div></div><div class="week-fixed-card"><div class="week-fixed-header"><div class="week-time-corner"></div><div class="week-day-headers">${dayHeaders}</div></div><div class="week-fixed-body"><div class="week-time-rail">${timeLabels}</div><div class="week-fixed-columns">${days.map(renderWeekDayColumn).join("")}</div></div></div>`;
}
function openWeekEventSheet(date, entryId) {
  const entry = weeklyEntriesForDate(date).find((item) => item.id === entryId);
  if (!entry) return;
  $("#weekEventTitle").textContent = entry.title;
  $("#weekEventTime").textContent = `${entry.startLabel} — ${entry.endLabel}`;
  $("#weekEventType").textContent = entry.kind === "task" ? TYPE_LABEL[entry.task?.type] || "Task" : entry.kind === "course" ? "Course" : "Event";
  $("#weekEventNotes").textContent = entry.kind === "course" ? [entry.entry?.room, entry.entry?.teacher].filter(Boolean).join(" · ") || "Course block" : entry.kind === "event" ? entry.entry?.notes || "Event block" : `${clampProgress(taskProgress(entry.task))}% complete`;
  $("#weekEventSheet").showModal();
}
function bindWeekView() {
  $("#weekPrev")?.addEventListener("click", () => { selectedDate = addDays(selectedDate, -7); render(); }); $("#weekNext")?.addEventListener("click", () => { selectedDate = addDays(selectedDate, 7); render(); }); $("#weekToday")?.addEventListener("click", () => { selectedDate = todayIso(); render(); });
  $$(`[data-week-event]`).forEach((block) => block.addEventListener("click", () => openWeekEventSheet(block.dataset.weekDate, block.dataset.weekEntryId)));
}
function bindEventButtons() { $$('[data-open-event]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openEventDetail(button.dataset.openEvent); })); }

function monthHeatmapData() { const date = parseDate(selectedDate); const year = date.getFullYear(); const month = date.getMonth(); const last = new Date(year, month + 1, 0).getDate(); return { year, month, days: Array.from({ length: last }, (_, index) => { const day = String(index + 1).padStart(2, "0"); const iso = `${year}-${String(month + 1).padStart(2, "0")}-${day}`; return { iso, day: index + 1, progress: dailyProgress(iso) }; }) }; }
function heatClass(progress) { if (progress == null || progress === 0) return "empty"; if (progress < 30) return "red"; if (progress < 60) return "yellow"; return "green"; }
function renderHeatmapView() { const { year, month, days } = monthHeatmapData(); const firstOffset = (new Date(year, month, 1).getDay() + 6) % 7; const cells = [...Array(firstOffset).fill(null), ...days]; return `<div class="section-heading"><div><div class="section-kicker">DAILY PROGRESS</div><h2>Task heatmap · ${year} / ${String(month + 1).padStart(2, "0")}</h2><p class="heatmap-description">Each square reads the saved daily weighted progress. Empty days stay out of the average.</p></div><div class="calendar-nav"><button class="secondary-button" id="heatPrev">‹ Month</button><button class="secondary-button" id="heatNext">Month ›</button></div></div><div class="heatmap-card"><div class="heatmap-weekdays">${DAY_NAMES.slice(1).concat(DAY_NAMES[0]).map((day) => `<span>${day.slice(0, 3)}</span>`).join("")}</div><div class="heatmap-month-grid">${cells.map((cell) => cell ? `<button class="heat-cell ${heatClass(cell.progress)}" data-heat-date="${cell.iso}" data-heat-progress="${cell.progress == null ? "N/A" : `${cell.progress}%`}" aria-label="${cell.iso} ${cell.progress == null ? "no tasks" : `${cell.progress}%`}"><span>${cell.day}</span></button>` : `<span class="heat-cell blank" aria-hidden="true"></span>`).join("")}</div><div class="heatmap-legend"><span><i class="heat-swatch empty"></i>No tasks</span><span><i class="heat-swatch red"></i>0–30%</span><span><i class="heat-swatch yellow"></i>30–60%</span><span><i class="heat-swatch green"></i>60–100%</span></div><div class="heat-tooltip" id="heatTooltip" role="status"></div></div>`; }
function bindHeatmapView() { const card = $(".heatmap-card"); const tooltip = $("#heatTooltip"); if (!card || !tooltip) return; $$(`[data-heat-date]`).forEach((cell) => { cell.addEventListener("mouseenter", () => { tooltip.textContent = `${cell.dataset.heatDate} · ${cell.dataset.heatProgress}`; tooltip.classList.add("show"); }); cell.addEventListener("mousemove", (event) => { const rect = card.getBoundingClientRect(); tooltip.style.left = `${event.clientX - rect.left + 12}px`; tooltip.style.top = `${event.clientY - rect.top + 12}px`; }); cell.addEventListener("mouseleave", () => tooltip.classList.remove("show")); }); $("#heatPrev")?.addEventListener("click", () => { const date = parseDate(selectedDate); date.setMonth(date.getMonth() - 1); selectedDate = isoDate(date); render(); }); $("#heatNext")?.addEventListener("click", () => { const date = parseDate(selectedDate); date.setMonth(date.getMonth() + 1); selectedDate = isoDate(date); render(); }); }
function monthAgendaEntries(date) {
  const targetDate = dateKey(date);
  const taskEntries = tasksForDate(targetDate).map((task) => ({
    id: task.id,
    ownerId: task.parentId || task.id,
    title: task.title,
    time: detailTimeLabel(task.startTime, task.endTime),
    sortTime: timeToMinutes(task.startTime),
    color: taskColor(task),
    category: TYPE_LABEL[task.type] || "Task",
    kind: "task",
    important: false,
  }));
  const eventEntries = eventOccurrencesForDate(targetDate).map((event) => ({
    id: event.id,
    ownerId: event.id,
    title: event.name || event.title || "Event",
    time: detailTimeLabel(event.start, event.end),
    sortTime: timeToMinutes(event.start),
    color: event.color || "#E8DCD1",
    category: "Event",
    kind: "event",
    important: Boolean(event.important),
  }));
  const courseEntries = courseOccurrencesForDate(targetDate).map((course) => ({
    id: `course:${course.id}`,
    ownerId: course.id,
    title: course.name || course.title || "Course",
    time: detailTimeLabel(course.start, course.end),
    sortTime: timeToMinutes(course.start),
    color: "#CDBBA0",
    category: "Course",
    kind: "course",
    important: false,
  }));
  return [...eventEntries, ...taskEntries, ...courseEntries].sort((a, b) => Number(b.important) - Number(a.important) || (a.sortTime ?? 1440) - (b.sortTime ?? 1440) || a.title.localeCompare(b.title));
}
function shiftMonth(amount) {
  const current = parseDate(selectedDate);
  const day = current.getDate();
  current.setDate(1);
  current.setMonth(current.getMonth() + amount);
  const lastDay = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
  current.setDate(Math.min(day, lastDay));
  selectedDate = isoDate(current);
  render();
}
function renderMonthAgenda(date) {
  const entries = monthAgendaEntries(date);
  const importantDay = entries.some((entry) => entry.important);
  const cards = entries.map((entry) => `<button type="button" class="agenda-card ${entry.important ? "important" : ""}" style="--agenda-color:${entry.color}" data-agenda-kind="${entry.kind}" data-agenda-id="${escapeHtml(entry.id)}" data-agenda-owner="${escapeHtml(entry.ownerId)}" data-agenda-date="${date}"><span class="agenda-card-copy"><strong>${entry.important ? "★ " : ""}${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.time)}</span></span><span class="agenda-card-category">${escapeHtml(entry.category)}</span></button>`).join("");
  return `<section class="month-agenda"><div class="month-agenda-header"><div><div class="section-kicker">AGENDA</div><h3>${formatEnglishDate(date, { month: "long", day: "numeric", year: "numeric" })}${importantDay ? " · Important day" : ""}</h3></div><button class="primary-button month-add-event" id="monthAddEvent" type="button">+ Add Event for this day</button></div><div class="agenda-list">${cards || `<div class="agenda-empty">No scheduled items for this day.</div>`}</div></section>`;
}
function bindMonthView() {
  $$(`[data-month-date]`).forEach((cell) => cell.addEventListener("click", () => { selectedDate = cell.dataset.monthDate; render(); }));
  $("#monthPrev")?.addEventListener("click", () => shiftMonth(-1));
  $("#monthNext")?.addEventListener("click", () => shiftMonth(1));
  $("#monthToday")?.addEventListener("click", () => { selectedDate = todayIso(); render(); });
  $("#monthAddEvent")?.addEventListener("click", () => openEventDetail());
  $$(`[data-agenda-kind]`).forEach((card) => card.addEventListener("click", () => {
    if (card.dataset.agendaKind === "event") openEventDetail(card.dataset.agendaOwner);
    if (card.dataset.agendaKind === "task") openTaskDetail(card.dataset.agendaOwner);
    if (card.dataset.agendaKind === "course") openWeekEventSheet(card.dataset.agendaDate, card.dataset.agendaId);
  }));
}

// Reserved extension point for anniversaries, birthdays and mood notes.
const monthAnnotations = { anniversaries: [], birthdays: [], moods: [] };
function renderMonthView() {
  const date = parseDate(selectedDate); const year = date.getFullYear(); const month = date.getMonth(); const first = new Date(year, month, 1); const last = new Date(year, month + 1, 0); const start = (first.getDay() + 6) % 7;
  const cells = []; for (let i = 0; i < start; i++) cells.push(`<div class="calendar-cell muted" aria-hidden="true"></div>`);
  for (let i = 1; i <= last.getDate(); i++) {
    const d = new Date(year, month, i); const iso = isoDate(d); const hardTasks = tasksForDate(iso).filter((task) => task.difficulty === "hard"); const events = eventOccurrencesForDate(iso); const markers = [...events.map((event) => ({ color: event.color || "#E8DCD1", label: event.name || event.title || "Event" })), ...hardTasks.map((task) => ({ color: taskColor(task), label: task.title }))]; const important = events.some((event) => event.important);
    cells.push(`<button type="button" class="calendar-cell month-cell ${iso === todayIso() ? "today" : ""} ${iso === selectedDate ? "selected" : ""} ${important ? "important-day" : ""}" data-month-date="${iso}" aria-label="Open ${formatDate(iso)}"><strong>${i}</strong>${important ? `<span class="month-important-mark" aria-label="Important day">★</span>` : ""}<span class="month-dots">${markers.slice(0, 5).map((marker) => `<i class="month-dot" style="--dot-color:${marker.color}" title="${escapeHtml(marker.label)}"></i>`).join("")}</span></button>`);
  }
  return `<div class="section-heading month-view-heading"><div><div class="section-kicker">MONTH VIEW</div><h2>${formatDate(`${year}-${String(month + 1).padStart(2, "0")}-01`, { month: "long", year: "numeric" })}</h2></div><div class="calendar-nav month-nav"><button class="secondary-button" id="monthPrev" aria-label="Previous month">‹</button><button class="secondary-button" id="monthToday">Today</button><button class="secondary-button" id="monthNext" aria-label="Next month">›</button></div></div><div class="month-layout"><div class="calendar-card month-calendar-card"><div class="calendar-grid">${DAY_NAMES.map((day) => `<div class="calendar-day-name">${day.slice(0, 3)}</div>`).join("")}${cells.join("")}</div></div>${renderMonthAgenda(selectedDate)}</div>`;
}

function currentHabitStats() {
  const now = parseDate(selectedDate); const monday = new Date(now); const day = monday.getDay() || 7; monday.setDate(monday.getDate() - day + 1); const weekStart = isoDate(monday); const monthPrefix = selectedDate.slice(0, 7);
  return state.habits.map((habit) => { const frequency = habit.frequency || habit.cadence || "weekly"; const dates = (habit.checkins || []).filter((date) => frequency === "weekly" ? date >= weekStart && date <= isoDate(new Date(monday.getTime() + 6 * 86400000)) : date.startsWith(monthPrefix)); const count = dates.length; return { habit, dates, count, achieved: count >= habit.kpi, frequency }; });
}
function habitStreak(habit) { const dates = new Set(habit.checkins || []); let cursor = parseDate(todayIso()); let streak = 0; while (dates.has(isoDate(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); } return streak; }
function habitHeatmapMarkup(habit) { const end = parseDate(selectedDate); const endDay = end.getDay() || 7; end.setDate(end.getDate() + (7 - endDay)); const start = new Date(end); start.setDate(end.getDate() - 83); const checked = new Set(habit.checkins || []); const cells = Array.from({ length: 84 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const iso = isoDate(date); return `<span class="habit-heat-cell ${checked.has(iso) ? "checked" : ""} ${iso === todayIso() ? "today" : ""}" title="${iso} · ${checked.has(iso) ? "checked" : "not checked"}"></span>`; }).join(""); return `<div class="habit-heatmap"><div class="detail-label">Check-in history · last 12 weeks</div><div class="habit-heatmap-caption">Only the day you check in is recorded. Past days cannot be filled retroactively.</div><div class="habit-heatmap-grid">${cells}</div></div>`; }
function renderHabitsView() { const today = todayIso(); return `<div class="section-heading habit-heading"><div><div class="section-kicker">HABIT BOARD</div><h2>Habits</h2></div><button class="icon-button add-icon-button" id="newHabitButton" aria-label="Add habit">+</button></div><div class="task-list">${currentHabitStats().map(({ habit, count, frequency }) => { const checkedToday = (habit.checkins || []).includes(today); return `<article class="task-card habit-card ${checkedToday ? "checked-today" : ""}" data-open-habit="${habit.id}"><div class="habit-card-main"><div><div class="task-card-title">${escapeHtml(habit.name)}</div><div class="task-card-meta">${frequency === "weekly" ? "This week" : "This month"} KPI · ${habit.kpi} times</div></div><div class="habit-count-box" aria-label="${count} of ${habit.kpi} completed">${count}/${habit.kpi}</div></div><div class="habit-card-actions"><button class="habit-check-button" data-check-habit="${habit.id}" aria-label="${checkedToday ? "Undo check-in today" : "Check in today"}">${checkedToday ? "↶" : "✓"}</button><button class="habit-edit-button" data-open-habit="${habit.id}" aria-label="Edit habit">Edit</button></div></article>`; }).join("")}</div>`; }
function bindHabitButtons() { $$('[data-check-habit]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); checkHabit(button.dataset.checkHabit); })); $$('[data-open-habit]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openHabitDetail(button.dataset.openHabit); })); $("#newHabitButton")?.addEventListener("click", () => openHabitDetail()); }
let currentHabitId = null;
function openHabitDetail(habitId = null) { const habit = state.habits.find((item) => item.id === habitId); currentHabitId = habit?.id || null; const draft = habit || { name: "", frequency: "weekly", kpi: 3, checkins: [] }; const frequency = draft.frequency || draft.cadence || "weekly"; const count = habit ? (currentHabitStats().find((item) => item.habit.id === habitId)?.count || 0) : 0; $("#habitDetailTitle").textContent = habit ? habit.name : "Add a habit"; $("#habitDetailContent").innerHTML = `<div class="detail-block"><div class="habit-form-grid"><label>Name<input id="editHabitName" value="${escapeHtml(draft.name)}" maxlength="60" placeholder="例如：锻炼、阅读" required /></label><label>Frequency<select id="editHabitFrequency"><option value="weekly" ${frequency === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${frequency === "monthly" ? "selected" : ""}>Monthly</option></select></label><label>KPI times<input id="editHabitKpi" type="number" min="1" max="31" step="1" value="${draft.kpi}" required /></label></div>${habit ? `<div class="detail-help">Current period: ${count} / ${habit.kpi}.</div>${habitHeatmapMarkup(habit)}` : `<div class="detail-help">Only the date you check in counts toward the selected weekly or monthly KPI.</div>`}</div>`; $("#deleteHabitButton").hidden = !habit; $("#habitDetailModal").showModal(); }
function saveHabitChanges() { const name = $("#editHabitName").value.trim(); if (!name) { toast("Please give the habit a name."); return; } const frequency = $("#editHabitFrequency").value; const kpi = Math.max(1, Number($("#editHabitKpi").value) || 1); state.habits ||= []; if (currentHabitId) { const habit = state.habits.find((item) => item.id === currentHabitId); if (!habit) return; habit.name = name; habit.frequency = frequency; habit.cadence = frequency; habit.kpi = kpi; } else state.habits.push({ id: uid("habit"), name, frequency, cadence: frequency, kpi, checkins: [] }); saveState(); $("#habitDetailModal").close(); render(); toast(currentHabitId ? "Habit changes saved." : "Habit added."); currentHabitId = null; }
function deleteHabit() { if (!currentHabitId) return; const habit = state.habits.find((item) => item.id === currentHabitId); if (!habit) return; state.habits = state.habits.filter((item) => item.id !== currentHabitId); saveState(); $("#habitDetailModal").close(); currentHabitId = null; render(); toast("Habit deleted."); }

function placeholderText(view) { return { "message-board": { title: "A message board for Xiao Yu.", body: "The assistant entry point is reserved for a later iteration. The current build keeps the task page as the home base." }, reading: { title: "Reading and writing, later.", body: "The content library will have its own data window after the daily management core is stable." }, archive: { title: "A quiet archive for rewards.", body: "Reward triggers and collection records are intentionally left as a future module." }, inspiration: { title: "A box for ideas.", body: "The inspiration box will share the same durable foundation when its content model is ready." } }[view] || { title: "Coming later.", body: "This space is reserved for the next iteration." }; }

function courseOccurrencesForDate(date) { const targetDate = dateKey(date); return state.courses.filter((course) => dateKey(course.date) === targetDate).map((course) => ({ ...course, date: targetDate, kind: "course" })); }
function overlaps(startA, endA, startB, endB) { if (!startA || !endA || !startB || !endB) return false; return startA < endB && startB < endA; }

function detailTimeLabel(start, end) {
  if (start && end) return `${start} — ${end}`;
  if (start) return `${start} — no end time`;
  if (end) return `No start time — ${end}`;
  return "Time not set";
}
function formatTrackedMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (!value) return "0m";
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return hours ? `${hours}h ${remainder ? `${remainder}m` : ""}`.trim() : `${remainder}m`;
}
function detailScheduleMarkup(task, estimatedMinutes) {
  const plannedDate = task.scheduledDate || selectedDate;
  const deadlineDate = task.deadline || plannedDate;
  return `<div class="detail-schedule-card"><div class="detail-schedule-node"><span class="detail-schedule-dot"></span><div><span class="detail-label">START</span><strong>${escapeHtml(formatEnglishDate(plannedDate))}</strong><small>${escapeHtml(detailTimeLabel(task.startTime, task.endTime))}</small></div></div><div class="detail-schedule-line"><span>Total ${escapeHtml(formatTrackedMinutes(estimatedMinutes))}</span></div><div class="detail-schedule-node detail-schedule-node-end"><span class="detail-schedule-dot"></span><div><span class="detail-label">DEADLINE</span><strong>${task.deadline ? escapeHtml(formatEnglishDate(deadlineDate)) : "No deadline"}</strong><small>${task.deadline ? "Target date" : "Keep moving"}</small></div></div></div>`;
}
function detailStatusMarkup(task, progress) {
  const status = taskStatusLabel(task);
  const statusClass = progress >= 100 ? "done" : status === "Confirm completion" ? "pending" : "";
  return `<div class="detail-status-row"><div class="detail-status-item"><span class="detail-label">STATUS</span><span class="status-pill ${statusClass}">${status}</span></div><div class="detail-status-item detail-status-progress"><span class="detail-label">PROGRESS</span><div class="detail-status-track"><span style="width:${Math.min(100, Math.max(0, progress))}%"></span></div><strong>${progress}%</strong></div></div>`;
}
function renderLongTermReadonlyTaskDetail(task) {
  const progress = taskProgress(task);
  const estimatedMinutes = Math.round((Number(task.estimateHours) || 0) * 60);
  const actualDuration = trackedMinutes(task);
  const children = task.children || [];
  return `<div class="detail-readonly long-term-detail"><div class="detail-intro" style="--task-color:${taskColor(task)}"><div class="detail-label">${TYPE_LABEL[task.type] || "Long-term task"}</div><p class="detail-description">${escapeHtml(task.notes || "No notes added yet.")}</p></div>${detailScheduleMarkup(task, estimatedMinutes)}${detailStatusMarkup(task, progress)}<div class="detail-block detail-time-comparison"><div class="detail-block-header"><div><div class="detail-label">Focus time</div></div><button type="button" class="detail-inline-button" data-open-time-log="${task.id}" data-time-child="">Edit actual</button></div><div class="detail-focus-metrics"><div><strong>${formatTrackedMinutes(actualDuration)}</strong><span>Actual</span></div><div><strong>${formatTrackedMinutes(estimatedMinutes)}</strong><span>Estimated</span></div></div><div class="time-comparison-track"><span style="width:${estimatedMinutes ? Math.min(100, actualDuration / estimatedMinutes * 100) : 0}%"></span></div></div><div class="detail-block detail-stages-block"><div class="detail-block-header"><div><div class="detail-label">Stages</div><div class="detail-value">Subtask timeline</div></div><span class="muted-label">${children.length} ${children.length === 1 ? "stage" : "stages"}</span></div><div class="long-term-stage-timeline">${children.length ? children.map((child) => `<div class="long-term-stage-row ${child.status === "done" ? "done" : ""}"><button type="button" class="long-term-stage-toggle" data-toggle-child="${task.id}" data-child-id="${child.id}" aria-label="${child.status === "done" ? "Mark incomplete" : "Mark complete"}">${child.status === "done" ? "✓" : "○"}</button><div class="long-term-stage-copy"><strong>${escapeHtml(child.title)}</strong><span>${escapeHtml(child.date ? formatEnglishDate(child.date) : "Date not set")}</span></div><button type="button" class="long-term-stage-time" data-open-time-log="${task.id}" data-time-child="${child.id}" aria-label="Log actual time">◷</button></div>`).join("") : `<div class="detail-help">No stages yet.</div>`}</div></div><div class="detail-help">Progress is read-only and derived from completed stage estimate time.</div></div>`;
}
function renderReadonlyTaskDetail(task) {
  if (task.type === "long-term") return renderLongTermReadonlyTaskDetail(task);
  const progress = taskProgress(task);
  const estimatedMinutes = Math.round((Number(task.estimateHours) || 0) * 60);
  const actualDuration = trackedMinutes(task);
  const stages = task.children?.length ? task.children : [{ title: task.title, status: task.status, progress, startTime: task.startTime, endTime: task.endTime, date: task.scheduledDate, actualDuration }];
  return `<div class="detail-readonly"><div class="detail-intro" style="--task-color:${taskColor(task)}"><div class="detail-label">${TYPE_LABEL[task.type] || "Task"}</div><p class="detail-description">${escapeHtml(task.notes || "No notes added yet.")}</p></div>${detailScheduleMarkup(task, estimatedMinutes)}${detailStatusMarkup(task, progress)}<div class="detail-block detail-time-comparison"><div class="detail-block-header"><div><div class="detail-label">Focus time</div></div><button type="button" class="detail-inline-button" data-open-time-log="${task.id}" data-time-child="">Edit actual</button></div><div class="detail-focus-metrics"><div><strong>${formatTrackedMinutes(actualDuration)}</strong><span>Actual</span></div><div><strong>${formatTrackedMinutes(estimatedMinutes)}</strong><span>Estimated</span></div></div><div class="time-comparison-track"><span style="width:${estimatedMinutes ? Math.min(100, actualDuration / estimatedMinutes * 100) : 0}%"></span></div></div><div class="detail-block detail-stages-block"><div class="detail-block-header"><div><div class="detail-label">Stages</div><div class="detail-value">Subtask timeline</div></div><span class="muted-label">${stages.length} ${stages.length === 1 ? "stage" : "stages"}</span></div><div class="task-stage-timeline">${stages.map((stage) => `<div class="task-stage ${stage.status === "done" ? "done" : ""}"><span class="task-stage-marker">${stage.status === "done" ? "✓" : ""}</span><div class="task-stage-content"><strong>${escapeHtml(stage.title)}</strong><span>${escapeHtml(stage.date ? formatEnglishDate(stage.date) : "Date not set")} · ${escapeHtml(detailTimeLabel(stage.startTime, stage.endTime))}</span><small>${stage.status === "done" ? "Completed" : `${clampProgress(stage.progress)}% complete`} · ${formatTrackedMinutes(stage.actualDuration ?? 0)} focused</small></div></div>`).join("")}</div></div><div class="detail-actions"><span class="detail-label detail-action-label">Update progress</span><button type="button" data-set-progress="${task.id}" data-progress="25">25%</button><button type="button" data-set-progress="${task.id}" data-progress="50">50%</button><button type="button" data-set-progress="${task.id}" data-progress="75">75%</button></div></div>`;
}
function renderEditableTaskDetail(task) {
  const progress = progressForTask(task);
  const childBlock = ["regular", "long-term"].includes(task.type) ? `<div class="detail-block"><div class="detail-block-header"><div><div class="detail-label">Subtasks</div><div class="detail-help">${task.type === "regular" ? "Up to 3 same-level subtasks, each with a date." : "Each subtask contributes to the long-term count."}</div></div><button type="button" class="detail-inline-button" id="addSubtaskButton" ${task.type === "regular" && (task.children || []).length >= 3 ? "disabled" : ""}>+ Add subtask</button></div><div class="subtask-editor">${(task.children || []).map((child, index) => `<div class="subtask-row"><input data-child-index="${index}" data-child-field="title" value="${escapeHtml(child.title)}" aria-label="子任务名称" placeholder="Subtask title" /><input data-child-index="${index}" data-child-field="date" type="date" value="${child.date || task.scheduledDate || selectedDate}" aria-label="子任务日期" /><input data-child-index="${index}" data-child-field="startTime" type="time" value="${child.startTime || ""}" aria-label="子任务开始时间" /><input data-child-index="${index}" data-child-field="endTime" type="time" value="${child.endTime || ""}" aria-label="子任务结束时间" /><input data-child-index="${index}" data-child-field="progress" type="number" min="0" max="100" step="5" inputmode="numeric" value="${child.progress || 0}" aria-label="子任务进度" /><div class="subtask-row-actions">${child.progress >= 100 && child.status !== "done" ? `<button type="button" class="detail-inline-button" data-confirm-child="${index}">Confirm</button>` : ""}<button type="button" class="icon-button" data-remove-child="${index}" aria-label="删除子任务">×</button></div></div>`).join("") || `<div class="detail-help">No subtasks yet.</div>`}</div></div>` : "";
  const isDerivedProgress = task.type === "long-term";
  const progressEditor = isDerivedProgress
    ? `<div class="progress-editor"><div class="detail-label">Progress</div><div class="readonly-field progress-readonly" id="editProgressReadonly">${progress}%</div><div class="detail-help">Long-term progress is calculated from completed subtasks.</div></div>`
    : `<div class="progress-editor"><div class="detail-label">${task.type === "regular" && task.children?.length ? "Parent progress override" : "Progress"}</div><div class="progress-quick-actions" role="group" aria-label="Quick progress"><button type="button" class="${progress === 0 ? "active" : ""}" data-edit-progress="0">0%</button><button type="button" class="${progress === 25 ? "active" : ""}" data-edit-progress="25">25%</button><button type="button" class="${progress === 50 ? "active" : ""}" data-edit-progress="50">50%</button><button type="button" class="${progress === 75 ? "active" : ""}" data-edit-progress="75">75%</button></div><input id="editProgress" type="hidden" value="${progress}" /><div class="detail-progress" id="detailProgressPreview">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div>${task.type === "regular" && task.children?.length ? `<div class="detail-help">Choose a preset percentage for the parent. Child completion remains the source of truth when no override is needed.</div>` : ""}</div>`;
  return `<div class="detail-block"><div class="form-grid"><label>Title<input id="editTitle" value="${escapeHtml(task.title)}" maxlength="120" /></label><label>Type<div class="readonly-field">${TYPE_LABEL[task.type]}</div></label><label>Planned date<input id="editScheduledDate" type="date" value="${task.scheduledDate || selectedDate}" /></label><label>Deadline<input id="editDeadline" type="date" value="${task.deadline || ""}" /></label><label>Estimated hours<input id="editEstimateHours" type="number" min="0.25" step="0.25" value="${task.estimateHours || 1}" /></label><label>Difficulty<select id="editDifficulty"><option value="simple" ${task.difficulty === "simple" ? "selected" : ""}>Simple</option><option value="normal" ${task.difficulty === "normal" ? "selected" : ""}>Normal</option><option value="hard" ${task.difficulty === "hard" ? "selected" : ""}>Hard</option></select></label><label>Task color<select id="editTagColor">${tagColorOptions(taskColor(task))}</select></label><label>Start time<input id="editStartTime" type="time" value="${task.startTime || ""}" /></label><label>End time<input id="editEndTime" type="time" value="${task.endTime || ""}" /></label></div><label>Notes<textarea id="editNotes" rows="3">${escapeHtml(task.notes || "")}</textarea></label>${progressEditor}</div>${childBlock}<div class="detail-actions"><button type="button" class="detail-inline-button" data-open-time-log="${task.id}" data-time-child="">Edit actual time</button></div>`;
}
function bindTaskDetailControls(task) {
  $("#addSubtaskButton")?.addEventListener("click", () => addSubtask(task.id));
  $$(`[data-confirm-child]`).forEach((button) => button.addEventListener("click", () => confirmChild(task.id, Number(button.dataset.confirmChild))));
  $$(`[data-remove-child]`).forEach((button) => button.addEventListener("click", () => removeSubtask(task.id, Number(button.dataset.removeChild))));
  $$(`[data-set-progress]`).forEach((button) => button.addEventListener("click", () => setTaskProgress(button.dataset.setProgress, Number(button.dataset.progress), button.dataset.setChild || null)));
  $$(`[data-open-time-log]`).forEach((button) => button.addEventListener("click", () => openManualTimeModal(button.dataset.openTimeLog, button.dataset.timeChild || null)));
  $$(`[data-toggle-child]`).forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggleChildCompletion(button.dataset.toggleChild, button.dataset.childId); }));
  if (currentDetailMode !== "edit") return;
  $$(`[data-edit-progress]`).forEach((button) => button.addEventListener("click", () => {
    const next = clampProgress(button.dataset.editProgress);
    const input = $("#editProgress");
    if (input) input.value = String(next);
    $$(`[data-edit-progress]`).forEach((item) => item.classList.toggle("active", item === button));
    const preview = $("#detailProgressPreview");
    if (preview) preview.innerHTML = `${energyMarkup(next)}<div class="progress-number">${next}%${next === 100 ? " ^-^" : ""}</div>`;
  }));
}
function openTaskDetail(taskId, drawer = false, mode = "readonly") {
  const task = state.tasks.find((item) => item.id === taskId); if (!task) return;
  currentDetailTaskId = taskId;
  currentDetailMode = mode;
  const progress = taskProgress(task);
  $("#detailTitle").textContent = task.title;
  $("#detailContent").innerHTML = mode === "edit" ? renderEditableTaskDetail(task) : renderReadonlyTaskDetail(task);
  $("#editTaskButton").hidden = mode === "edit";
  $("#saveTaskButton").hidden = mode !== "edit";
  $("#confirmCompleteButton").hidden = task.type === "long-term" || task.status === "done";
  $("#confirmCompleteButton").dataset.completeTask = task.id;
  $("#taskDetailModal").classList.toggle("drawer-mode", drawer);
  if (!$("#taskDetailModal").open) $("#taskDetailModal").showModal();
  bindTaskDetailControls(task);
}

function tagColorOptions(selected) { const labels = { "#8EA1B5": "Dusty Blue · work / study", "#9CAF88": "Sage Green · life / health", "#C08A8A": "Dusty Rose · reading / hobby", "#CDBBA0": "Oatmeal · daily", "#A697B5": "Taro Purple · inspiration", "#D9A05B": "Muted Orange · urgent", "#86A3A3": "Teal · long-term", "#D8B4B4": "Pale Pink · personal" }; return TAG_COLORS.map((color) => `<option value="${color}" ${color === selected ? "selected" : ""}>${labels[color]}</option>`).join(""); }
function addSubtask(taskId) { const task = state.tasks.find((item) => item.id === taskId); if (!task || (task.type === "regular" && (task.children || []).length >= 3)) return; task.children ||= []; task.children.push({ id: uid("subtask"), title: "New subtask", date: task.scheduledDate || selectedDate, progress: 0, status: "not_started", estimateHours: 1 }); saveState(); render(); openTaskDetail(taskId); toast("Subtask added — edit its title and date before saving."); }
function removeSubtask(taskId, index) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; task.children.splice(index, 1); saveState(); render(); openTaskDetail(taskId); }
function openCompletionPrompt(taskId, childIndex = null) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; pendingCompletion = { taskId, childIndex }; const child = childIndex == null ? null : task.children?.[childIndex]; $("#completionMessage").textContent = child ? `“${child.title}” reached 100%. Confirm that this subtask is actually complete.` : `“${task.title}” reached 100%. Confirm that this task is actually complete.`; $("#completionModal").showModal(); }
async function applyPendingCompletion() {
  if (!pendingCompletion) return;
  const task = state.tasks.find((item) => item.id === pendingCompletion.taskId);
  if (!task) return;
  if (pendingCompletion.childIndex == null) {
    if (task.type === "long-term") { pendingCompletion = null; $("#completionModal").close(); return; }
    task.status = "done";
    task.progress = 100;
  } else {
    const child = task.children?.[pendingCompletion.childIndex];
    if (!child) return;
    updateChildRecord(task.id, child.id, (current) => ({ ...current, progress: 100, status: "done" }));
  }
  pendingCompletion = null;
  const cloudSave = saveState({ immediate: true });
  $("#completionModal").close();
  if ($("#taskDetailModal").open) $("#taskDetailModal").close();
  render();
  const result = await cloudSave;
  if (result?.ok) toast("Completion confirmed and synced.");
  else if (result?.reason === "not-connected") toast("Completion confirmed locally. Connect cloud sync to share it.");
  else toast("Completion confirmed locally; cloud sync is still pending.");
}
function confirmChild(taskId, index) { const task = state.tasks.find((item) => item.id === taskId); const child = task?.children?.[index]; if (!child) return; updateChildRecord(taskId, child.id, (current) => ({ ...current, progress: 100, status: "pending_confirmation" })); saveState(); openCompletionPrompt(taskId, index); }
async function saveTaskChanges() {
  const task = state.tasks.find((item) => item.id === currentDetailTaskId);
  if (!task) return;
  task.title = $("#editTitle").value.trim() || task.title;
  task.scheduledDate = $("#editScheduledDate").value;
  task.deadline = $("#editDeadline").value;
  task.estimateHours = Number($("#editEstimateHours").value) || 1;
  task.difficulty = $("#editDifficulty").value;
  task.tagColor = $("#editTagColor").value;
  task.startTime = $("#editStartTime").value;
  task.endTime = $("#editEndTime").value;
  task.notes = $("#editNotes").value.trim();

  let pendingChildIndex = null;
  const nextChildren = (task.children || []).map((child, index) => {
    const title = document.querySelector(`[data-child-index="${index}"][data-child-field="title"]`);
    const date = document.querySelector(`[data-child-index="${index}"][data-child-field="date"]`);
    const startTime = document.querySelector(`[data-child-index="${index}"][data-child-field="startTime"]`);
    const endTime = document.querySelector(`[data-child-index="${index}"][data-child-field="endTime"]`);
    const progress = document.querySelector(`[data-child-index="${index}"][data-child-field="progress"]`);
    const nextChild = { ...child };
    if (title) nextChild.title = title.value.trim() || nextChild.title;
    if (date) nextChild.date = date.value || task.scheduledDate;
    if (startTime) nextChild.startTime = startTime.value;
    if (endTime) nextChild.endTime = endTime.value;
    if (progress) {
      nextChild.progress = clampProgress(progress.value);
      if (nextChild.progress >= 100) {
        if (nextChild.status !== "done") {
          nextChild.status = "pending_confirmation";
          if (pendingChildIndex == null) pendingChildIndex = index;
        }
      } else nextChild.status = childProgressStatus(nextChild.progress);
    }
    nextChild.tagColor = task.tagColor;
    return nextChild;
  });
  state.tasks = state.tasks.map((item) => item.id === task.id ? { ...item, children: nextChildren } : item);
  const savedTask = state.tasks.find((item) => item.id === task.id);

  if (savedTask.type === "long-term") {
    // Long-term progress is derived at read time; never write a subjective parent value.
  } else {
    const enteredProgress = clampProgress($("#editProgress")?.value ?? savedTask.progress ?? 0);
    let nextProgressOverride = savedTask.progressOverride;
    if (savedTask.type === "regular" && savedTask.children?.length) {
      const derived = Math.round(savedTask.children.filter((child) => child.status === "done").length / savedTask.children.length * 100);
      nextProgressOverride = enteredProgress === derived ? undefined : enteredProgress;
    }
    state.tasks = state.tasks.map((item) => item.id === savedTask.id ? { ...item, progress: enteredProgress, status: childProgressStatus(enteredProgress), progressOverride: nextProgressOverride } : item);
  }

  const cloudSave = saveState({ immediate: true });
  $("#taskDetailModal").close();
  render();
  if (pendingChildIndex != null) openCompletionPrompt(task.id, pendingChildIndex);
  else if (savedTask.status === "pending_confirmation") openCompletionPrompt(savedTask.id);
  const result = await cloudSave;
  if (result?.ok) toast("Task changes saved to cloud.");
  else if (result?.reason === "not-connected") toast("Saved on this device only. Connect cloud sync to share it.");
  else if (result?.reason === "cloud-not-ready") toast("Saved locally. Cloud is still connecting; keep this page open to sync.");
  else if (result?.reason === "queued") toast("Saved locally. The previous cloud save is finishing.");
  else toast(`Saved locally, but cloud sync failed: ${result?.message || "check your connection"}.`);
}

async function setTaskProgress(taskId, progress, childId = null) {
  const record = findTaskTarget(taskId, childId);
  if (!record) return;
  const { parent, target } = record;
  if (!childId && parent.type === "long-term") {
    toast("Long-term progress is calculated from subtasks.");
    return;
  }
  const wasOpen = $("#taskDetailModal").open;
  if (wasOpen) $("#taskDetailModal").close();
  if (childId) {
    updateChildRecord(parent.id, childId, (child) => ({ ...child, progress, status: childProgressStatus(progress) }));
  } else {
    state.tasks = state.tasks.map((task) => task.id === parent.id ? { ...task, ...(task.type === "regular" && task.children?.length ? { progressOverride: progress } : {}), progress, status: childProgressStatus(progress) } : task);
  }
  const cloudSave = saveState({ immediate: true });
  render();
  if (progress >= 100) openCompletionPrompt(parent.id, childId ? parent.children.findIndex((child) => child.id === childId) : null);
  else {
    openTaskDetail(parent.id, wasOpen, "readonly");
    toast(`${target.title || parent.title} progress updated to ${progress}%.`);
  }
  const result = await cloudSave;
  if (!result?.ok && result?.reason === "cloud-error") toast(`Progress saved locally; cloud sync failed: ${result.message || "check your connection"}.`);
}
function trackedMinutes(task) { return Math.max(0, Math.round(Number(task.actualDuration) || 0)); }
function findTaskTarget(taskId, childId = null) {
  const parent = state.tasks.find((item) => item.id === taskId);
  if (!parent) return null;
  if (!childId) return { parent, target: parent };
  const target = parent.children?.find((child) => child.id === childId);
  return target ? { parent, target } : null;
}
function updateChildRecord(parentId, childId, updater) {
  let updated = null;
  state.tasks = state.tasks.map((parent) => {
    if (parent.id !== parentId) return parent;
    const nextChildren = (parent.children || []).map((child) => {
      if (child.id !== childId) return child;
      const nextChild = updater({ ...child });
      updated = { parent: { ...parent, children: nextChildren }, target: nextChild };
      return nextChild;
    });
    return updated ? { ...parent, children: nextChildren } : parent;
  });
  return updated;
}
function toggleChildCompletion(parentId, childId) {
  const record = findTaskTarget(parentId, childId);
  if (!record) return;
  const nextDone = record.target.status !== "done";
  updateChildRecord(parentId, childId, (child) => ({ ...child, progress: nextDone ? 100 : 0, status: nextDone ? "done" : "not_started" }));
  const cloudSave = saveState({ immediate: true });
  const drawer = $("#taskDetailModal").classList.contains("drawer-mode");
  render();
  openTaskDetail(parentId, drawer, "readonly");
  cloudSave.catch(() => {});
}
let manualTimeTarget = null;
function openManualTimeModal(taskId, childId = null) {
  const record = findTaskTarget(taskId, childId);
  if (!record) return;
  manualTimeTarget = { taskId, childId: childId || null };
  $("#manualTimeTitle").textContent = record.target.title || record.parent.title;
  $("#manualActualDuration").value = String(trackedMinutes(record.target));
  $("#manualEstimatedDuration").textContent = formatTrackedMinutes(Math.round((Number(record.target.estimateHours) || 0) * 60));
  $("#manualTimeModal").showModal();
}
function saveManualTime() {
  if (!manualTimeTarget) return;
  const record = findTaskTarget(manualTimeTarget.taskId, manualTimeTarget.childId);
  if (!record) return;
  const actualDuration = Math.max(0, Math.round(Number($("#manualActualDuration").value) || 0));
  if (manualTimeTarget.childId) updateChildRecord(record.parent.id, manualTimeTarget.childId, (child) => ({ ...child, actualDuration }));
  else state.tasks = state.tasks.map((task) => task.id === record.parent.id ? { ...task, actualDuration } : task);
  const cloudSave = saveState({ immediate: true });
  const drawer = $("#taskDetailModal").classList.contains("drawer-mode");
  render();
  if ($("#taskDetailModal").open) openTaskDetail(record.parent.id, drawer, "readonly");
  cloudSave.catch(() => {});
}
function childProgressStatus(progress) { return progress >= 100 ? "pending_confirmation" : progress > 0 ? "in_progress" : "not_started"; }
function completeTask(taskId, childId = null) {
  const record = findTaskTarget(taskId, childId);
  if (!record || record.target.status === "done") return;
  const { parent, target } = record;
  if (target === parent && parent.type === "long-term") return;
  if (childId) updateChildRecord(parent.id, childId, (child) => ({ ...child, progress: 100, status: "done" }));
  else state.tasks = state.tasks.map((task) => task.id === parent.id ? { ...task, progress: 100, status: "done", progressOverride: undefined } : task);
  if ($("#taskDetailModal").open) $("#taskDetailModal").close();
  saveState({ immediate: true });
  render();
  showCompletionToast(target.title || parent.title, parent.id, target === parent ? null : target.id);
}
let taskQuickAction = null;
let taskQuickConfirmAction = null;
function quickActionRecord() { return taskQuickAction ? findTaskTarget(taskQuickAction.taskId, taskQuickAction.childId) : null; }
function openTaskQuickAction(taskId, childId = null) {
  const record = findTaskTarget(taskId, childId);
  if (!record || (!childId && record.parent.type === "long-term")) return;
  taskQuickAction = { taskId, childId: childId || null };
  renderTaskQuickAction();
  if (!$("#taskQuickActionModal").open) $("#taskQuickActionModal").showModal();
}
function renderTaskQuickAction() {
  const record = quickActionRecord();
  if (!record) { if ($("#taskQuickActionModal").open) $("#taskQuickActionModal").close(); return; }
  const { parent, target } = record;
  const progress = taskProgress(target);
  const completed = target.status === "done";
  const title = escapeHtml(target.title || parent.title);
  const content = completed
    ? `<div class="quick-action-header"><div><div class="section-kicker">COMPLETED</div><h2>I've Done It</h2><p class="quick-action-task-name">${title}</p></div><button class="icon-button" value="cancel" formnovalidate aria-label="Close">×</button></div><div class="quick-completed-state"><div class="quick-completed-face">^-^</div><div class="quick-progress-grid">${energyMarkup(100)}</div><strong>great!</strong></div><div class="modal-actions"><button class="secondary-button" value="cancel" formnovalidate>Close</button><button class="quick-reset-button" id="quickResetButton" type="button" aria-label="Reset completed task">↺</button></div>`
    : `<div class="quick-action-header"><div><div class="section-kicker">QUICK PROGRESS</div><h2>${title}</h2></div><button class="icon-button" value="cancel" formnovalidate aria-label="Close">×</button></div><div class="quick-progress-grid" id="quickProgressGrid">${energyMarkup(progress)}</div><div class="quick-progress-value" id="quickProgressValue">${progress}%</div><div class="quick-progress-adjust"><button class="quick-adjust-button" id="quickProgressMinus" type="button" aria-label="Decrease progress">−</button><button class="quick-adjust-button" id="quickProgressPlus" type="button" aria-label="Increase progress">+</button></div><div class="modal-actions"><button class="secondary-button" value="cancel" formnovalidate>Close</button><button class="quick-complete-button" id="quickCompleteButton" type="button" aria-label="Complete task">✓</button></div>`;
  $("#taskQuickActionContent").innerHTML = content;
  if (completed) {
    $("#quickResetButton")?.addEventListener("click", () => openTaskQuickConfirm("reset"));
    return;
  }
  $("#quickProgressMinus")?.addEventListener("click", () => updateQuickActionProgress(progress - 10));
  $("#quickProgressPlus")?.addEventListener("click", () => updateQuickActionProgress(progress + 10));
  $("#quickCompleteButton")?.addEventListener("click", () => openTaskQuickConfirm("complete"));
}
function updateQuickActionProgress(nextProgress) {
  const record = quickActionRecord();
  if (!record) return;
  const progress = clampProgress(nextProgress);
  const { parent } = record;
  if (taskQuickAction.childId) updateChildRecord(parent.id, taskQuickAction.childId, (child) => ({ ...child, progress, status: childProgressStatus(progress) }));
  else if (parent.type !== "long-term") state.tasks = state.tasks.map((task) => task.id === parent.id ? { ...task, ...(task.type === "regular" && task.children?.length ? { progressOverride: progress } : {}), progress, status: childProgressStatus(progress) } : task);
  else return;
  saveState({ immediate: true });
  render();
  renderTaskQuickAction();
}
function openTaskQuickConfirm(action) {
  if (!quickActionRecord()) return;
  taskQuickConfirmAction = action;
  const title = quickActionRecord().target.title || quickActionRecord().parent.title;
  $("#taskQuickConfirmMessage").textContent = action === "reset" ? `Reset “${title}” to 0%?` : `Mark “${title}” as complete?`;
  $("#taskQuickConfirmDialog").showModal();
}
function closeTaskQuickConfirm() { if ($("#taskQuickConfirmDialog").open) $("#taskQuickConfirmDialog").close(); taskQuickConfirmAction = null; }
function finalizeTaskQuickAction(action) {
  const record = quickActionRecord();
  if (!record) return;
  const { parent } = record;
  if (!taskQuickAction.childId && parent.type === "long-term") return;
  if (action === "complete") {
    if (taskQuickAction.childId) updateChildRecord(parent.id, taskQuickAction.childId, (child) => ({ ...child, progress: 100, status: "done" }));
    else state.tasks = state.tasks.map((task) => task.id === parent.id ? { ...task, progress: 100, status: "done", progressOverride: undefined } : task);
  } else if (taskQuickAction.childId) updateChildRecord(parent.id, taskQuickAction.childId, (child) => ({ ...child, progress: 0, status: "not_started" }));
  else state.tasks = state.tasks.map((task) => task.id === parent.id ? { ...task, progress: 0, status: "not_started", progressOverride: undefined } : task);
  const title = record.target.title || parent.title;
  const childId = taskQuickAction.childId;
  const cloudSave = saveState({ immediate: true });
  closeTaskQuickConfirm();
  if ($("#taskQuickActionModal").open) $("#taskQuickActionModal").close();
  taskQuickAction = null;
  render();
  if (action === "complete") showCompletionToast(title, parent.id, childId);
  else toast("Task reset to 0%.");
  cloudSave.catch(() => {});
}
function recordFocusTime(taskId, minutes, childId = null) {
  const record = findTaskTarget(taskId, childId);
  if (!record) return;
  const addedMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const actualDuration = trackedMinutes(record.target) + addedMinutes;
  if (childId) updateChildRecord(record.parent.id, childId, (child) => ({ ...child, actualDuration }));
  else state.tasks = state.tasks.map((task) => task.id === record.parent.id ? { ...task, actualDuration } : task);
  saveState({ immediate: true });
  render();
  toast(`Recorded +${addedMinutes}m focus time.`);
}
function showCompletionToast(title, taskId, childId = null) {
  const element = $("#toast");
  clearTimeout(toast.timer);
  element.innerHTML = `<span>${escapeHtml(title)} completed. Do you want to log focus time?</span><div class="toast-actions"><button type="button" data-toast-focus="30">+30m</button><button type="button" data-toast-focus="60">+1h</button><button type="button" data-toast-focus="120">+2h</button><label class="toast-custom-time"><input data-toast-custom-minutes type="number" min="1" step="5" placeholder="min" aria-label="Custom minutes" /></label><button type="button" data-toast-focus-custom>+ Add</button></div>`;
  element.classList.add("show", "completion-toast");
  element.querySelectorAll("[data-toast-focus]").forEach((button) => button.addEventListener("click", () => {
    hideToast();
    recordFocusTime(taskId, Number(button.dataset.toastFocus), childId);
  }));
  element.querySelector("[data-toast-focus-custom]")?.addEventListener("click", () => {
    const minutes = Number(element.querySelector("[data-toast-custom-minutes]")?.value);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    hideToast();
    recordFocusTime(taskId, minutes, childId);
  });
  toast.timer = setTimeout(hideToast, 5000);
}
function hideToast() {
  const element = $("#toast");
  clearTimeout(toast.timer);
  element.classList.remove("show", "completion-toast");
  element.textContent = "";
}
function checkHabit(habitId) { const habit = state.habits.find((item) => item.id === habitId); if (!habit) return; habit.checkins ||= []; const today = todayIso(); const index = habit.checkins.indexOf(today); if (index >= 0) { habit.checkins.splice(index, 1); saveState(); render(); toast(`${habit.name} check-in undone.`); return; } habit.checkins.push(today); saveState(); render(); toast(`${habit.name} checked in for today.`); }

function openTaskModal() { const form = $("#taskForm"); form.reset(); $("#taskModal").showModal(); }
function createTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (event.submitter?.value === "cancel") { form.reset(); $("#taskModal").close(); return; }
  const title = new FormData(form).get("title")?.toString().trim();
  if (!title) return;
  const task = {
    id: uid("task"),
    type: "regular",
    title,
    notes: "",
    scheduledDate: selectedDate,
    deadline: "",
    estimateHours: 1,
    difficulty: "normal",
    progress: 0,
    status: "not_started",
    actualDuration: 0,
    startTime: "",
    endTime: "",
    children: [],
    sortOrder: state.tasks.length,
    tagColor: DEFAULT_TAG_COLOR.regular,
    createdAt: new Date().toISOString(),
  };
  state.tasks.push(task);
  saveState();
  form.reset();
  $("#taskModal").close();
  currentTab = "today";
  render();
  toast("Task created. Add details whenever you need them.");
}

function importCourseFile(file) { const reader = new FileReader(); reader.onload = () => { try { const parsed = JSON.parse(reader.result); validateCourseData(parsed); pendingImport = parsed; renderImportPreview(parsed); $("#importModal").showModal(); } catch (error) { toast(`Import failed: ${error.message}`); } }; reader.readAsText(file); }
function validateCourseData(data) { if (!data || !data.semester?.week1Monday || !Array.isArray(data.courses)) throw new Error("需要 semester.week1Monday 和 courses 字段"); data.courses.forEach((course) => { if (!course.id || !course.name || !Array.isArray(course.sessions)) throw new Error("课程缺少 id、name 或 sessions"); course.sessions.forEach((session) => { if (!(session.day >= 1 && session.day <= 7) || !Array.isArray(session.weeks) || !session.start || !session.end) throw new Error(`课程 ${course.name} 的 session 字段不完整`); }); }); }
function renderImportPreview(data) { const occurrences = expandCourses(data); $("#importSummary").innerHTML = `<strong>${escapeHtml(data.semester.name || "Course timetable")}</strong><br>${data.courses.length} courses · ${occurrences.length} generated occurrences · conflicts will be shown on the timeline.`; $("#importPreview").innerHTML = occurrences.slice(0, 24).map((item) => `<div class="import-row"><strong>${escapeHtml(item.name)}</strong><small>${item.date} · ${item.start}—${item.end}</small><small>${escapeHtml(item.room || "No room")}</small></div>`).join("") + (occurrences.length > 24 ? `<div class="muted-label">Showing first 24 of ${occurrences.length} occurrences.</div>` : ""); }
function expandCourses(data) {
  const result = [];
  const week1 = parseDate(data.semester.week1Monday);
  data.courses.forEach((course) => course.sessions.forEach((session) => session.weeks.forEach((week) => {
    const date = new Date(week1);
    date.setDate(week1.getDate() + (week - 1) * 7 + (session.day - 1));
    result.push({ id: uid("course-occurrence"), courseId: course.id, name: course.name, teacher: course.teacher, category: course.category, room: session.room, note: session.note || "", date: isoDate(date), start: session.start, end: session.end, week, period: session.period, kind: "course" });
  })));
  return result.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}
function commitCourseImport() { if (!pendingImport) return; state.courses = expandCourses(pendingImport); state.courseMeta = { name: pendingImport.semester.name, week1Monday: pendingImport.semester.week1Monday, totalWeeks: Math.max(...pendingImport.courses.flatMap((course) => course.sessions.flatMap((session) => session.weeks)), 0), importedAt: new Date().toISOString() }; saveState(); pendingImport = null; $("#importModal").close(); render(); toast(`${state.courses.length} course occurrences imported.`); }

function exportData() { const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `xiaoyu-export-${todayIso()}.json`; link.click(); URL.revokeObjectURL(url); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function toast(message) { const element = $("#toast"); clearTimeout(toast.timer); element.classList.remove("completion-toast"); element.textContent = message; element.classList.add("show"); toast.timer = setTimeout(() => element.classList.remove("show"), 2500); }

function openAuthModal() {
  updateCloudControls();
  $("#authEmail").value = cloudSession?.user?.email || "";
  $("#authStatus").textContent = cloudSession ? `Connected as ${cloudSession.user.email || "your account"}.` : cloudClientReady ? "After signing in, this browser will sync with your private cloud workspace." : "Cloud service is still loading. Please wait a moment or refresh the page.";
  $("#authModal").showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  if (cloudSession) return;
  if (!supabaseClient) {
    $("#authStatus").textContent = "Cloud service is not ready. Please refresh the page and try again.";
    return;
  }
  const email = $("#authEmail").value.trim();
  if (!email) return;
  const button = $("#authSubmitButton");
  button.disabled = true;
  $("#authStatus").textContent = "Sending your sign-in link…";
  const { error } = await supabaseClient.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  button.disabled = false;
  $("#authStatus").textContent = error ? `Could not send the link: ${error.message}` : "Check your email and open the sign-in link. This window can stay open.";
}

async function signInWithGithub() {
  if (!supabaseClient) {
    $("#authStatus").textContent = "Cloud service is not ready. Please refresh the page and try again.";
    return;
  }
  const button = $("#authGithubButton");
  button.disabled = true;
  $("#authStatus").textContent = "Opening GitHub sign-in…";
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider: "github", options: { redirectTo: window.location.href } });
  if (error) {
    button.disabled = false;
    $("#authStatus").textContent = `Could not open GitHub sign-in: ${error.message}`;
  }
}

async function signOutCloud() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  cloudSession = null;
  cloudSyncReady = false;
  $("#authModal").close();
  updateCloudControls();
  toast("Cloud sync disconnected. Local data remains on this device.");
}

$("#taskForm").addEventListener("submit", createTask);
$("#eventForm").addEventListener("submit", saveEventForm);
$("#deleteEventButton").addEventListener("click", deleteEvent);
$("#courseFileInput").addEventListener("change", (event) => { if (event.target.files[0]) importCourseFile(event.target.files[0]); event.target.value = ""; });
$("#confirmImportButton").addEventListener("click", (event) => { event.preventDefault(); commitCourseImport(); });
$("#saveTaskButton").addEventListener("click", saveTaskChanges);
$("#editTaskButton").addEventListener("click", () => { if (currentDetailTaskId) openTaskDetail(currentDetailTaskId, $("#taskDetailModal").classList.contains("drawer-mode"), "edit"); });
$("#confirmCompleteButton").addEventListener("click", () => { const button = $("#confirmCompleteButton"); completeTask(button.dataset.completeTask); });
$("#taskDetailModal").addEventListener("close", () => { $("#taskDetailModal").classList.remove("drawer-mode"); currentDetailMode = "readonly"; });
$("#manualActualDuration").addEventListener("change", saveManualTime);
$("#manualTimeModal").addEventListener("close", () => { manualTimeTarget = null; });
$("#confirmCompletionButton").addEventListener("click", (event) => { event.preventDefault(); applyPendingCompletion(); });
$("#completionModal").addEventListener("close", () => { if ($("#completionModal").returnValue === "cancel") pendingCompletion = null; });
$("#taskQuickConfirmCancel").addEventListener("click", closeTaskQuickConfirm);
$("#taskQuickConfirmYes").addEventListener("click", () => { const action = taskQuickConfirmAction; if (action) finalizeTaskQuickAction(action); });
$("#taskQuickConfirmDialog").addEventListener("close", () => { taskQuickConfirmAction = null; });
$("#taskQuickActionModal").addEventListener("close", () => { taskQuickAction = null; taskQuickConfirmAction = null; if ($("#taskQuickConfirmDialog").open) $("#taskQuickConfirmDialog").close(); });
$("#saveHabitButton").addEventListener("click", (event) => { event.preventDefault(); saveHabitChanges(); });
$("#deleteHabitButton").addEventListener("click", deleteHabit);
$("#cloudLoginButton").addEventListener("click", openAuthModal);
$("#authForm").addEventListener("submit", submitAuth);
$("#authGithubButton").addEventListener("click", signInWithGithub);
$("#authSignOutButton").addEventListener("click", signOutCloud);
$("#previousDay").addEventListener("click", () => { const date = parseDate(selectedDate); date.setDate(date.getDate() - 1); selectedDate = isoDate(date); render(); });
$("#nextDay").addEventListener("click", () => { const date = parseDate(selectedDate); date.setDate(date.getDate() + 1); selectedDate = isoDate(date); render(); });
$("#jumpToday").addEventListener("click", () => { selectedDate = todayIso(); render(); });
$("#showIncomplete").addEventListener("click", () => { showIncompleteOnly = !showIncompleteOnly; render(); });
$("#exportData").addEventListener("click", exportData);
$("#menuTrigger").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").classList.add("open"); });
$("#sidebarClose").addEventListener("click", closeSidebar); $("#scrim").addEventListener("click", closeSidebar);
$("#insightClose").addEventListener("click", () => $("#insightColumn").classList.remove("open"));
function closeActionMenus() { $("#viewMenu").hidden = true; $("#viewMenuButton").setAttribute("aria-expanded", "false"); }
function closeNewActionSheet() { if ($("#newActionSheet")?.open) $("#newActionSheet").close(); }
$("#newMenuButton").addEventListener("click", (event) => { event.stopPropagation(); closeActionMenus(); $("#newActionSheet").showModal(); $("#newMenuButton").setAttribute("aria-expanded", "true"); });
$("#viewMenuButton").addEventListener("click", (event) => { event.stopPropagation(); const menu = $("#viewMenu"); const next = menu.hidden; closeActionMenus(); menu.hidden = !next; $("#viewMenuButton").setAttribute("aria-expanded", String(next)); });
$("#insightTrigger").addEventListener("click", () => { closeActionMenus(); $("#insightColumn").classList.add("open"); });
$$(`#newActionSheet [data-new-action]`).forEach((button) => button.addEventListener("click", () => { const action = button.dataset.newAction; closeNewActionSheet(); if (action === "task") openTaskModal(); if (action === "event") openEventDetail(); if (action === "course") $("#courseFileInput").click(); }));
$("#newActionSheet").addEventListener("close", () => $("#newMenuButton").setAttribute("aria-expanded", "false"));
window.addEventListener("click", closeActionMenus);
$$('.nav-item').forEach((item) => item.addEventListener("click", () => { currentView = item.dataset.view; currentTab = currentView === "assignment" ? "board" : "today"; $$(".nav-item").forEach((nav) => nav.classList.toggle("active", nav === item)); if (currentView === "assignment") { $("#pageTitle").textContent = "Assignment and goal"; } else { $("#pageTitle").textContent = placeholderText(currentView).title; } resetPageScroll(); render(); closeSidebar(); }));
$$('.view-tab').forEach((tab) => tab.addEventListener("click", () => { currentTab = tab.dataset.tab; resetPageScroll(); renderActiveTab(); }));
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSidebar(); });
window.addEventListener("offline", () => { if (cloudSession) setSyncStatus("Offline — local changes are queued", "pending"); });
window.addEventListener("online", async () => { if (cloudSession) await hydrateStateFromCloud(); });
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("open"); }
function resetPageScroll() { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; $(".main-column")?.scrollTo({ top: 0, left: 0, behavior: "auto" }); }

render();
initCloudSync();
