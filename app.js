const STORAGE_KEY = "xiaoyu-assistant-state-v1";
const DIFFICULTY = { simple: 1, normal: 1.5, hard: 2.5 };
const TYPE_LABEL = { regular: "Regular Task", standalone: "Standalone Task", "long-term": "Long-term Task", subtask: "Sub-task" };
const TAG_COLORS = ["#8EA1B5", "#9CAF88", "#C08A8A", "#CDBBA0", "#A697B5", "#D9A05B", "#86A3A3", "#D8B4B4"];
const DEFAULT_TAG_COLOR = { regular: "#8EA1B5", standalone: "#D9A05B", "long-term": "#86A3A3", subtask: "#8EA1B5" };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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
  { id: "habit-exercise", name: "锻炼", cadence: "weekly", kpi: 3, checkins: [] },
  { id: "habit-reading", name: "阅读", cadence: "weekly", kpi: 4, checkins: [] },
  { id: "habit-water", name: "喝水", cadence: "weekly", kpi: 7, checkins: [] },
  { id: "habit-skincare", name: "护肤", cadence: "weekly", kpi: 5, checkins: [] },
  { id: "habit-words", name: "背单词", cadence: "weekly", kpi: 5, checkins: [] },
  { id: "habit-podcast", name: "听博客", cadence: "monthly", kpi: 8, checkins: [] },
];

