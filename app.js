const LEGACY_STORAGE_KEY = "mypage.workspace.v1";
const WORKSPACE_TABLE = "mypage_workspaces";
const SUPABASE_CONFIG = window.MYPAGE_SUPABASE_CONFIG ?? {};
const supabaseClient = window.supabase?.createClient && SUPABASE_CONFIG.url && SUPABASE_CONFIG.publishableKey
  ? window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey)
  : null;
let toastTimer;
let gameQuery = "";
let gameStatusFilter = "all";
let articleQuery = "";
let articleCategory = "all";
let articleStatus = "all";
let articleFavoritesOnly = false;
let currentUser = null;
let cloudReady = false;
let loadingUserId = null;
let authRun = 0;
let saveQueue = Promise.resolve();

function emptyData() {
  return {
    projects: [], tasks: [], games: [], articles: [], articleTrash: [], articleCategories: [
      ["world", "世界观"], ["character", "角色档案"], ["place", "地点与地图"], ["faction", "组织与势力"],
      ["item", "物品"], ["equipment", "装备"], ["story", "剧情与任务"], ["system", "玩法设计"],
      ["tech", "技术开发"], ["inspiration", "灵感与参考"]
    ].map(([id, name]) => ({ id, name })), articleSettings: {}
  };
}

function normalizeArticle(article, deleted = false) {
  if (!article || typeof article !== "object") return null;
  const title = String(article.title ?? "").trim();
  if (!title) return null;
  return {
    id: String(article.id || id()),
    title,
    category: String(article.category ?? "inspiration"),
    status: String(article.status ?? "草稿"),
    summary: String(article.summary ?? ""),
    content: String(article.content ?? ""),
    tags: Array.isArray(article.tags) ? article.tags.map(String) : [],
    relations: Array.isArray(article.relations) ? article.relations.map(String) : [],
    favorite: Boolean(article.favorite),
    example: Boolean(article.example),
    year: String(article.year ?? ""),
    createdAt: String(article.createdAt ?? ""),
    updatedAt: String(article.updatedAt ?? ""),
    ...(deleted ? { deletedAt: String(article.deletedAt ?? "") } : {})
  };
}

function normalizeWorkspace(value) {
  if (typeof value === "string") value = JSON.parse(value);
  if (value?.data !== undefined) value = typeof value.data === "string" ? JSON.parse(value.data) : value.data;
  if (value?.format === "jieshu-site-json-export") {
    if (!Array.isArray(value.entries) || !Array.isArray(value.trash)) throw new Error("界书导出文件缺少 entries 或 trash 数据。");
    const defaults = emptyData();
    return {
      ...defaults,
      articles: value.entries.map((article) => normalizeArticle(article)).filter(Boolean),
      articleTrash: value.trash.map((article) => normalizeArticle(article, true)).filter(Boolean),
      articleCategories: Array.isArray(value.structure?.categories) ? value.structure.categories.filter((category) => category?.id && category?.name).map((category) => ({
        id: String(category.id), name: String(category.name), description: String(category.description ?? ""),
        icon: String(category.icon ?? ""), color: String(category.color ?? ""), template: String(category.template ?? "")
      })) : defaults.articleCategories,
      articleSettings: value.settings && typeof value.settings === "object" ? {
        projectName: String(value.settings.projectName ?? ""), subtitle: String(value.settings.subtitle ?? ""), note: String(value.settings.note ?? "")
      } : {}
    };
  }
  if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tasks)) throw new Error("数据文件必须包含 projects 和 tasks 数组。");
  const projects = value.projects.map((project) => ({
    id: String(project.id || id()),
    name: String(project.name ?? "").trim(),
    description: String(project.description ?? ""),
    due: String(project.due ?? ""),
    color: escapeColor(project.color),
    meetings: Array.isArray(project.meetings) ? project.meetings.map((meeting) => ({
      id: String(meeting.id || id()),
      title: String(meeting.title ?? ""),
      date: String(meeting.date ?? ""),
      notes: String(meeting.notes ?? ""),
      nextSteps: String(meeting.nextSteps ?? "")
    })) : []
  })).filter((project) => project.name);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = value.tasks.filter((task) => task && String(task.title ?? "").trim()).map((task) => ({
    id: String(task.id || id()),
    title: String(task.title).trim(),
    projectId: projectIds.has(String(task.projectId ?? "")) ? String(task.projectId) : "",
    due: String(task.due ?? ""),
    done: Boolean(task.done),
    priority: ["高", "中", "低"].includes(task.priority) ? task.priority : "中",
    description: String(task.description ?? "")
  }));
  const games = Array.isArray(value.games) ? value.games.filter((game) => game && String(game.title ?? "").trim()).map((game) => ({
    id: String(game.id || id()),
    title: String(game.title).trim(),
    platform: String(game.platform ?? ""),
    genre: String(game.genre ?? ""),
    status: ["planned", "playing", "completed", "paused"].includes(game.status) ? game.status : "planned",
    rating: game.rating != null && game.rating !== "" && Number.isFinite(Number(game.rating)) ? Math.max(1, Math.min(10, Number(game.rating))) : "",
    notes: String(game.notes ?? "")
  })) : [];
  const defaults = emptyData();
  return {
    projects, tasks, games,
    articles: Array.isArray(value.articles) ? value.articles.map((article) => normalizeArticle(article)).filter(Boolean) : [],
    articleTrash: Array.isArray(value.articleTrash) ? value.articleTrash.map((article) => normalizeArticle(article, true)).filter(Boolean) : [],
    articleCategories: Array.isArray(value.articleCategories) ? value.articleCategories : defaults.articleCategories,
    articleSettings: value.articleSettings && typeof value.articleSettings === "object" ? value.articleSettings : {}
  };
}

