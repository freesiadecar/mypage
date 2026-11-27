const STORAGE_KEY = "mypage.workspace.v1";
// shortcut: data stays in this browser; add a backend when cross-device sync is needed.
let storageAvailable = true;
let toastTimer;
let gameQuery = "";
let gameStatusFilter = "all";

function emptyData() {
  return { projects: [], tasks: [], games: [] };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.games)) throw new Error("Invalid local data");
    return value;
  } catch {
    storageAvailable = false;
    return emptyData();
  }
}

let data = loadData();
const app = document.querySelector("#app");
const dialog = document.querySelector("#entry-dialog");
const toast = document.querySelector("#toast");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function saveData(message = "已保存到本机") {
  if (!storageAvailable) {
    showToast("本地数据无法读取，当前操作没有覆盖原数据。");
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    showToast(message);
    return true;
  } catch {
    showToast("保存失败，浏览器可能没有可用的本地存储空间。");
    return false;
  }
}

function escapeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#5c6ce8";
}

function formatDate(value) {
  if (!value) return "未设截止";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "未设截止" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function localDateString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function percent(project) {
  const tasks = data.tasks.filter((task) => task.projectId === project.id);
  return tasks.length ? Math.round(tasks.filter((task) => task.done).length / tasks.length * 100) : 0;
}

function projectProgressText(project) {
  const tasks = data.tasks.filter((task) => task.projectId === project.id);
  return `${tasks.filter((task) => task.done).length}/${tasks.length} 项已完成`;
}

function updateShell(page) {
  const labels = { home: "首页", overview: "工作项目", projects: "我的项目", tasks: "所有任务", games: "游戏资料库", project: "项目详情" };
  const active = page === "project" ? "projects" : page;
  document.querySelectorAll("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === active));
  document.querySelector("#breadcrumb-title").textContent = labels[page] ?? "总览";
  document.querySelector("#nav-task-count").textContent = data.tasks.filter((task) => !task.done).length;
  document.querySelector("#save-label").textContent = storageAvailable ? "本机保存" : "存储不可用";
  document.title = `${labels[page] ?? "总览"} · 我的工作台`;
}

function heading(eyebrow, title, description, actions = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function emptyState(title, description, action, label) {
  return `<div class="empty-state"><div><span class="empty-icon" aria-hidden="true">${escapeHtml(action === "create-game" ? "▤" : action === "create-task" ? "✓" : "＋")}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p>${action ? `<button class="button primary" type="button" data-action="${escapeHtml(action)}"><span class="icon-plus" aria-hidden="true">＋</span>${escapeHtml(label)}</button>` : ""}</div></div>`;
}

function projectCard(project) {
  const progress = percent(project);
  const color = escapeColor(project.color);
  return `<article class="project-card">
    <div class="project-card-top"><span class="project-avatar" style="background:${color}">${escapeHtml((project.name || "项").slice(0, 1))}</span><div class="card-actions"><button class="button small" type="button" data-action="edit-project" data-id="${escapeHtml(project.id)}">编辑</button><button class="button small danger" type="button" data-action="delete-project" data-id="${escapeHtml(project.id)}" aria-label="删除 ${escapeHtml(project.name)}">删除</button></div></div>
    <a class="project-title" href="#/project/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a>
    <p class="project-description">${escapeHtml(project.description || "暂无项目说明")}</p>
    <div class="progress-row"><span>项目进度</span><strong>${progress}%</strong></div><div class="progress-track" aria-label="项目进度 ${progress}%"><div class="progress-fill" style="width:${progress}%;background:${color}"></div></div>
    <div class="project-meta"><span>${escapeHtml(projectProgressText(project))}</span><span>截止 <b>${escapeHtml(formatDate(project.due))}</b></span></div>
  </article>`;
}

function taskRow(task) {
  const project = data.projects.find((item) => item.id === task.projectId);
  const priority = { 高: "高优先级", 中: "中优先级", 低: "低优先级" }[task.priority] ?? "中优先级";
  return `<article class="task-row ${task.done ? "is-done" : ""}">
    <input class="task-check" type="checkbox" data-action="toggle-task" data-id="${escapeHtml(task.id)}" aria-label="${task.done ? "标记未完成" : "标记完成"}: ${escapeHtml(task.title)}" ${task.done ? "checked" : ""}>
    <div class="task-main"><p class="task-title">${escapeHtml(task.title)}</p>${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ""}<div class="task-meta"><span>${escapeHtml(project?.name ?? "未关联项目")}</span><span>${escapeHtml(formatDate(task.due))}</span><span class="priority">${escapeHtml(priority)}</span></div></div>
    <div class="card-actions"><button class="button small" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}">编辑</button><button class="button small danger" type="button" data-action="delete-task" data-id="${escapeHtml(task.id)}" aria-label="删除任务 ${escapeHtml(task.title)}">删除</button></div>
  </article>`;
}

function gameStatusLabel(status) {
  return ({ planned: "想玩", playing: "在玩", completed: "已通关", paused: "暂放" })[status] ?? "想玩";
}

function gameCard(game) {
  const status = ["planned", "playing", "completed", "paused"].includes(game.status) ? game.status : "planned";
  const rating = Number(game.rating);
  return `<article class="game-card">
    <div class="game-card-top"><span class="game-cover" aria-hidden="true">${escapeHtml((game.title || "游").slice(0, 1))}</span><span class="game-status ${status}">${gameStatusLabel(status)}</span></div>
    <h2 class="game-name">${escapeHtml(game.title)}</h2>
    <div class="game-tags">${game.platform ? `<span class="game-tag">${escapeHtml(game.platform)}</span>` : ""}${game.genre ? `<span class="game-tag">${escapeHtml(game.genre)}</span>` : ""}</div>
    <p class="game-notes">${escapeHtml(game.notes || "还没有添加游戏笔记。")}</p>
    <div class="game-footer"><span class="game-rating">${rating > 0 ? `评分 ${escapeHtml(rating)}/10` : "暂无评分"}</span><div class="card-actions"><button class="button small" type="button" data-action="edit-game" data-id="${escapeHtml(game.id)}">编辑</button><button class="button small danger" type="button" data-action="delete-game" data-id="${escapeHtml(game.id)}" aria-label="删除游戏 ${escapeHtml(game.title)}">删除</button></div></div>
  </article>`;
}

function renderOverview() {
  const openTasks = data.tasks.filter((task) => !task.done);
  const doneTasks = data.tasks.filter((task) => task.done);
  const today = localDateString();
  const attention = openTasks.filter((task) => task.due && task.due <= today);
  const activeProjects = data.projects.filter((project) => data.tasks.some((task) => task.projectId === project.id && !task.done) || !data.tasks.some((task) => task.projectId === project.id));
  const actions = `<button class="button" type="button" data-action="create-project"><span class="icon-plus" aria-hidden="true">＋</span>新建项目</button><button class="button primary" type="button" data-action="create-task"><span class="icon-plus" aria-hidden="true">＋</span>添加任务</button>`;
  const cards = data.projects.slice(0, 3).map(projectCard).join("");
  return `${heading("YOUR WORKSPACE ✦", "把计划，变成进展。", "欢迎回来。这是你今天工作的全景。", actions)}
    <section class="stat-grid" aria-label="工作概况">
      <article class="stat-card"><div class="stat-top"><span>进行中的项目</span><span class="stat-icon" aria-hidden="true">▱</span></div><div class="stat-value">${activeProjects.length}<small>个项目</small></div><div class="stat-foot">你的项目进度总览</div></article>
      <article class="stat-card"><div class="stat-top"><span>待完成任务</span><span class="stat-icon" aria-hidden="true">◯</span></div><div class="stat-value">${openTasks.length}<small>项任务</small></div><div class="stat-foot">一步一步向前</div></article>
      <article class="stat-card"><div class="stat-top"><span>已完成任务</span><span class="stat-icon" aria-hidden="true">✓</span></div><div class="stat-value">${doneTasks.length}<small>项任务</small></div><div class="stat-foot">每一步都值得记录</div></article>
      <article class="stat-card attention"><div class="stat-top"><span>需要关注</span><span class="stat-icon" aria-hidden="true">◷</span></div><div class="stat-value">${attention.length}<small>项任务</small></div><div class="stat-foot">已到期且尚未完成</div></article>
    </section>
    <section><div class="section-heading"><div><h2>项目概览</h2><p>从全局了解每个项目的进展。</p></div><a class="text-link" href="#/projects">查看全部项目</a></div>
      ${cards ? `<div class="project-grid">${cards}</div>` : emptyState("先创建一个项目", "记录目标、截止日期和任务进度。", "create-project", "新建项目")}
    </section>`;
}

function renderHome() {
  const openTasks = data.tasks.filter((task) => !task.done).length;
  return `${heading("MY PAGE", "你的工具，从这里开始。", "选择一个空间，继续管理工作项目或整理游戏资料。")}
    <section class="home-grid" aria-label="工具入口">
      <a class="home-card work-home" href="#/overview">
        <span class="home-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="17" height="13" rx="2.5"></rect><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3.5 12h17M10 12v2h4v-2"></path></svg></span>
        <span class="home-card-kicker">PROJECT WORKSPACE</span><strong>工作项目</strong><span class="home-card-description">查看项目进度、跟进任务，并整理会议记录。</span><span class="home-card-meta">${data.projects.length} 个项目 · ${openTasks} 项待办</span>
      </a>
      <a class="home-card game-home" href="#/games">
        <span class="home-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h10A3.5 3.5 0 0 1 18.5 8v11H8A3 3 0 0 1 5 16z"></path><path d="M5 16a2.5 2.5 0 0 1 2.5-2.5h11M9 8h6M9 10.5h4"></path></svg></span>
        <span class="home-card-kicker">GAME LIBRARY</span><strong>游戏资料库</strong><span class="home-card-description">整理游戏平台、游戏类型、游玩状态和个人笔记。</span><span class="home-card-meta">${data.games.length} 款游戏</span>
      </a>
    </section>`;
}

function renderProjects() {
  const actions = `<button class="button primary" type="button" data-action="create-project"><span class="icon-plus" aria-hidden="true">＋</span>新建项目</button>`;
  return `${heading("WORKSPACE", "我的项目", "集中管理项目目标、进度和任务。", actions)}
    ${data.projects.length ? `<div class="project-grid">${data.projects.map(projectCard).join("")}</div>` : emptyState("还没有项目", "创建一个项目后，可以在里面安排任务和记录会议。", "create-project", "新建项目")}`;
}

function renderTasks() {
  const actions = `<button class="button primary" type="button" data-action="create-task"><span class="icon-plus" aria-hidden="true">＋</span>添加任务</button>`;
  const tasks = [...data.tasks].sort((a, b) => Number(a.done) - Number(b.done) || (a.due || "9999").localeCompare(b.due || "9999"));
  return `${heading("WORKSPACE", "所有任务", "跟进每件待办，也回顾已经完成的工作。", actions)}
    ${tasks.length ? `<div class="task-list">${tasks.map(taskRow).join("")}</div>` : emptyState("还没有任务", "为项目添加任务后，会在这里集中显示。", "create-task", "添加任务")}`;
}

function renderProjectDetail(projectId) {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) return `${heading("WORKSPACE", "找不到这个项目", "它可能已被删除或当前浏览器还没有这份数据。", `<a class="button" href="#/projects">返回项目列表</a>`)}${emptyState("没有项目内容", "返回项目列表继续管理。", null, "")}`;
  const tasks = data.tasks.filter((task) => task.projectId === project.id);
  const meetings = Array.isArray(project.meetings) ? project.meetings : [];
  const progress = percent(project);
  const actions = `<button class="button" type="button" data-action="edit-project" data-id="${escapeHtml(project.id)}">编辑项目</button><button class="button primary" type="button" data-action="create-task" data-project-id="${escapeHtml(project.id)}"><span class="icon-plus" aria-hidden="true">＋</span>添加任务</button>`;
  const taskContent = tasks.length ? `<div class="task-list">${tasks.map(taskRow).join("")}</div>` : emptyState("还没有任务", "为这个项目添加第一项任务。", "create-task", "添加任务");
  const meetingContent = meetings.length ? meetings.map((meeting) => `<article class="meeting-card"><div class="meeting-title"><span>${escapeHtml(meeting.title)}</span><span class="meeting-date">${escapeHtml(formatDate(meeting.date))}</span></div>${meeting.notes ? `<p class="meeting-notes">${escapeHtml(meeting.notes)}</p>` : ""}${meeting.nextSteps ? `<p class="meeting-next"><strong>下一步：</strong>${escapeHtml(meeting.nextSteps)}</p>` : ""}<div class="card-actions"><button class="button small" type="button" data-action="edit-meeting" data-project-id="${escapeHtml(project.id)}" data-id="${escapeHtml(meeting.id)}">编辑</button><button class="button small danger" type="button" data-action="delete-meeting" data-project-id="${escapeHtml(project.id)}" data-id="${escapeHtml(meeting.id)}">删除</button></div></article>`).join("") : `<p class="task-description">还没有会议记录。</p>`;
  return `${heading("PROJECT", project.name, project.description || "暂无项目说明。", actions)}
    <div class="detail-grid"><section class="detail-panel"><div class="section-heading"><div><h2>项目任务</h2><p>${escapeHtml(projectProgressText(project))}</p></div></div>${taskContent}</section>
    <section class="detail-panel"><div class="section-heading"><div><h2>会议记录</h2><p>整理讨论内容和后续行动。</p></div><button class="button small" type="button" data-action="create-meeting" data-project-id="${escapeHtml(project.id)}">新增记录</button></div>${meetingContent}<div class="progress-row"><span>项目进度</span><strong>${progress}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%;background:${escapeColor(project.color)}"></div></div></section></div>`;
}

function drawGames() {
  const list = document.querySelector("#game-results");
  const count = document.querySelector("#game-count");
  if (!list || !count) return;
  const query = gameQuery.trim().toLocaleLowerCase();
  const filtered = data.games.filter((game) => {
    const matchesQuery = [game.title, game.platform, game.genre, game.notes].some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
    return matchesQuery && (gameStatusFilter === "all" || game.status === gameStatusFilter);
  });
  count.textContent = `${filtered.length} 款游戏`;
  list.innerHTML = filtered.length ? filtered.map(gameCard).join("") : emptyState(query || gameStatusFilter !== "all" ? "没有匹配的游戏" : "资料库还是空的", query || gameStatusFilter !== "all" ? "试试修改搜索内容或筛选条件。" : "添加游戏后，可以记录平台、类型、游玩状态和攻略笔记。", query || gameStatusFilter !== "all" ? null : "create-game", "添加游戏");
}

function renderGames() {
  const playing = data.games.filter((game) => game.status === "playing").length;
  const completed = data.games.filter((game) => game.status === "completed").length;
  return `${heading("GAME LIBRARY", "游戏资料库", "收集游戏信息、游玩状态和自己的笔记。", `<button class="button primary" type="button" data-action="create-game"><span class="icon-plus" aria-hidden="true">＋</span>添加游戏</button>`)}
    <section class="stat-grid game-stats"><article class="stat-card"><div class="stat-top"><span>全部游戏</span><span class="stat-icon" aria-hidden="true">▤</span></div><div class="stat-value">${data.games.length}<small>款游戏</small></div><div class="stat-foot">你的个人资料库</div></article><article class="stat-card"><div class="stat-top"><span>正在游玩</span><span class="stat-icon" aria-hidden="true">◉</span></div><div class="stat-value">${playing}<small>款游戏</small></div><div class="stat-foot">继续当前旅程</div></article><article class="stat-card"><div class="stat-top"><span>已经通关</span><span class="stat-icon" aria-hidden="true">✓</span></div><div class="stat-value">${completed}<small>款游戏</small></div><div class="stat-foot">值得回味的冒险</div></article><article class="stat-card attention"><div class="stat-top"><span>本机保存</span><span class="stat-icon" aria-hidden="true">⌂</span></div><div class="stat-value">${storageAvailable ? "是" : "否"}<small>仅当前浏览器</small></div><div class="stat-foot">不会上传到服务器</div></article></section>
    <section><div class="section-heading"><div><h2>我的游戏</h2><p>按名称、平台或笔记搜索。</p></div><span class="game-count" id="game-count"></span></div>
    <div class="filter-bar"><label class="search-wrap"><span class="sr-only">搜索游戏</span><input class="search-input" id="game-search" type="search" placeholder="搜索游戏、平台、类型或笔记" value="${escapeHtml(gameQuery)}"></label><label><span class="sr-only">按游玩状态筛选</span><select class="filter-select" id="game-status-filter"><option value="all" ${gameStatusFilter === "all" ? "selected" : ""}>所有状态</option><option value="planned" ${gameStatusFilter === "planned" ? "selected" : ""}>想玩</option><option value="playing" ${gameStatusFilter === "playing" ? "selected" : ""}>在玩</option><option value="completed" ${gameStatusFilter === "completed" ? "selected" : ""}>已通关</option><option value="paused" ${gameStatusFilter === "paused" ? "selected" : ""}>暂放</option></select></label></div>
    <div class="game-grid" id="game-results"></div></section>`;
}

function render() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const page = ["home", "overview", "projects", "tasks", "games", "project"].includes(parts[0]) ? parts[0] : "home";
  updateShell(page);
  if (page === "home") app.innerHTML = renderHome();
  else if (page === "overview") app.innerHTML = renderOverview();
  else if (page === "projects") app.innerHTML = renderProjects();
  else if (page === "tasks") app.innerHTML = renderTasks();
  else if (page === "games") app.innerHTML = renderGames();
  else app.innerHTML = renderProjectDetail(decodeURIComponent(parts[1] ?? ""));
  if (page === "games") drawGames();
}

function field(label, name, value = "", options = {}) {
  const idValue = `field-${name}`;
  const required = options.required ? "required" : "";
  const full = options.full ? " full" : "";
  let control;
  if (options.type === "select") {
    control = `<select id="${idValue}" name="${name}" ${required}>${options.choices.map(([key, title]) => `<option value="${escapeHtml(key)}" ${value === key ? "selected" : ""}>${escapeHtml(title)}</option>`).join("")}</select>`;
  } else if (options.type === "textarea") {
    control = `<textarea id="${idValue}" name="${name}" ${required} ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""}>${escapeHtml(value)}</textarea>`;
  } else {
    const type = options.type ?? "text";
    control = `<input id="${idValue}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required} ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.max !== undefined ? `max="${options.max}"` : ""} ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""}>`;
  }
  return `<div class="form-field${full}"><label for="${idValue}">${escapeHtml(label)}${options.required ? " *" : ""}</label>${control}</div>`;
}

function openForm(kind, recordId = "", parentId = "") {
  const records = { project: data.projects, task: data.tasks, game: data.games };
  const existing = records[kind]?.find((record) => record.id === recordId);
  if (kind === "task" && !data.projects.length) {
    showToast("请先创建项目，再添加关联任务。");
    return;
  }
  let title = "", fields = "";
  if (kind === "project") {
    title = existing ? "编辑项目" : "新建项目";
    fields = `${field("项目名称", "name", existing?.name, { required: true, full: true, placeholder: "例如：产品改版"})}${field("项目说明", "description", existing?.description, { type: "textarea", full: true, placeholder: "写下项目目标或背景"})}${field("截止日期", "due", existing?.due, { type: "date"})}${field("项目颜色", "color", escapeColor(existing?.color), { type: "color"})}`;
  } else if (kind === "task") {
    title = existing ? "编辑任务" : "添加任务";
    const selected = existing?.projectId ?? parentId;
    const choices = data.projects.map((project) => [project.id, project.name]);
    fields = `${field("任务名称", "title", existing?.title, { required: true, full: true, placeholder: "写下要完成的事情"})}${field("所属项目", "projectId", selected, { type: "select", choices, required: true })}${field("截止日期", "due", existing?.due, { type: "date"})}${field("优先级", "priority", existing?.priority ?? "中", { type: "select", choices: [["高", "高"], ["中", "中"], ["低", "低"]]})}${field("任务说明", "description", existing?.description, { type: "textarea", full: true})}`;
  } else if (kind === "game") {
    title = existing ? "编辑游戏资料" : "添加游戏";
    fields = `${field("游戏名称", "title", existing?.title, { required: true, full: true, placeholder: "输入游戏名称"})}${field("游戏平台", "platform", existing?.platform, { placeholder: "例如：PC、Switch"})}${field("游戏类型", "genre", existing?.genre, { placeholder: "例如：动作、策略"})}${field("游玩状态", "status", existing?.status ?? "planned", { type: "select", choices: [["planned", "想玩"], ["playing", "在玩"], ["completed", "已通关"], ["paused", "暂放"]]})}${field("个人评分（1–10）", "rating", existing?.rating ?? "", { type: "number", min: 1, max: 10, placeholder: "可不填"})}${field("资料与笔记", "notes", existing?.notes, { type: "textarea", full: true, placeholder: "记录世界观、角色、攻略或自己的游玩感受"})}`;
  } else if (kind === "meeting") {
    const project = data.projects.find((item) => item.id === parentId);
    const meeting = project?.meetings?.find((item) => item.id === recordId);
    title = meeting ? "编辑会议记录" : "新增会议记录";
    fields = `${field("会议主题", "title", meeting?.title, { required: true, full: true, placeholder: "会议主题"})}${field("会议日期", "date", meeting?.date, { type: "date"})}${field("讨论记录", "notes", meeting?.notes, { type: "textarea", full: true})}${field("后续行动", "nextSteps", meeting?.nextSteps, { type: "textarea", full: true})}`;
  }
  dialog.innerHTML = `<form class="dialog-form" id="entry-form"><div class="dialog-header"><div><h2 id="dialog-title">${escapeHtml(title)}</h2><p>内容会保存在当前浏览器中。</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></div><div class="form-grid">${fields}</div><div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">保存</button></div></form>`;
  dialog.showModal();
  dialog.querySelector("#entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (kind === "project") {
      const values = { name: String(form.get("name")).trim(), description: String(form.get("description") ?? "").trim(), due: String(form.get("due") ?? ""), color: String(form.get("color") ?? "#5c6ce8") };
      if (existing) Object.assign(existing, values);
      else data.projects.push({ id: id(), ...values, meetings: [] });
    } else if (kind === "task") {
      const values = { title: String(form.get("title")).trim(), projectId: String(form.get("projectId")), due: String(form.get("due") ?? ""), priority: String(form.get("priority") ?? "中"), description: String(form.get("description") ?? "").trim() };
      if (existing) Object.assign(existing, values);
      else data.tasks.push({ id: id(), ...values, done: false });
    } else if (kind === "game") {
      const ratingValue = String(form.get("rating") ?? "").trim();
      const rating = ratingValue ? Number(ratingValue) : "";
      const values = { title: String(form.get("title")).trim(), platform: String(form.get("platform") ?? "").trim(), genre: String(form.get("genre") ?? "").trim(), status: String(form.get("status") ?? "planned"), rating: Number.isFinite(rating) ? Math.min(10, Math.max(1, rating)) : "", notes: String(form.get("notes") ?? "").trim() };
      if (existing) Object.assign(existing, values);
      else data.games.push({ id: id(), ...values });
    } else if (kind === "meeting") {
      const project = data.projects.find((item) => item.id === parentId);
      if (!project) return;
      project.meetings = Array.isArray(project.meetings) ? project.meetings : [];
      const meeting = project.meetings.find((item) => item.id === recordId);
      const values = { title: String(form.get("title")).trim(), date: String(form.get("date") ?? ""), notes: String(form.get("notes") ?? "").trim(), nextSteps: String(form.get("nextSteps") ?? "").trim() };
      if (meeting) Object.assign(meeting, values);
      else project.meetings.push({ id: id(), ...values });
    }
    saveData();
    dialog.close();
    render();
  });
}