const state = loadState();
let selectedDate = todayIso();
let currentTab = "board";
let currentView = "assignment";
let pendingImport = null;
let currentDetailTaskId = null;
let pendingCompletion = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return { ...saved, tasks: (saved.tasks || []).filter((task) => task.title), courses: saved.courses || [], habits: saved.habits || defaultHabits };
  } catch (error) { console.warn("Could not load local data", error); }
  return {
    tasks: [
      { id: "demo-1", type: "regular", title: "整理本周学习计划", notes: "把课程、作业和可用时间放到同一条时间轴里。", scheduledDate: todayIso(), deadline: todayIso(), estimateHours: 1.5, difficulty: "normal", progress: 60, status: "in_progress", actualMinutes: 42, startTime: "09:00", endTime: "10:30", children: [], tagColor: "#8EA1B5", createdAt: new Date().toISOString() },
      { id: "demo-2", type: "standalone", title: "回复一封重要邮件", notes: "", scheduledDate: todayIso(), deadline: todayIso(), estimateHours: 0.5, difficulty: "simple", progress: 0, status: "not_started", actualMinutes: 0, startTime: "16:00", endTime: "16:30", children: [], tagColor: "#D9A05B", createdAt: new Date().toISOString() },
      { id: "demo-long", type: "long-term", title: "建立个人学习系统", notes: "第一版先完成任务、课程和习惯基础。", scheduledDate: todayIso(), deadline: "2026-12-31", estimateHours: 20, difficulty: "hard", progress: 33, status: "in_progress", actualMinutes: 90, children: [
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

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function formatDate(value, options = { month: "long", day: "numeric", weekday: "long" }) { return new Intl.DateTimeFormat("zh-CN", options).format(parseDate(value)); }
function formatEnglishDate(value, options = { month: "short", day: "numeric" }) { return new Intl.DateTimeFormat("en-US", options).format(parseDate(value)); }
function formatShortDate(value) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(parseDate(value)); }
function difficultyWeight(task) { return Number(task.estimateHours || 0) * (DIFFICULTY[task.difficulty] || 1); }
function isTaskCompleted(task) { return task.status === "done"; }
function progressForTask(task) {
  if (task.type === "long-term") {
    const children = task.children || [];
    return children.length ? Math.round(children.filter((child) => child.status === "done").length / children.length * 100) : 0;
  }
  if (task.children?.length && task.progressOverride == null) return Math.round(task.children.filter((child) => child.status === "done").length / task.children.length * 100);
  if (task.progressOverride != null) return Math.max(0, Math.min(100, Number(task.progressOverride)));
  return Math.max(0, Math.min(100, Number(task.progress || 0)));
}
function taskColor(task) { return task.tagColor || DEFAULT_TAG_COLOR[task.type] || DEFAULT_TAG_COLOR.subtask; }
function hexToRgba(hex, alpha = 0.1) { const clean = hex.replace("#", ""); const value = clean.length === 3 ? clean.split("").map((part) => part + part).join("") : clean; const number = Number.parseInt(value, 16); return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`; }
function taskStatusLabel(task) { return task.status === "done" ? "Completed" : task.status === "pending_confirmation" ? "Confirm completion" : task.status === "in_progress" ? "In progress" : "Not started"; }

function tasksForDate(date) {
  return state.tasks.flatMap((task) => {
    if (task.type === "long-term") return (task.children || []).filter((child) => child.date === date).map((child) => ({ ...child, parentId: task.id, parentTitle: task.title, type: "subtask", estimateHours: child.estimateHours || 1, difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, scheduledDate: child.date, timerStartedAt: task.timerStartedAt, actualMinutes: task.actualMinutes }));
    if (task.children?.length) return task.children.filter((child) => child.date === date).map((child) => ({ ...child, parentId: task.id, parentTitle: task.title, type: "subtask", estimateHours: child.estimateHours || task.estimateHours / task.children.length, difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, scheduledDate: child.date, timerStartedAt: task.timerStartedAt, actualMinutes: task.actualMinutes }));
    return task.scheduledDate === date ? [task] : [];
  });
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
  const filled = Math.ceil(value / 10);
  const face = value >= 100 ? " ^-^" : "";
  return `<div class="battery-progress ${orientation}" data-weight="${weight}" aria-label="Progress ${value}%, weight ${weight}"><div class="energy-grid">${Array.from({ length: 10 }, (_, index) => `<span class="energy-cell ${index < filled ? `filled ${colorClass(value)}` : ""}"></span>`).join("")}</div>${showValue ? `<span class="battery-value">${value}%${face}</span>` : ""}</div>`;
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
  const active = tasks.filter((task) => taskProgress(task) < 100).length;
  const courses = courseOccurrencesForDate(selectedDate).length;
  $("#statsRow").innerHTML = [
    ["Tasks", tasks.length, `${completed} completed`],
    ["In focus", active, "still to carry"],
    ["Courses", courses, courses ? "on the time axis" : "none today"],
  ].map(([label, value, foot]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join("");
}

function renderTimeline() {
  const entries = [
    ...courseOccurrencesForDate(selectedDate).map((course) => ({ ...course, kind: "course" })),
    ...tasksForDate(selectedDate).filter((task) => task.startTime || task.endTime).map((task) => ({ ...task, kind: "task", title: task.title, start: task.startTime || "—", end: task.endTime || "" })),
  ].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (!entries.length) { $("#timeline").innerHTML = `<div class="timeline-empty">No scheduled blocks yet. Your day is open.</div>`; return; }
  $("#timeline").innerHTML = entries.map((entry) => {
    const conflict = entry.kind === "task" && courseOccurrencesForDate(selectedDate).some((course) => overlaps(entry.start, entry.end, course.start, course.end));
    const meta = entry.kind === "course" ? [entry.room, entry.teacher].filter(Boolean).join(" · ") : `${TYPE_LABEL[entry.type] || "Task"}${conflict ? " · overlaps a course" : ""}`;
    const color = entry.kind === "task" ? taskColor(entry) : "#CDBBA0";
    return `<div class="timeline-item ${entry.kind} ${conflict ? "conflict" : ""} ${entry.difficulty === "hard" ? "hard" : ""}" style="--task-color:${color};--task-tint:${hexToRgba(color)}"><div class="timeline-time">${entry.start}<br>${entry.end}</div><div class="timeline-line"></div><div><div class="timeline-title">${escapeHtml(entry.title || entry.name)}</div><div class="timeline-meta">${escapeHtml(meta || "Time block")}</div></div>${entry.kind === "task" ? `<button class="timeline-action" data-open-task="${entry.parentId || entry.id}">Open</button>` : `<span class="timeline-action">Course</span>`}</div>`;
  }).join("");
  $$("[data-open-task]").forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.openTask)));
}

function renderTasks() {
  const tasks = tasksForDate(selectedDate);
  if (!tasks.length) { $("#taskList").innerHTML = `<div class="empty-state">No task is assigned to this date. You can leave it open or add a small next step.</div>`; return; }
  $("#taskList").innerHTML = tasks.map((task) => {
    const progress = taskProgress(task);
    const status = task.status === "pending_confirmation" || progress >= 100 && task.status !== "done" ? "pending" : task.status === "done" ? "done" : "";
    const detailId = task.parentId || task.id;
    const childText = task.type === "subtask" ? `Child of ${escapeHtml(task.parentTitle)}` : task.children?.length ? `${task.children.length} same-level subtasks` : `${task.estimateHours || 0}h estimated`;
    return `<article class="task-card ${task.difficulty === "hard" ? "hard" : ""}" style="--task-color:${taskColor(task)};--task-tint:${hexToRgba(taskColor(task))}"><div class="task-card-top"><div><div class="task-card-title"><span class="task-color-dot"></span>${escapeHtml(task.title)}</div><div class="task-card-meta">${childText} · ${escapeHtml(taskStatusLabel(task))}</div></div><div class="task-card-actions"><span class="status-pill ${status}">${status === "pending" ? "Confirm" : status === "done" ? "Done" : task.type === "subtask" ? "Sub-task" : task.type}</span><button class="icon-button" data-open-task="${detailId}" aria-label="打开任务">›</button></div></div><div class="progress-row">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div><div class="task-footer"><span>${task.actualMinutes || 0} min tracked</span><button class="timer-button ${task.timerStartedAt ? "running" : ""}" data-start-task="${detailId}">${timerLabel(task)}</button></div>${task.children?.length && task.type !== "long-term" ? `<div class="subtask-note">${task.children.map((child) => `${child.status === "done" ? "✓" : "○"} ${escapeHtml(child.title)}`).join("　")}</div>` : ""}</article>`;
  }).join("");
  $$(`[data-open-task]`).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.openTask)));
  $$(`[data-start-task]`).forEach((button) => button.addEventListener("click", () => toggleTimer(button.dataset.startTask)));
}

function renderLongTerm() {
  const tasks = state.tasks.filter((task) => task.type === "long-term");
  if (!tasks.length) { $("#longTermList").innerHTML = `<div class="empty-state">Long-term projects will appear here when you create one.</div>`; return; }
  $("#longTermList").innerHTML = tasks.map((task) => { const progress = progressForTask(task); return `<article class="long-term-card" style="--task-color:${taskColor(task)};--task-tint:${hexToRgba(taskColor(task))}"><div class="task-card-top"><div><div class="task-card-title"><span class="task-color-dot"></span>${escapeHtml(task.title)}</div><div class="task-card-meta">${(task.children || []).filter((child) => child.status === "done").length} / ${(task.children || []).length} subtasks complete</div></div><span class="status-pill ${task.status === "done" ? "done" : ""}">${progress}%</span></div><div class="progress-row">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div></article>`; }).join("");
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
    if (task.children?.length && ["regular", "long-term"].includes(task.type)) return task.children.map((child) => ({ ...child, id: child.id, sourceId: child.id, parentId: task.id, parentTitle: task.title, type: "subtask", scheduledDate: child.date, estimateHours: child.estimateHours || Math.max(.25, (task.estimateHours || 1) / task.children.length), difficulty: child.difficulty || task.difficulty, tagColor: child.tagColor || task.tagColor, timerStartedAt: task.timerStartedAt, actualMinutes: task.actualMinutes }));
    return task;
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
  return `<div class="board-heading section-heading"><div><h2>Task board</h2></div><div class="board-hint">${boardItems().length} actionable items</div></div><div class="kanban-board">${columns.map(([key, title, subtitle]) => `<section class="kanban-column" data-board-column="${key}" data-drop-date="${key === "today" ? today : key === "tomorrow" ? tomorrow : addDays(today, 2)}"><div class="kanban-column-header"><div><h3>${title}</h3><span>${subtitle}</span></div><b>${groups[key].length}</b></div><div class="board-drop-zone">${groups[key].length ? groups[key].map((item) => { const progress = taskProgress(item); const owner = item.parentId || item.id; return `<article class="kanban-card ${item.difficulty === "hard" ? "hard" : ""}" draggable="true" data-board-id="${item.id}" data-board-parent="${item.parentId || ""}" data-open-task="${owner}" style="--task-color:${taskColor(item)};--task-tint:${hexToRgba(taskColor(item))}"><div class="kanban-card-title"><span class="task-color-dot"></span><span>${escapeHtml(item.title)}</span></div><div class="kanban-card-meta"><span>${Number(item.estimateHours || 0).toLocaleString("en-US")}h${item.parentId ? ` · ${escapeHtml(item.parentTitle)}` : ""}</span><span>${item.scheduledDate === today ? "Today" : formatEnglishDate(item.scheduledDate)}</span></div><div class="kanban-card-footer">${batteryProgressBar(progress, difficultyWeight(item), "vertical")}<button class="timer-button ${item.timerStartedAt ? "running" : ""}" data-start-task="${owner}">${item.timerStartedAt ? `Running · ${elapsedLabel(item)}` : "Start timer"}</button></div></article>`; }).join("") : `<div class="board-empty">Drop a task here</div>`}</div></section>`).join("")}</div>`;
}
function bindBoardView() {
  $$(`[data-board-id]`).forEach((card) => {
    card.addEventListener("dragstart", (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", JSON.stringify({ id: card.dataset.boardId, parentId: card.dataset.boardParent })); card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", (event) => { if (!event.target.closest("[data-start-task]")) openTaskDetail(card.dataset.openTask, true); });
  });
  $$(`[data-board-column]`).forEach((column) => {
    column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", (event) => { event.preventDefault(); column.classList.remove("drag-over"); try { const payload = JSON.parse(event.dataTransfer.getData("text/plain")); const source = boardItems().find((item) => item.id === payload.id && (item.parentId || "") === (payload.parentId || "")); if (!source) return; const targetDate = column.dataset.dropDate; if (updateScheduledDate(source, targetDate)) { saveState(); selectedDate = targetDate; render(); toast(`Scheduled for ${formatShortDate(targetDate)}.`); } } catch (error) { console.warn("Board drop ignored", error); } });
  });
  $$(`[data-start-task]`).forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); toggleTimer(button.dataset.startTask); }));
}

const CALENDAR_START = 8 * 60;
const CALENDAR_END = 22 * 60;
const CALENDAR_SLOT_HEIGHT = 10;
function timeToMinutes(value) { if (!value) return null; const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function minutesToTime(value) { const minutes = Math.max(0, Math.round(value)); return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
function snapToFive(value) { return Math.round(value / 5) * 5; }
function eventOccurrencesForDate(date) { return (state.events || []).filter((event) => event.date === date && event.start && event.end).map((event) => ({ ...event, kind: "event", name: event.name || event.title || "Event" })); }
function calendarItemsForDate(date) { return { courses: [...courseOccurrencesForDate(date), ...eventOccurrencesForDate(date)].filter((item) => item.start && item.end), tasks: tasksForDate(date).filter((item) => item.startTime && item.endTime) }; }
let currentEventId = null;
function openEventDetail(eventId = null) { const event = (state.events || []).find((item) => item.id === eventId); currentEventId = event?.id || null; $("#eventModalTitle").textContent = event ? "Edit event" : "Add an event"; $("#eventTitle").value = event?.name || event?.title || ""; $("#eventDate").value = event?.date || selectedDate; $("#eventStart").value = event?.start || "09:00"; $("#eventEnd").value = event?.end || "10:00"; $("#eventColor").value = event?.color || "#E8DCD1"; $("#eventNotes").value = event?.notes || ""; $("#deleteEventButton").hidden = !event; $("#eventModal").showModal(); }
function saveEventForm(event) { event.preventDefault(); if (event.submitter?.value === "cancel") { $("#eventModal").close(); currentEventId = null; return; } const title = $("#eventTitle").value.trim(); const date = $("#eventDate").value; const start = $("#eventStart").value; const end = $("#eventEnd").value; if (!title || !date || !start || !end) return; if (timeToMinutes(end) <= timeToMinutes(start)) { toast("End time must be after start time."); return; } const wasEditing = Boolean(currentEventId); state.events ||= []; const record = { id: currentEventId || uid("event"), name: title, title, date, start, end, color: $("#eventColor").value, notes: $("#eventNotes").value.trim(), kind: "event" }; if (currentEventId) { const index = state.events.findIndex((item) => item.id === currentEventId); if (index >= 0) state.events[index] = { ...state.events[index], ...record }; } else state.events.push(record); saveState(); $("#eventModal").close(); selectedDate = date; currentTab = "week"; render(); toast(wasEditing ? "Event updated." : "Event added."); currentEventId = null; }
function deleteEvent() { if (!currentEventId) return; const event = state.events.find((item) => item.id === currentEventId); if (!event) return; state.events = state.events.filter((item) => item.id !== currentEventId); saveState(); $("#eventModal").close(); currentEventId = null; render(); toast("Event deleted."); }
function layoutCalendarTasks(tasks) {
  const sorted = [...tasks].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime) || timeToMinutes(a.endTime) - timeToMinutes(b.endTime)); const lanes = []; const placed = [];
  sorted.forEach((task) => { const start = timeToMinutes(task.startTime); const end = timeToMinutes(task.endTime); let lane = lanes.findIndex((lastEnd) => start >= lastEnd); if (lane < 0) { lane = lanes.length; lanes.push(end); } else lanes[lane] = end; placed.push({ task, start, end, lane }); });
  return placed.map((item) => { const connected = placed.filter((other) => other.start < item.end && other.end > item.start); const laneCount = Math.max(1, ...connected.map((other) => other.lane + 1)); return { ...item, laneCount }; });
}
function calendarBlockStyle(start, end) { const top = Math.max(0, (start - CALENDAR_START) / 5 * CALENDAR_SLOT_HEIGHT); const height = Math.max(25, (end - start) / 5 * CALENDAR_SLOT_HEIGHT); return `top:${top}px;height:${height}px;`; }
function renderCalendarDay(date) {
  const { courses, tasks } = calendarItemsForDate(date); const laidOut = layoutCalendarTasks(tasks); const backgrounds = courses.map((course) => `<div class="calendar-background-item ${course.kind === "event" ? "event-background" : ""}" ${course.kind === "event" ? `data-open-event="${course.id}"` : ""} style="${calendarBlockStyle(timeToMinutes(course.start), timeToMinutes(course.end))};--event-color:${course.color || "#E8DCD1"}"><strong>${escapeHtml(course.name || course.title)}</strong><span>${course.start}—${course.end}</span></div>`).join(""); const foreground = laidOut.map(({ task, start, end, lane, laneCount }) => { const owner = task.parentId || task.id; const width = 100 / laneCount; const widthStyle = laneCount === 1 ? "100%" : `calc(${width}% - 4px)`; return `<article class="calendar-task-item ${laneCount > 1 ? "overlapping" : ""} ${task.difficulty === "hard" ? "hard" : ""}" draggable="true" data-calendar-id="${task.id}" data-calendar-parent="${task.parentId || ""}" data-open-task="${owner}" style="${calendarBlockStyle(start, end)}left:${lane * width}%;width:${widthStyle};--task-color:${taskColor(task)}"><span class="calendar-task-title">${escapeHtml(task.title)}</span><span class="calendar-task-time">${task.startTime}—${task.endTime}</span></article>`; }).join(""); return `<div class="week-day-column"><div class="week-day-header"><strong>${DAY_NAMES_ZH[parseDate(date).getDay()]}</strong><span>${formatShortDate(date)} · ${dailyProgress(date) == null ? "N/A" : `${dailyProgress(date)}%`}</span></div><div class="week-grid" data-week-date="${date}">${backgrounds}${foreground}</div></div>`;
}
function renderWeekView() {
  const days = weekDatesFor(selectedDate); const labels = Array.from({ length: 15 }, (_, index) => `${String(8 + index).padStart(2, "0")}:00`);
  return `<div class="section-heading"><div><div class="section-kicker">WEEKLY CALENDAR · 5 MIN SNAP</div><h2>${formatDate(days[0], { month: "short", day: "numeric" })} — ${formatDate(days[6], { month: "short", day: "numeric" })}</h2></div><div class="calendar-nav"><button class="secondary-button" id="weekPrev">‹ Previous</button><button class="secondary-button" id="weekToday">Today</button><button class="secondary-button" id="weekNext">Next ›</button></div></div><div class="week-calendar-card"><div class="week-calendar-scroll"><div class="week-calendar"><div class="week-axis"><div class="week-axis-head"></div><div class="week-axis-labels">${labels.map((label) => `<span>${label}</span>`).join("")}</div></div><div class="week-day-columns">${days.map(renderCalendarDay).join("")}</div></div></div></div>`;
}
function bindWeekView() {
  $("#weekPrev")?.addEventListener("click", () => { selectedDate = addDays(selectedDate, -7); render(); }); $("#weekNext")?.addEventListener("click", () => { selectedDate = addDays(selectedDate, 7); render(); }); $("#weekToday")?.addEventListener("click", () => { selectedDate = todayIso(); render(); });
  $$(`[data-calendar-id]`).forEach((block) => {
    block.addEventListener("dragstart", (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", JSON.stringify({ id: block.dataset.calendarId, parentId: block.dataset.calendarParent })); });
    block.addEventListener("click", () => openTaskDetail(block.dataset.openTask, true));
  });
  $$(`[data-week-date]`).forEach((grid) => grid.addEventListener("dragover", (event) => event.preventDefault()));
  $$(`[data-week-date]`).forEach((grid) => grid.addEventListener("drop", (event) => { event.preventDefault(); try { const payload = JSON.parse(event.dataTransfer.getData("text/plain")); const source = boardItems().find((item) => item.id === payload.id && (item.parentId || "") === (payload.parentId || "")); if (!source) return; const duration = Math.max(5, (timeToMinutes(source.endTime) || timeToMinutes(source.startTime) + 30) - (timeToMinutes(source.startTime) || CALENDAR_START)); const rect = grid.getBoundingClientRect(); const scrollTop = grid.parentElement?.scrollTop || 0; const minute = snapToFive(CALENDAR_START + ((event.clientY - rect.top + scrollTop) / CALENDAR_SLOT_HEIGHT) * 5); const start = Math.max(CALENDAR_START, Math.min(CALENDAR_END - duration, minute)); const end = start + duration; if (updateScheduledDate(source, grid.dataset.weekDate, minutesToTime(start), minutesToTime(end))) { saveState(); selectedDate = grid.dataset.weekDate; render(); toast(`Moved to ${minutesToTime(start)}.`); } } catch (error) { console.warn("Calendar drop ignored", error); } }));
}
function bindEventButtons() { $$('[data-open-event]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openEventDetail(button.dataset.openEvent); })); }

function monthHeatmapData() { const date = parseDate(selectedDate); const year = date.getFullYear(); const month = date.getMonth(); const last = new Date(year, month + 1, 0).getDate(); return { year, month, days: Array.from({ length: last }, (_, index) => { const day = String(index + 1).padStart(2, "0"); const iso = `${year}-${String(month + 1).padStart(2, "0")}-${day}`; return { iso, day: index + 1, progress: dailyProgress(iso) }; }) }; }
function heatClass(progress) { if (progress == null || progress === 0) return "empty"; if (progress < 30) return "red"; if (progress < 60) return "yellow"; return "green"; }
function renderHeatmapView() { const { year, month, days } = monthHeatmapData(); const firstOffset = (new Date(year, month, 1).getDay() + 6) % 7; const cells = [...Array(firstOffset).fill(null), ...days]; return `<div class="section-heading"><div><div class="section-kicker">DAILY PROGRESS</div><h2>Task heatmap · ${year} / ${String(month + 1).padStart(2, "0")}</h2><p class="heatmap-description">Each square reads the saved daily weighted progress. Empty days stay out of the average.</p></div><div class="calendar-nav"><button class="secondary-button" id="heatPrev">‹ Month</button><button class="secondary-button" id="heatNext">Month ›</button></div></div><div class="heatmap-card"><div class="heatmap-weekdays">${DAY_NAMES_ZH.slice(1).concat(DAY_NAMES_ZH[0]).map((day) => `<span>${day}</span>`).join("")}</div><div class="heatmap-month-grid">${cells.map((cell) => cell ? `<button class="heat-cell ${heatClass(cell.progress)}" data-heat-date="${cell.iso}" data-heat-progress="${cell.progress == null ? "N/A" : `${cell.progress}%`}" aria-label="${cell.iso} ${cell.progress == null ? "no tasks" : `${cell.progress}%`}"><span>${cell.day}</span></button>` : `<span class="heat-cell blank" aria-hidden="true"></span>`).join("")}</div><div class="heatmap-legend"><span><i class="heat-swatch empty"></i>No tasks</span><span><i class="heat-swatch red"></i>0–30%</span><span><i class="heat-swatch yellow"></i>30–60%</span><span><i class="heat-swatch green"></i>60–100%</span></div><div class="heat-tooltip" id="heatTooltip" role="status"></div></div>`; }
function bindHeatmapView() { const card = $(".heatmap-card"); const tooltip = $("#heatTooltip"); if (!card || !tooltip) return; $$(`[data-heat-date]`).forEach((cell) => { cell.addEventListener("mouseenter", () => { tooltip.textContent = `${cell.dataset.heatDate} · ${cell.dataset.heatProgress}`; tooltip.classList.add("show"); }); cell.addEventListener("mousemove", (event) => { const rect = card.getBoundingClientRect(); tooltip.style.left = `${event.clientX - rect.left + 12}px`; tooltip.style.top = `${event.clientY - rect.top + 12}px`; }); cell.addEventListener("mouseleave", () => tooltip.classList.remove("show")); }); $("#heatPrev")?.addEventListener("click", () => { const date = parseDate(selectedDate); date.setMonth(date.getMonth() - 1); selectedDate = isoDate(date); render(); }); $("#heatNext")?.addEventListener("click", () => { const date = parseDate(selectedDate); date.setMonth(date.getMonth() + 1); selectedDate = isoDate(date); render(); }); }

function renderMonthView() {
  const date = parseDate(selectedDate); const year = date.getFullYear(); const month = date.getMonth(); const first = new Date(year, month, 1); const last = new Date(year, month + 1, 0); const start = first.getDay();
  const cells = []; for (let i = 0; i < start; i++) cells.push(`<div class="calendar-cell muted"></div>`); for (let i = 1; i <= last.getDate(); i++) { const d = new Date(year, month, i); const iso = isoDate(d); const hardTasks = tasksForDate(iso).filter((task) => task.difficulty === "hard"); const events = eventOccurrencesForDate(iso); cells.push(`<div class="calendar-cell ${iso === selectedDate ? "today" : ""}"><strong>${i}</strong>${events.slice(0, 2).map((event) => `<button class="calendar-event event" data-open-event="${event.id}">${escapeHtml(event.name || event.title)}</button>`).join("")}${hardTasks.slice(0, 2).map((task) => `<div class="calendar-event hard-event" style="--task-color:${taskColor(task)};--task-tint:${hexToRgba(taskColor(task))}">${escapeHtml(task.title)}</div>`).join("")}</div>`); }
  return `<div class="section-heading"><div><div class="section-kicker">MONTH VIEW</div><h2>${formatDate(`${year}-${String(month + 1).padStart(2, "0")}-01`, { month: "long", year: "numeric" })}</h2><div class="month-filter-note">Events and hard tasks only</div></div></div><div class="calendar-card"><div class="calendar-grid">${DAY_NAMES_ZH.map((day) => `<div class="calendar-day-name">${day}</div>`).join("")}${cells.join("")}</div></div>`;
}

function currentHabitStats() {
  const now = parseDate(selectedDate); const monday = new Date(now); const day = monday.getDay() || 7; monday.setDate(monday.getDate() - day + 1); const weekStart = isoDate(monday); const monthPrefix = selectedDate.slice(0, 7);
  return state.habits.map((habit) => { const dates = (habit.checkins || []).filter((date) => habit.cadence === "weekly" ? date >= weekStart && date <= isoDate(new Date(monday.getTime() + 6 * 86400000)) : date.startsWith(monthPrefix)); const count = dates.length; return { habit, dates, count, achieved: count >= habit.kpi }; });
}
function habitStreak(habit) { const dates = new Set(habit.checkins || []); let cursor = parseDate(todayIso()); let streak = 0; while (dates.has(isoDate(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); } return streak; }
function habitHeatmapMarkup(habit) { const end = parseDate(selectedDate); const endDay = end.getDay() || 7; end.setDate(end.getDate() + (7 - endDay)); const start = new Date(end); start.setDate(end.getDate() - 83); const checked = new Set(habit.checkins || []); const cells = Array.from({ length: 84 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const iso = isoDate(date); return `<span class="habit-heat-cell ${checked.has(iso) ? "checked" : ""} ${iso === todayIso() ? "today" : ""}" title="${iso} · ${checked.has(iso) ? "checked" : "not checked"}"></span>`; }).join(""); return `<div class="habit-heatmap"><div class="detail-label">Check-in history · last 12 weeks</div><div class="habit-heatmap-caption">Only the day you check in is recorded. Past days cannot be filled retroactively.</div><div class="habit-heatmap-grid">${cells}</div></div>`; }
function renderHabitsView() { const today = todayIso(); return `<div class="section-heading"><div><div class="section-kicker">HABIT BOARD</div><h2>Habits</h2></div><button class="primary-button" id="newHabitButton">+ New habit</button></div><div class="task-list">${currentHabitStats().map(({ habit, count, achieved }) => { const checkedToday = (habit.checkins || []).includes(today); return `<article class="task-card habit-card" data-open-habit="${habit.id}"><div class="task-card-top"><div><div class="task-card-title">${escapeHtml(habit.name)}</div><div class="task-card-meta">${habit.cadence === "weekly" ? "This week" : "This month"} · KPI ${habit.kpi} times · ${count} achieved · ${habitStreak(habit)} day streak</div></div><button class="habit-edit-button" data-open-habit="${habit.id}">Edit</button></div><div class="task-footer"><span>${checkedToday ? "Checked today" : "Not checked today"}</span><button data-check-habit="${habit.id}" ${checkedToday ? "disabled" : ""}>${checkedToday ? "Checked" : "Check in today"}</button></div></article>`; }).join("")}</div>`; }
function bindHabitButtons() { $$('[data-check-habit]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); checkHabit(button.dataset.checkHabit); })); $$('[data-open-habit]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openHabitDetail(button.dataset.openHabit); })); $("#newHabitButton")?.addEventListener("click", () => openHabitDetail()); }
let currentHabitId = null;
function openHabitDetail(habitId = null) { const habit = state.habits.find((item) => item.id === habitId); currentHabitId = habit?.id || null; const draft = habit || { name: "", cadence: "weekly", kpi: 3, checkins: [] }; const count = habit ? (currentHabitStats().find((item) => item.habit.id === habitId)?.count || 0) : 0; $("#habitDetailTitle").textContent = habit ? habit.name : "Add a habit"; $("#habitDetailContent").innerHTML = `<div class="detail-block"><div class="habit-form-grid"><label>Name<input id="editHabitName" value="${escapeHtml(draft.name)}" maxlength="60" placeholder="例如：锻炼、阅读" required /></label><label>Cadence<select id="editHabitCadence"><option value="weekly" ${draft.cadence === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${draft.cadence === "monthly" ? "selected" : ""}>Monthly</option></select></label><label>KPI times<input id="editHabitKpi" type="number" min="1" max="31" step="1" value="${draft.kpi}" required /></label></div>${habit ? `<div class="detail-help">Current period: ${count} / ${habit.kpi} achieved · ${habitStreak(habit)} day streak.</div>${habitHeatmapMarkup(habit)}` : `<div class="detail-help">KPI counts check-in days in the selected weekly or monthly period.</div>`}</div>`; $("#deleteHabitButton").hidden = !habit; $("#habitDetailModal").showModal(); }
function saveHabitChanges() { const name = $("#editHabitName").value.trim(); if (!name) { toast("Please give the habit a name."); return; } const cadence = $("#editHabitCadence").value; const kpi = Math.max(1, Number($("#editHabitKpi").value) || 1); state.habits ||= []; if (currentHabitId) { const habit = state.habits.find((item) => item.id === currentHabitId); if (!habit) return; habit.name = name; habit.cadence = cadence; habit.kpi = kpi; } else state.habits.push({ id: uid("habit"), name, cadence, kpi, checkins: [] }); saveState(); $("#habitDetailModal").close(); render(); toast(currentHabitId ? "Habit changes saved." : "Habit added."); currentHabitId = null; }
function deleteHabit() { if (!currentHabitId) return; const habit = state.habits.find((item) => item.id === currentHabitId); if (!habit) return; state.habits = state.habits.filter((item) => item.id !== currentHabitId); saveState(); $("#habitDetailModal").close(); currentHabitId = null; render(); toast("Habit deleted."); }

function placeholderText(view) { return { "message-board": { title: "A message board for Xiao Yu.", body: "The assistant entry point is reserved for a later iteration. The current build keeps the task page as the home base." }, reading: { title: "Reading and writing, later.", body: "The content library will have its own data window after the daily management core is stable." }, archive: { title: "A quiet archive for rewards.", body: "Reward triggers and collection records are intentionally left as a future module." }, inspiration: { title: "A box for ideas.", body: "The inspiration box will share the same durable foundation when its content model is ready." } }[view] || { title: "Coming later.", body: "This space is reserved for the next iteration." }; }

function courseOccurrencesForDate(date) { return state.courses.filter((course) => course.date === date); }
function overlaps(startA, endA, startB, endB) { if (!startA || !endA || !startB || !endB) return false; return startA < endB && startB < endA; }

function openTaskDetail(taskId, drawer = false) {
  const task = state.tasks.find((item) => item.id === taskId); if (!task) return;
  currentDetailTaskId = taskId;
  const progress = progressForTask(task);
  $("#detailTitle").textContent = task.title;
  const childBlock = ["regular", "long-term"].includes(task.type) ? `<div class="detail-block"><div class="detail-block-header"><div><div class="detail-label">Subtasks</div><div class="detail-help">${task.type === "regular" ? "Up to 3 same-level subtasks, each with a date." : "Each subtask contributes to the long-term count."}</div></div><button type="button" class="detail-inline-button" id="addSubtaskButton" ${task.type === "regular" && (task.children || []).length >= 3 ? "disabled" : ""}>+ Add subtask</button></div><div class="subtask-editor">${(task.children || []).map((child, index) => `<div class="subtask-row"><input data-child-index="${index}" data-child-field="title" value="${escapeHtml(child.title)}" aria-label="子任务名称" placeholder="Subtask title" /><input data-child-index="${index}" data-child-field="date" type="date" value="${child.date || task.scheduledDate || selectedDate}" aria-label="子任务日期" /><input data-child-index="${index}" data-child-field="progress" type="number" min="0" max="100" step="10" value="${child.progress || 0}" aria-label="子任务进度" /><div class="subtask-row-actions">${child.progress >= 100 && child.status !== "done" ? `<button type="button" class="detail-inline-button" data-confirm-child="${index}">Confirm</button>` : ""}<button type="button" class="icon-button" data-remove-child="${index}" aria-label="删除子任务">×</button></div></div>`).join("") || `<div class="detail-help">No subtasks yet.</div>`}</div></div>` : "";
  const progressEditor = `<label>${task.type === "regular" && task.children?.length ? "Parent progress override" : "Progress"}<input id="editProgress" type="number" min="0" max="100" step="10" value="${progress}" /></label>${task.type === "regular" && task.children?.length ? `<div class="detail-help">Leave this at the default child-count value to keep automatic progress.</div>` : ""}`;
  $("#detailContent").innerHTML = `<div class="detail-block"><div class="form-grid"><label>Title<input id="editTitle" value="${escapeHtml(task.title)}" maxlength="120" /></label><label>Type<div class="readonly-field">${TYPE_LABEL[task.type]}</div></label><label>Planned date<input id="editScheduledDate" type="date" value="${task.scheduledDate || selectedDate}" /></label><label>Deadline<input id="editDeadline" type="date" value="${task.deadline || ""}" /></label><label>Estimated hours<input id="editEstimateHours" type="number" min="0.25" step="0.25" value="${task.estimateHours || 1}" /></label><label>Difficulty<select id="editDifficulty"><option value="simple" ${task.difficulty === "simple" ? "selected" : ""}>Simple</option><option value="normal" ${task.difficulty === "normal" ? "selected" : ""}>Normal</option><option value="hard" ${task.difficulty === "hard" ? "selected" : ""}>Hard</option></select></label><label>Task color<select id="editTagColor">${tagColorOptions(taskColor(task))}</select></label><label>Start time<input id="editStartTime" type="time" value="${task.startTime || ""}" /></label><label>End time<input id="editEndTime" type="time" value="${task.endTime || ""}" /></label></div><label>Notes<textarea id="editNotes" rows="3">${escapeHtml(task.notes || "")}</textarea></label>${progressEditor}<div class="detail-progress">${energyMarkup(progress)}<div class="progress-number">${progress}%${progress === 100 ? " ^-^" : ""}</div></div></div>${childBlock}<div class="detail-actions"><button type="button" data-set-progress="${task.id}" data-progress="0">0%</button><button type="button" data-set-progress="${task.id}" data-progress="50">50%</button><button type="button" data-set-progress="${task.id}" data-progress="100">100%</button><button type="button" data-detail-timer="${task.id}" class="timer-button ${task.timerStartedAt ? "running" : ""}">${timerLabel(task)}</button></div>`;
  $("#confirmCompleteButton").style.display = progress >= 100 && task.status !== "done" ? "inline-block" : "none";
  $("#confirmCompleteButton").dataset.completeTask = task.id;
  $("#taskDetailModal").classList.toggle("drawer-mode", drawer);
  $("#taskDetailModal").showModal();
  $("#addSubtaskButton")?.addEventListener("click", () => addSubtask(task.id));
  $$(`[data-confirm-child]`).forEach((button) => button.addEventListener("click", () => confirmChild(task.id, Number(button.dataset.confirmChild))));
  $$(`[data-remove-child]`).forEach((button) => button.addEventListener("click", () => removeSubtask(task.id, Number(button.dataset.removeChild))));
  $$(`[data-set-progress]`).forEach((button) => button.addEventListener("click", () => setTaskProgress(button.dataset.setProgress, Number(button.dataset.progress))));
  $$(`[data-detail-timer]`).forEach((button) => button.addEventListener("click", () => toggleTimer(button.dataset.detailTimer)));
}

function tagColorOptions(selected) { const labels = { "#8EA1B5": "Dusty Blue · work / study", "#9CAF88": "Sage Green · life / health", "#C08A8A": "Dusty Rose · reading / hobby", "#CDBBA0": "Oatmeal · daily", "#A697B5": "Taro Purple · inspiration", "#D9A05B": "Muted Orange · urgent", "#86A3A3": "Teal · long-term", "#D8B4B4": "Pale Pink · personal" }; return TAG_COLORS.map((color) => `<option value="${color}" ${color === selected ? "selected" : ""}>${labels[color]}</option>`).join(""); }
function addSubtask(taskId) { const task = state.tasks.find((item) => item.id === taskId); if (!task || (task.type === "regular" && (task.children || []).length >= 3)) return; task.children ||= []; task.children.push({ id: uid("subtask"), title: "New subtask", date: task.scheduledDate || selectedDate, progress: 0, status: "not_started", estimateHours: 1 }); saveState(); render(); openTaskDetail(taskId); toast("Subtask added — edit its title and date before saving."); }
function removeSubtask(taskId, index) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; task.children.splice(index, 1); saveState(); render(); openTaskDetail(taskId); }
function openCompletionPrompt(taskId, childIndex = null) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; pendingCompletion = { taskId, childIndex }; const child = childIndex == null ? null : task.children?.[childIndex]; $("#completionMessage").textContent = child ? `“${child.title}” reached 100%. Confirm that this subtask is actually complete.` : `“${task.title}” reached 100%. Confirm that this task is actually complete.`; $("#completionModal").showModal(); }
function applyPendingCompletion() { if (!pendingCompletion) return; const task = state.tasks.find((item) => item.id === pendingCompletion.taskId); if (!task) return; if (pendingCompletion.childIndex == null) { task.status = "done"; task.progress = 100; } else { const child = task.children?.[pendingCompletion.childIndex]; if (!child) return; child.progress = 100; child.status = "done"; } pendingCompletion = null; saveState(); $("#completionModal").close(); if ($("#taskDetailModal").open) $("#taskDetailModal").close(); render(); toast("Completion confirmed."); }
function confirmChild(taskId, index) { const task = state.tasks.find((item) => item.id === taskId); const child = task?.children?.[index]; if (!child) return; child.progress = 100; child.status = "pending_confirmation"; saveState(); openCompletionPrompt(taskId, index); }
function saveTaskChanges() { const task = state.tasks.find((item) => item.id === currentDetailTaskId); if (!task) return; task.title = $("#editTitle").value.trim() || task.title; task.scheduledDate = $("#editScheduledDate").value; task.deadline = $("#editDeadline").value; task.estimateHours = Number($("#editEstimateHours").value) || 1; task.difficulty = $("#editDifficulty").value; task.tagColor = $("#editTagColor").value; task.startTime = $("#editStartTime").value; task.endTime = $("#editEndTime").value; task.notes = $("#editNotes").value.trim(); const enteredProgress = Math.max(0, Math.min(100, Number($("#editProgress")?.value ?? task.progress ?? 0))); if (task.type === "regular" && task.children?.length) { const derived = Math.round(task.children.filter((child) => child.status === "done").length / task.children.length * 100); if (enteredProgress === derived) delete task.progressOverride; else task.progressOverride = enteredProgress; task.progress = enteredProgress; } else task.progress = enteredProgress; task.status = enteredProgress >= 100 ? (task.status === "done" ? "done" : "pending_confirmation") : enteredProgress > 0 ? "in_progress" : "not_started"; let pendingChildIndex = null; task.children?.forEach((child, index) => { const title = document.querySelector(`[data-child-index="${index}"][data-child-field="title"]`); const date = document.querySelector(`[data-child-index="${index}"][data-child-field="date"]`); const progress = document.querySelector(`[data-child-index="${index}"][data-child-field="progress"]`); if (title) child.title = title.value.trim() || child.title; if (date) child.date = date.value || task.scheduledDate; if (progress) { child.progress = Number(progress.value) || 0; if (child.progress >= 100 && child.status !== "done") { child.status = "pending_confirmation"; if (pendingChildIndex == null) pendingChildIndex = index; } else if (child.progress > 0) child.status = "in_progress"; else child.status = "not_started"; } child.tagColor = task.tagColor; }); saveState(); $("#taskDetailModal").close(); render(); if (pendingChildIndex != null) openCompletionPrompt(task.id, pendingChildIndex); else if (task.status === "pending_confirmation") openCompletionPrompt(task.id); else toast("Task changes saved."); }

function setTaskProgress(taskId, progress) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; const wasOpen = $("#taskDetailModal").open; if (wasOpen) $("#taskDetailModal").close(); if (task.type === "regular" && task.children?.length) task.progressOverride = progress; task.progress = progress; task.status = progress >= 100 ? "pending_confirmation" : progress > 0 ? "in_progress" : "not_started"; saveState(); render(); if (progress >= 100) openCompletionPrompt(taskId); else { openTaskDetail(taskId, wasOpen); toast(`Progress updated to ${progress}%.`); } }
function elapsedLabel(task) { const minutes = Math.max(0, Math.floor((Date.now() - task.timerStartedAt) / 60000)); return `${String(Math.floor(minutes / 60)).padStart(2, "0")}h ${String(minutes % 60).padStart(2, "0")}m`; }
function timerLabel(task) { return task.timerStartedAt ? `Running · ${elapsedLabel(task)}` : "Start timer"; }
function toggleTimer(taskId) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; if (task.timerStartedAt) { task.actualMinutes = (task.actualMinutes || 0) + Math.max(1, Math.round((Date.now() - task.timerStartedAt) / 60000)); delete task.timerStartedAt; toast("Timer paused · tracked time saved."); } else { task.timerStartedAt = Date.now(); task.status = task.status === "not_started" ? "in_progress" : task.status; toast("Timer started · this task is now running."); } saveState(); render(); }
function checkHabit(habitId) { const habit = state.habits.find((item) => item.id === habitId); if (!habit) return; habit.checkins ||= []; const today = todayIso(); if (habit.checkins.includes(today)) return; habit.checkins.push(today); saveState(); render(); toast(`${habit.name} checked in for today.`); }

function openTaskModal() { const form = $("#taskForm"); form.reset(); form.elements.scheduledDate.value = selectedDate; $("#taskModal").showModal(); }
function createTask(event) { event.preventDefault(); const form = event.currentTarget; if (event.submitter?.value === "cancel") { form.reset(); $("#taskModal").close(); return; } const data = new FormData(form); const type = data.get("type"); const task = { id: uid("task"), type, title: data.get("title").trim(), notes: data.get("notes").trim(), scheduledDate: data.get("scheduledDate"), deadline: data.get("deadline"), estimateHours: Number(data.get("estimateHours")), difficulty: data.get("difficulty"), progress: 0, status: "not_started", actualMinutes: 0, startTime: data.get("startTime"), endTime: data.get("endTime"), children: [], tagColor: data.get("tagColor") || DEFAULT_TAG_COLOR[type], createdAt: new Date().toISOString() }; state.tasks.push(task); saveState(); form.reset(); $("#taskModal").close(); selectedDate = task.scheduledDate; currentTab = "today"; render(); toast("Task created."); }

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
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), 2500); }