function readLegacyData() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? normalizeWorkspace(raw) : null;
  } catch {
    return null;
  }
}

function hasRecords(value) {
  return value.projects.length + value.tasks.length + value.games.length + value.articles.length + value.articleTrash.length > 0;
}

let data = emptyData();
const app = document.querySelector("#app");
const dialog = document.querySelector("#entry-dialog");
const toast = document.querySelector("#toast");
const authRoot = document.querySelector("#auth-root");
const workspaceShell = document.querySelector("#workspace-shell");

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

function setSaveStatus(label, state = "") {
  document.querySelector("#save-label").textContent = label;
  document.querySelector(".save-indicator").classList.toggle("failed", state === "failed");
  document.querySelector(".save-indicator").classList.toggle("saving", state === "saving");
}

function saveData(message = "已同步到云端") {
  if (!cloudReady || !currentUser) {
    showToast("请先登录，才能保存到云端。");
    return Promise.resolve(false);
  }
  const snapshot = JSON.parse(JSON.stringify(data));
  const userId = currentUser.id;
  const queuedSave = saveQueue.then(async () => {
    setSaveStatus("正在同步…", "saving");
    const { error } = await supabaseClient.from(WORKSPACE_TABLE).upsert({
      user_id: userId,
      data: snapshot,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (error) throw error;
    setSaveStatus("云端已同步");
    showToast(message);
    return true;
  });
  saveQueue = queuedSave.catch(() => false);
  return queuedSave.catch((error) => {
    setSaveStatus("同步失败", "failed");
    showToast(`云端保存失败：${error.message ?? "请检查网络后重试。"}`);
    return false;
  });
}

function renderAuth(mode = "sign-in", message = "", isError = false) {
  authRoot.hidden = false;
  workspaceShell.hidden = true;
  if (!supabaseClient) {
    authRoot.innerHTML = `<section class="auth-card"><a class="brand auth-brand" href="#/home"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-copy"><strong>我的工作台</strong><small>PERSONAL WORKSPACE</small></span></a><h1>云端空间还未连接</h1><p class="auth-description">登录和数据同步需要 Supabase 项目。连接后，项目、任务和游戏资料会保存在云端，换设备登录也能继续使用。</p><div class="auth-setup">下一步需要在 <code>supabase-config.js</code> 配置项目 URL 和公开 Publishable Key，并在 Supabase 执行 <code>supabase/schema.sql</code>。不要在网页中放服务端密钥。</div></section>`;
    return;
  }
  if (mode === "loading") {
    authRoot.innerHTML = `<section class="auth-card"><div class="auth-brand"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-copy"><strong>我的工作台</strong><small>PERSONAL WORKSPACE</small></span></div><h1>正在连接云端</h1><p class="auth-description">${escapeHtml(message || "正在读取你的数据…")}</p></section>`;
    return;
  }
  const creating = mode === "sign-up";
  const authMode = creating ? "sign-up" : "sign-in";
  authRoot.innerHTML = `<section class="auth-card"><div class="auth-brand"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-copy"><strong>我的工作台</strong><small>PERSONAL WORKSPACE</small></span></div><h1>${creating ? "创建你的账号" : "登录工作台"}</h1><p class="auth-description">使用同一个邮箱账号，在不同设备访问同一份云端数据。</p><form class="auth-form" id="auth-form" data-mode="${authMode}"><label for="auth-email">邮箱<input id="auth-email" name="email" type="email" autocomplete="email" required></label><label for="auth-password">密码<input id="auth-password" name="password" type="password" autocomplete="${creating ? "new-password" : "current-password"}" minlength="8" required></label><button class="button primary" type="submit">${creating ? "创建账号" : "登录"}</button></form><p class="auth-message${isError ? " error" : ""}" id="auth-message">${escapeHtml(message)}</p><button class="auth-switch" type="button" data-action="auth-switch" data-mode="${creating ? "sign-in" : "sign-up"}">${creating ? "已有账号？返回登录" : "还没有账号？创建一个"}</button></section>`;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const values = new FormData(form);
  const email = String(values.get("email") ?? "").trim();
  const password = String(values.get("password") ?? "");
  const submit = form.querySelector('[type="submit"]');
  const message = document.querySelector("#auth-message");
  submit.disabled = true;
  message.classList.remove("error");
  message.textContent = "正在连接…";
  try {
    const result = form.dataset.mode === "sign-up"
      ? await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}${location.pathname}` } })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    submit.disabled = false;
    if (result.error) {
      message.classList.add("error");
      message.textContent = result.error.message;
    } else if (form.dataset.mode === "sign-up" && !result.data.session) {
      renderAuth("sign-in", "注册邮件已发送，请先完成邮箱验证，再回来登录。");
    } else {
      renderAuth("loading", "正在载入你的云端空间…");
    }
  } catch (error) {
    submit.disabled = false;
    message.classList.add("error");
    message.textContent = error.message || "连接失败，请稍后重试。";
  }
}

async function handleSession(session) {
  const user = session?.user;
  if (!user) {
    ++authRun;
    currentUser = null;
    cloudReady = false;
    loadingUserId = null;
    data = emptyData();
    workspaceShell.hidden = true;
    renderAuth("sign-in");
    return;
  }
  if (currentUser?.id === user.id && cloudReady) return;
  if (loadingUserId === user.id) return;
  const run = ++authRun;
  loadingUserId = user.id;
  currentUser = user;
  cloudReady = false;
  renderAuth("loading", "正在读取你的云端数据…");
  const { data: row, error } = await supabaseClient.from(WORKSPACE_TABLE).select("data").eq("user_id", user.id).maybeSingle();
  if (run !== authRun) {
    if (loadingUserId === user.id) loadingUserId = null;
    return;
  }
  if (error) {
    currentUser = null;
    loadingUserId = null;
    renderAuth("sign-in", `读取云端空间失败：${error.message}。请确认数据库表和权限策略已配置。`, true);
    return;
  }
  let migrateLegacy = false;
  if (row) {
    try {
      data = normalizeWorkspace(row.data);
    } catch {
      loadingUserId = null;
      currentUser = null;
      renderAuth("sign-in", "云端数据格式无法读取，没有覆盖现有数据。", true);
      return;
    }
  } else {
    const legacy = readLegacyData();
    migrateLegacy = !!legacy && hasRecords(legacy) && confirm("检测到这个浏览器里有旧版本地数据。要把它上传到当前账号的云端空间吗？");
    data = migrateLegacy ? legacy : emptyData();
  }
  cloudReady = true;
  loadingUserId = null;
  document.querySelector("#profile-email").textContent = user.email || "我的云端空间";
  authRoot.hidden = true;
  workspaceShell.hidden = false;
  setSaveStatus("云端已同步");
  history.replaceState(null, "", `${location.pathname}${location.search}#/home`);
  render();
  if (!row) await saveData(migrateLegacy ? "旧数据已迁移到云端" : "云端空间已创建");
}

async function startApp() {
  if (!supabaseClient) {
    renderAuth();
    return;
  }
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => void handleSession(session), 0);
  });
  const { data: sessionData, error } = await supabaseClient.auth.getSession();
  if (error) renderAuth("sign-in", error.message, true);
  else await handleSession(sessionData.session);
}