function removeRecord(action, recordId, parentId = "") {
  const returnToProjects = action === "delete-project" && location.hash === `#/project/${encodeURIComponent(recordId)}`;
  if (action === "delete-project") {
    const project = data.projects.find((item) => item.id === recordId);
    if (!project || !confirm(`删除“${project.name}”及其任务和会议记录？`)) return;
    data.projects = data.projects.filter((item) => item.id !== recordId);
    data.tasks = data.tasks.filter((item) => item.projectId !== recordId);
  } else if (action === "delete-task") {
    data.tasks = data.tasks.filter((item) => item.id !== recordId);
  } else if (action === "delete-game") {
    const game = data.games.find((item) => item.id === recordId);
    if (!game || !confirm(`删除游戏“${game.title}”？`)) return;
    data.games = data.games.filter((item) => item.id !== recordId);
  } else if (action === "delete-meeting") {
    const project = data.projects.find((item) => item.id === parentId);
    if (project) project.meetings = (project.meetings ?? []).filter((item) => item.id !== recordId);
  }
  saveData("已删除");
  if (returnToProjects) location.hash = "#/projects";
  else render();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id: recordId = "", projectId = "" } = button.dataset;
  if (action === "create-project") openForm("project");
  else if (action === "edit-project") openForm("project", recordId);
  else if (action === "create-task") {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    openForm("task", "", projectId || (parts[0] === "project" ? decodeURIComponent(parts[1] ?? "") : ""));
  }
  else if (action === "edit-task") openForm("task", recordId);
  else if (action === "create-game") openForm("game");
  else if (action === "edit-game") openForm("game", recordId);
  else if (action === "create-meeting") openForm("meeting", "", projectId);
  else if (action === "edit-meeting") openForm("meeting", recordId, projectId);
  else if (action.startsWith("delete-")) removeRecord(action, recordId, projectId);
  else if (action === "close-dialog") dialog.close();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches('[data-action="toggle-task"]')) {
    const task = data.tasks.find((item) => item.id === target.dataset.id);
    if (task) {
      task.done = target.checked;
      saveData();
      render();
    }
  } else if (target.id === "game-status-filter") {
    gameStatusFilter = target.value;
    drawGames();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "game-search") {
    const cursor = event.target.selectionStart;
    gameQuery = event.target.value;
    drawGames();
    const search = document.querySelector("#game-search");
    search?.focus();
    search?.setSelectionRange(cursor, cursor);
  }
});

window.addEventListener("hashchange", render);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dialog.open) dialog.close();
});

if (!storageAvailable) showToast("读取本机数据失败；为避免覆盖，当前不会写入新数据。");
render();