$("#newTaskButton").addEventListener("click", openTaskModal);
$("#newEventButton").addEventListener("click", () => openEventDetail());
$("#taskForm").addEventListener("submit", createTask);
$("#eventForm").addEventListener("submit", saveEventForm);
$("#deleteEventButton").addEventListener("click", deleteEvent);
$("#importCourseButton").addEventListener("click", () => $("#courseFileInput").click());
$("#courseFileInput").addEventListener("change", (event) => { if (event.target.files[0]) importCourseFile(event.target.files[0]); event.target.value = ""; });
$("#confirmImportButton").addEventListener("click", (event) => { event.preventDefault(); commitCourseImport(); });
$("#saveTaskButton").addEventListener("click", saveTaskChanges);
$("#taskDetailModal").addEventListener("close", () => { $("#taskDetailModal").classList.remove("drawer-mode"); });
$("#confirmCompletionButton").addEventListener("click", (event) => { event.preventDefault(); applyPendingCompletion(); });
$("#completionModal").addEventListener("close", () => { if ($("#completionModal").returnValue === "cancel") pendingCompletion = null; });
$("#saveHabitButton").addEventListener("click", (event) => { event.preventDefault(); saveHabitChanges(); });
$("#deleteHabitButton").addEventListener("click", deleteHabit);
$("#confirmCompleteButton").addEventListener("click", (event) => { event.preventDefault(); const task = state.tasks.find((item) => item.id === event.currentTarget.dataset.completeTask); if (task) { task.status = "done"; task.progress = 100; saveState(); $("#taskDetailModal").close(); render(); toast("Task marked completed."); } });
$("#previousDay").addEventListener("click", () => { const date = parseDate(selectedDate); date.setDate(date.getDate() - 1); selectedDate = isoDate(date); render(); });
$("#nextDay").addEventListener("click", () => { const date = parseDate(selectedDate); date.setDate(date.getDate() + 1); selectedDate = isoDate(date); render(); });
$("#jumpToday").addEventListener("click", () => { selectedDate = todayIso(); render(); });
$("#showIncomplete").addEventListener("click", () => { const incomplete = state.tasks.filter((task) => task.status !== "done" && task.type !== "long-term"); toast(`${incomplete.length} incomplete task${incomplete.length === 1 ? "" : "s"} across your workspace.`); });
$("#exportData").addEventListener("click", exportData);
$("#menuTrigger").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").classList.add("open"); });
$("#sidebarClose").addEventListener("click", closeSidebar); $("#scrim").addEventListener("click", closeSidebar);
$("#insightClose").addEventListener("click", () => $("#insightColumn").classList.remove("open"));
$("#insightTrigger").addEventListener("click", () => $("#insightColumn").classList.add("open"));
$$('.nav-item').forEach((item) => item.addEventListener("click", () => { currentView = item.dataset.view; currentTab = currentView === "assignment" ? "board" : "today"; $$(".nav-item").forEach((nav) => nav.classList.toggle("active", nav === item)); if (currentView === "assignment") { $("#pageTitle").textContent = "Assignment and goal"; } else { $("#pageTitle").textContent = placeholderText(currentView).title; } resetPageScroll(); render(); closeSidebar(); }));
$$('.view-tab').forEach((tab) => tab.addEventListener("click", () => { currentTab = tab.dataset.tab; resetPageScroll(); renderActiveTab(); }));
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSidebar(); });
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("open"); }
function resetPageScroll() { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; $(".main-column")?.scrollTo({ top: 0, left: 0, behavior: "auto" }); }

render();