function exportWorkspace() {
  const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mypage-backup-${localDateString()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("已导出云端数据备份。");
}

async function importWorkspaceFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("文件超过 5 MB，无法导入。");
    return;
  }
  try {
    const parsed = JSON.parse(await file.text());
    const source = parsed?.data !== undefined ? (typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data) : parsed;
    const imported = normalizeWorkspace(source);
    const isJieshuExport = source?.format === "jieshu-site-json-export";
    const message = isJieshuExport
      ? `将导入 ${imported.articles.length} 条游戏开发资料，并保留 ${imported.articleTrash.length} 条回收站记录；现有工作项目和游玩记录不会被替换。继续吗？`
      : "导入会替换文件中包含的项目、任务和资料；文件未包含的资料会保留。继续吗？";
    if (!confirm(message)) return;
    const previous = data;
    if (isJieshuExport) data = { ...data, articles: imported.articles, articleTrash: imported.articleTrash, articleCategories: imported.articleCategories, articleSettings: imported.articleSettings };
    else {
      if (!Array.isArray(source.games)) imported.games = data.games;
      if (!Array.isArray(source.articles)) imported.articles = data.articles;
      if (!Array.isArray(source.articleTrash)) imported.articleTrash = data.articleTrash;
      if (!Array.isArray(source.articleCategories)) imported.articleCategories = data.articleCategories;
      if (!source.articleSettings) imported.articleSettings = data.articleSettings;
      data = imported;
    }
    if (!await saveData("数据已导入并同步到云端")) data = previous;
    render();
  } catch (error) {
    showToast(`导入失败：${error.message ?? "请检查 JSON 文件格式。"}`);
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
  const labels = { home: "首页", overview: "工作项目", projects: "我的项目", tasks: "所有任务", games: "游戏开发资料库", collection: "游玩记录", "article-trash": "资料回收站", project: "项目详情" };
  const active = ["collection", "article-trash"].includes(page) ? "games" : page === "project" ? "projects" : page;
  document.querySelectorAll("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === active));
  document.querySelector("#breadcrumb-title").textContent = labels[page] ?? "总览";
  document.querySelector("#nav-task-count").textContent = data.tasks.filter((task) => !task.done).length;
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
        <span class="home-card-kicker">GAME DEVELOPMENT WIKI</span><strong>游戏开发资料库</strong><span class="home-card-description">整理世界观、角色、剧情、玩法系统和技术方案。</span><span class="home-card-meta">${data.articles.length} 条资料 · ${data.articleCategories.length} 个分类</span>
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

function renderGameCollection() {
  const playing = data.games.filter((game) => game.status === "playing").length;
  const completed = data.games.filter((game) => game.status === "completed").length;
  return `${heading("PLAY LOG", "游玩记录", "记录你想玩、正在玩或已经通关的游戏。", `<a class="button" href="#/games">开发资料库</a><button class="button primary" type="button" data-action="create-game"><span class="icon-plus" aria-hidden="true">＋</span>添加游戏</button>`)}
    <section class="stat-grid game-stats"><article class="stat-card"><div class="stat-top"><span>全部游戏</span><span class="stat-icon" aria-hidden="true">▤</span></div><div class="stat-value">${data.games.length}<small>款游戏</small></div><div class="stat-foot">你的个人资料库</div></article><article class="stat-card"><div class="stat-top"><span>正在游玩</span><span class="stat-icon" aria-hidden="true">◉</span></div><div class="stat-value">${playing}<small>款游戏</small></div><div class="stat-foot">继续当前旅程</div></article><article class="stat-card"><div class="stat-top"><span>已经通关</span><span class="stat-icon" aria-hidden="true">✓</span></div><div class="stat-value">${completed}<small>款游戏</small></div><div class="stat-foot">值得回味的冒险</div></article><article class="stat-card attention"><div class="stat-top"><span>数据存储</span><span class="stat-icon" aria-hidden="true">☁</span></div><div class="stat-value">云端<small>已连接</small></div><div class="stat-foot">同一账号可在其他设备登录</div></article></section>
    <section><div class="section-heading"><div><h2>我的游戏</h2><p>按名称、平台或笔记搜索。</p></div><span class="game-count" id="game-count"></span></div>
    <div class="filter-bar"><label class="search-wrap"><span class="sr-only">搜索游戏</span><input class="search-input" id="game-search" type="search" placeholder="搜索游戏、平台、类型或笔记" value="${escapeHtml(gameQuery)}"></label><label><span class="sr-only">按游玩状态筛选</span><select class="filter-select" id="game-status-filter"><option value="all" ${gameStatusFilter === "all" ? "selected" : ""}>所有状态</option><option value="planned" ${gameStatusFilter === "planned" ? "selected" : ""}>想玩</option><option value="playing" ${gameStatusFilter === "playing" ? "selected" : ""}>在玩</option><option value="completed" ${gameStatusFilter === "completed" ? "selected" : ""}>已通关</option><option value="paused" ${gameStatusFilter === "paused" ? "selected" : ""}>暂放</option></select></label></div>
    <div class="game-grid" id="game-results"></div></section>`;
}

function articleCategoryName(categoryId) {
  return data.articleCategories.find((category) => category.id === categoryId)?.name ?? categoryId;
}

function articleCard(article, inTrash = false) {
  const tags = article.tags.map((tag) => `<span class="game-tag">${escapeHtml(tag)}</span>`).join("");
  const preview = article.summary || article.content.slice(0, 160) || "还没有摘要或正文。";
  return `<article class="article-card"><div class="article-card-head"><div><span class="article-category">${escapeHtml(articleCategoryName(article.category))}</span><h2><button class="article-title" type="button" data-action="show-article" data-id="${escapeHtml(article.id)}">${escapeHtml(article.title)}</button></h2></div>${inTrash ? "" : `<button class="article-favorite" type="button" data-action="toggle-article-favorite" data-id="${escapeHtml(article.id)}" aria-label="${article.favorite ? "取消收藏" : "收藏"}">${article.favorite ? "★" : "☆"}</button>`}</div><p class="article-summary">${escapeHtml(preview)}</p><div class="article-tags">${tags}<span class="article-status">${escapeHtml(article.status)}</span>${article.year ? `<span class="article-year">${escapeHtml(article.year)}</span>` : ""}</div><div class="article-card-actions">${inTrash ? `<button class="button small" type="button" data-action="restore-article" data-id="${escapeHtml(article.id)}">恢复</button>` : `<button class="button small" type="button" data-action="edit-article" data-id="${escapeHtml(article.id)}">编辑</button><button class="button small danger" type="button" data-action="delete-article" data-id="${escapeHtml(article.id)}">移到回收站</button>`}</div></article>`;
}

function drawArticles() {
  const list = document.querySelector("#article-results");
  const count = document.querySelector("#article-count");
  if (!list || !count) return;
  const query = articleQuery.trim().toLocaleLowerCase();
  const filtered = data.articles.filter((article) => {
    const text = [article.title, article.summary, article.content, ...article.tags, ...article.relations].join(" ").toLocaleLowerCase();
    return (!query || text.includes(query)) && (articleCategory === "all" || article.category === articleCategory) && (articleStatus === "all" || article.status === articleStatus) && (!articleFavoritesOnly || article.favorite);
  }).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  count.textContent = `${filtered.length} 条资料`;
  const hasFilter = query || articleCategory !== "all" || articleStatus !== "all" || articleFavoritesOnly;
  list.innerHTML = filtered.length ? filtered.map((article) => articleCard(article)).join("") : emptyState(hasFilter ? "没有匹配的资料" : "资料库还是空的", hasFilter ? "调整搜索词或筛选条件。" : "先记录一个想法、角色或玩法机制。", hasFilter ? null : "create-article", "新建资料");
}

function renderArticleContent(content) {
  const paragraphs = String(content ?? "").trim().split(/\n\s*\n/).filter(Boolean);
  return paragraphs.map((paragraph) => {
    const headingMatch = paragraph.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const tag = `h${Math.min(5, headingMatch[1].length + 1)}`;
      return `<${tag}>${escapeHtml(headingMatch[2])}</${tag}>`;
    }
    const lines = paragraph.split(/\r?\n/);
    if (lines.every((line) => /^[-*]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
  }).join("") || `<p class="muted">暂无正文。</p>`;
}

function showArticle(articleId) {
  const article = data.articles.find((item) => item.id === articleId) || data.articleTrash.find((item) => item.id === articleId);
  if (!article) return;
  const related = article.relations.map((relation) => data.articles.find((item) => item.id === relation || item.title === relation)?.title ?? relation);
  const backlinks = data.articles.filter((item) => item.id !== article.id && item.relations.some((relation) => relation === article.id || relation === article.title));
  const actions = data.articles.some((item) => item.id === article.id)
    ? `<button class="button primary" type="button" data-action="edit-article" data-id="${escapeHtml(article.id)}">编辑资料</button>`
    : `<button class="button" type="button" data-action="restore-article" data-id="${escapeHtml(article.id)}">恢复资料</button>`;
  dialog.innerHTML = `<article class="article-reader"><header class="dialog-header"><div><span class="article-category">${escapeHtml(articleCategoryName(article.category))}</span><h2 id="dialog-title">${escapeHtml(article.title)}</h2><p>${escapeHtml(article.status)}${article.year ? ` · ${escapeHtml(article.year)}` : ""}</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></header>${article.summary ? `<p class="article-reader-summary">${escapeHtml(article.summary)}</p>` : ""}<div class="article-reader-body">${renderArticleContent(article.content)}</div>${article.tags.length ? `<div class="article-tags">${article.tags.map((tag) => `<span class="game-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}${related.length ? `<section class="article-links"><strong>关联条目</strong><p>${related.map(escapeHtml).join("、")}</p></section>` : ""}${backlinks.length ? `<section class="article-links"><strong>被这些条目引用</strong><p>${backlinks.map((item) => escapeHtml(item.title)).join("、")}</p></section>` : ""}<div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">关闭</button>${actions}</div></article>`;
  dialog.showModal();
}

function renderGames() {
  const drafts = data.articles.filter((article) => article.status === "草稿").length;
  const settingsNote = data.articleSettings.note ? `<aside class="library-note"><strong>${escapeHtml(data.articleSettings.projectName || "设定集")}</strong><p>${escapeHtml(data.articleSettings.note)}</p></aside>` : "";
  const categoryOptions = data.articleCategories.map((category) => `<option value="${escapeHtml(category.id)}" ${articleCategory === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("");
  return `${heading("GAME DEVELOPMENT WIKI", "游戏开发资料库", "把灵感、世界观、角色、剧情、玩法和技术方案放在一处。", `<a class="button" href="#/collection">游玩记录 ${data.games.length ? `(${data.games.length})` : ""}</a><a class="button" href="#/article-trash">回收站 ${data.articleTrash.length ? `(${data.articleTrash.length})` : ""}</a><button class="button primary" type="button" data-action="create-article"><span class="icon-plus" aria-hidden="true">＋</span>新建资料</button>`)}
    <section class="stat-grid"><article class="stat-card"><div class="stat-top"><span>有效资料</span><span class="stat-icon" aria-hidden="true">▤</span></div><div class="stat-value">${data.articles.length}<small>条</small></div><div class="stat-foot">已迁入的游戏设定与笔记</div></article><article class="stat-card"><div class="stat-top"><span>资料分类</span><span class="stat-icon" aria-hidden="true">▦</span></div><div class="stat-value">${data.articleCategories.length}<small>类</small></div><div class="stat-foot">可按世界、玩法或技术筛选</div></article><article class="stat-card attention"><div class="stat-top"><span>待整理草稿</span><span class="stat-icon" aria-hidden="true">✎</span></div><div class="stat-value">${drafts}<small>条</small></div><div class="stat-foot">草稿可继续补充和关联</div></article><article class="stat-card"><div class="stat-top"><span>回收站</span><span class="stat-icon" aria-hidden="true">⌫</span></div><div class="stat-value">${data.articleTrash.length}<small>条</small></div><div class="stat-foot">删除的资料可以恢复</div></article></section>${settingsNote}
    <section><div class="section-heading"><div><h2>全部资料</h2><p>支持按标题、正文、标签与分类搜索。</p></div><span class="game-count" id="article-count"></span></div><div class="filter-bar"><label class="search-wrap"><span class="sr-only">搜索开发资料</span><input class="search-input" id="article-search" type="search" placeholder="搜索标题、内容或标签" value="${escapeHtml(articleQuery)}"></label><label><span class="sr-only">按分类筛选</span><select class="filter-select" id="article-category-filter"><option value="all">全部分类</option>${categoryOptions}</select></label><label><span class="sr-only">按状态筛选</span><select class="filter-select" id="article-status-filter"><option value="all" ${articleStatus === "all" ? "selected" : ""}>全部状态</option><option value="草稿" ${articleStatus === "草稿" ? "selected" : ""}>草稿</option><option value="验证中" ${articleStatus === "验证中" ? "selected" : ""}>验证中</option><option value="已定稿" ${articleStatus === "已定稿" ? "selected" : ""}>已定稿</option></select></label><label><span class="sr-only">收藏筛选</span><select class="filter-select" id="article-favorite-filter"><option value="all" ${articleFavoritesOnly ? "" : "selected"}>全部资料</option><option value="favorites" ${articleFavoritesOnly ? "selected" : ""}>只看收藏</option></select></label></div><div class="article-grid" id="article-results"></div></section>`;
}

function renderArticleTrash() {
  return `${heading("ARCHIVE", "资料回收站", "已删除的资料保留在这里，可以恢复到资料库。", `<a class="button" href="#/games">返回资料库</a>`)}<div class="article-grid">${data.articleTrash.length ? data.articleTrash.map((article) => articleCard(article, true)).join("") : emptyState("回收站为空", "删除的开发资料会暂存在这里。", null, "")}</div>`;
}

function render() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const page = ["home", "overview", "projects", "tasks", "games", "collection", "article-trash", "project"].includes(parts[0]) ? parts[0] : "home";
  updateShell(page);
  if (page === "home") app.innerHTML = renderHome();
  else if (page === "overview") app.innerHTML = renderOverview();
  else if (page === "projects") app.innerHTML = renderProjects();
  else if (page === "tasks") app.innerHTML = renderTasks();
  else if (page === "games") app.innerHTML = renderGames();
  else if (page === "collection") app.innerHTML = renderGameCollection();
  else if (page === "article-trash") app.innerHTML = renderArticleTrash();
  else app.innerHTML = renderProjectDetail(decodeURIComponent(parts[1] ?? ""));
  if (page === "games") drawArticles();
  if (page === "collection") drawGames();
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
  dialog.innerHTML = `<form class="dialog-form" id="entry-form"><div class="dialog-header"><div><h2 id="dialog-title">${escapeHtml(title)}</h2><p>内容会同步到云端。</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></div><div class="form-grid">${fields}</div><div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">保存</button></div></form>`;
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

function openArticleForm(recordId = "") {
  const existing = data.articles.find((article) => article.id === recordId);
  const categoryChoices = data.articleCategories.map((category) => [category.id, category.name]);
  const initialCategory = existing?.category ?? "inspiration";
  const relations = existing?.relations.map((relation) => data.articles.find((article) => article.id === relation)?.title ?? relation).join(", ") ?? "";
  const initialTemplate = data.articleCategories.find((category) => category.id === initialCategory)?.template ?? "";
  const fields = `${field("资料标题", "title", existing?.title, { required: true, full: true, placeholder: "例如：核心循环、角色动机" })}${field("分类", "category", initialCategory, { type: "select", choices: categoryChoices, required: true })}${field("状态", "status", existing?.status ?? "草稿", { type: "select", choices: [["草稿", "草稿"], ["验证中", "验证中"], ["已定稿", "已定稿"]] })}${field("一句话摘要", "summary", existing?.summary, { type: "textarea", full: true, placeholder: "列表里显示的简短说明" })}${field("正文（支持 Markdown 标题和列表）", "content", existing?.content ?? initialTemplate, { type: "textarea", full: true, placeholder: "## 核心概念\n记录细节、规则和待验证的问题。" })}${field("标签（逗号分隔）", "tags", existing?.tags.join(", "), { full: true, placeholder: "战斗, 核心循环" })}${field("关联条目标题（逗号分隔）", "relations", relations, { full: true, placeholder: "例如：游戏的主要设定, 半人马boss" })}${field("年份 / 时间线", "year", existing?.year, { placeholder: "可不填" })}${field("收藏", "favorite", String(Boolean(existing?.favorite)), { type: "select", choices: [["false", "否"], ["true", "是"]] })}`;
  dialog.innerHTML = `<form class="dialog-form" id="article-form"><div class="dialog-header"><div><h2 id="dialog-title">${existing ? "编辑开发资料" : "新建开发资料"}</h2><p>内容会同步到云端；保留你原来的分类、正文和标签。</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></div><div class="form-grid">${fields}</div><div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">保存资料</button></div></form>`;
  dialog.showModal();
  dialog.querySelector("#field-category").dataset.currentCategory = initialCategory;
  dialog.querySelector("#article-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const now = new Date().toISOString();
    const values = {
      title: String(form.get("title") ?? "").trim(),
      category: String(form.get("category") ?? "inspiration"),
      status: String(form.get("status") ?? "草稿"),
      summary: String(form.get("summary") ?? "").trim(),
      content: String(form.get("content") ?? "").trim(),
      tags: String(form.get("tags") ?? "").split(/[,，、\n]/).map((tag) => tag.trim()).filter(Boolean),
      relations: String(form.get("relations") ?? "").split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean),
      favorite: form.get("favorite") === "true",
      year: String(form.get("year") ?? "").trim(),
      updatedAt: now
    };
    if (existing) Object.assign(existing, values);
    else data.articles.unshift({ id: id(), ...values, example: false, createdAt: now });
    saveData(existing ? "资料已更新" : "资料已创建");
    dialog.close();
    render();
  });
}

function restoreArticle(recordId) {
  const article = data.articleTrash.find((item) => item.id === recordId);
  if (!article) return;
  const restored = normalizeArticle(article);
  data.articleTrash = data.articleTrash.filter((item) => item.id !== recordId);
  data.articles.unshift(restored);
  if (dialog.open) dialog.close();
  saveData("资料已恢复");
  render();
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
  } else if (action === "delete-article") {
    const article = data.articles.find((item) => item.id === recordId);
    if (!article || !confirm(`将“${article.title}”移到资料回收站？`)) return;
    data.articles = data.articles.filter((item) => item.id !== recordId);
    data.articleTrash.unshift({ ...article, deletedAt: new Date().toISOString() });
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
  if (action === "auth-switch") renderAuth(button.dataset.mode);
  else if (action === "import-data") document.querySelector("#data-import-file").click();
  else if (action === "export-data") exportWorkspace();
  else if (action === "sign-out") void supabaseClient.auth.signOut().then(({ error }) => {
    if (error) showToast(`退出登录失败：${error.message}`);
  });
  else if (action === "show-article") showArticle(recordId);
  else if (action === "create-article") openArticleForm();
  else if (action === "edit-article") {
    if (dialog.open) dialog.close();
    openArticleForm(recordId);
  }
  else if (action === "toggle-article-favorite") {
    const article = data.articles.find((item) => item.id === recordId);
    if (article) {
      article.favorite = !article.favorite;
      article.updatedAt = new Date().toISOString();
      saveData(article.favorite ? "已收藏" : "已取消收藏");
      render();
    }
  }
  else if (action === "restore-article") restoreArticle(recordId);
  else if (action === "create-project") openForm("project");
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
  if (target.id === "data-import-file") {
    void importWorkspaceFile(target.files?.[0]).finally(() => { target.value = ""; });
  } else if (target.matches('[data-action="toggle-task"]')) {
    const task = data.tasks.find((item) => item.id === target.dataset.id);
    if (task) {
      task.done = target.checked;
      saveData();
      render();
    }
  } else if (target.id === "game-status-filter") {
    gameStatusFilter = target.value;
    drawGames();
  } else if (target.id === "article-category-filter") {
    articleCategory = target.value;
    drawArticles();
  } else if (target.id === "article-status-filter") {
    articleStatus = target.value;
    drawArticles();
  } else if (target.id === "article-favorite-filter") {
    articleFavoritesOnly = target.value === "favorites";
    drawArticles();
  } else if (target.id === "field-category") {
    const content = dialog.querySelector("#field-content");
    const previous = data.articleCategories.find((category) => category.id === target.dataset.currentCategory)?.template ?? "";
    if (!content.value.trim() || content.value === previous) content.value = data.articleCategories.find((category) => category.id === target.value)?.template ?? "";
    target.dataset.currentCategory = target.value;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "game-search" || event.target.id === "article-search") {
    const cursor = event.target.selectionStart;
    const isArticleSearch = event.target.id === "article-search";
    if (isArticleSearch) articleQuery = event.target.value;
    else gameQuery = event.target.value;
    if (isArticleSearch) drawArticles();
    else drawGames();
    const search = document.querySelector(isArticleSearch ? "#article-search" : "#game-search");
    search?.focus();
    search?.setSelectionRange(cursor, cursor);
  }
});

window.addEventListener("hashchange", render);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dialog.open) dialog.close();
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "auth-form") void handleAuthSubmit(event);
});

void startApp();
