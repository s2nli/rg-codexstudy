/* RG Vikramjeet - course browser + ClassX video/PDF player.
   Content source: rgvikproxy (optional) with automatic fallback to the offline data in batches.json.
   No key / token-verification gate: batches and lectures open directly. */
(function () {
  "use strict";

  const DEFAULTS = {
    apiBase: "https://rgvikproxy.vercel.app/api",
    useProxy: true,
    batchesEndpoint: "/courses",
    user: 0,
    timeoutMs: 7000,
    playerBase: "https://player.classx.co.in/secure-player?token=",
    pdfViewerBase: "https://pdfweb.classx.co.in/pdfjs/web/viewer-new.html?file="
  };
  let CFG = Object.assign({}, DEFAULTS);

  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const toast = (m) => { try { window.showToast ? window.showToast(m) : console.log(m); } catch (e) {} };

  /* ---------- config + API ---------- */
  async function loadConfig() {
    try {
      const r = await fetch("config.json", { cache: "no-store" });
      if (r.ok) CFG = Object.assign({}, DEFAULTS, await r.json());
    } catch (e) { /* keep defaults */ }
    return CFG;
  }

  const memo = new Map();
  const TTL = 5 * 60 * 1000;
  async function getJson(url, { timeout = CFG.timeoutMs, cache = true } = {}) {
    const hit = cache && memo.get(url);
    if (hit && Date.now() - hit.t < TTL) return hit.d;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
    try {
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error(`API error ${r.status}`);
      const d = await r.json();
      if (cache) memo.set(url, { t: Date.now(), d });
      return d;
    } finally { if (timer) clearTimeout(timer); }
  }
  const api = (path, params) => `${CFG.apiBase.replace(/\/$/, "")}/${path}?${new URLSearchParams(params).toString()}`;
  const listOf = (r) => Array.isArray(r) ? r : (r && (r.courses || r.batches || r.subjects || r.topics || r.concepts || r.content || r.contents || r.lectures || r.data)) || [];

  function normalizeBatch(c, i) {
    const id = c.id ?? c._id ?? c.course_id ?? c.courseid ?? `remote-${i}`;
    const instructor = c.instructor || c.teacher || c.byName || c.by || "RG Vikramjeet";
    return {
      _id: String(id), courseId: String(c.courseId ?? c.course_id ?? c.id ?? id), user: Number(c.userIndex ?? c.user ?? 0),
      name: c.name || c.title || `Course ${i + 1}`, byName: instructor, instructor,
      category: c.category || "Courses", startDate: c.startDate || c.start_date || c.start || "",
      language: c.language || "Hindi", previewImage: c.previewImage || c.thumbnail || c.image || c.thumb || "",
      type: "RGV", slug: String(id), subBatches: [], subjects: [], remote: true
    };
  }

  /* Returns an array of batches from the proxy, or null if unreachable / empty (caller falls back to batches.json). */
  async function fetchRemoteBatches() {
    if (!CFG.useProxy || !CFG.apiBase || !CFG.batchesEndpoint) return null;
    try {
      const d = await getJson(CFG.apiBase.replace(/\/$/, "") + CFG.batchesEndpoint, { cache: false });
      const list = listOf(d).map(normalizeBatch);
      return list.length ? list : null;
    } catch (e) { console.warn("[RGV] proxy batches unavailable, using offline data:", e.message); return null; }
  }

  /* ---------- node model ---------- */
  const LEVELS = ["Subjects", "Topics", "Concepts", "Content"];
  const isPdfItem = (x) => !!(x.pdf_url || x.pdfUrl || /pdf/i.test(x.type || ""));

  function leafFrom(x, ctx) {
    const pdf = isPdfItem(x);
    return {
      kind: pdf ? "pdf" : "video", id: String(x.id ?? x.video_id ?? x._id ?? Math.random()),
      title: x.title || x.name || "Untitled", thumb: x.thumbnail || x.thumb || "", duration: Number(x.duration) || 0,
      pdfUrl: x.pdf_url || x.pdfUrl || x.file || "", videoId: x.video_id || (pdf ? "" : x.id) || "",
      token: x.token || x.lecture_token || x.video_player_token || "", playerUrl: x.player_url || x.playerUrl || "",
      courseId: ctx.courseId, user: ctx.user, direct: !!x.direct
    };
  }

  /* offline (batches.json) nodes: subjects -> chapters -> items */
  function offlineFolder(list, ctx, level) {
    return (list || []).map((n) => {
      const children = n.chapters || n.items;
      if (!children) return leafFrom(n, ctx);            // a lecture / PDF entry
      return { kind: "folder", id: String(n.id || n.name), name: n.name || n.title, level,
        children: n.chapters ? offlineFolder(n.chapters, ctx, level + 1) : n.items.map((x) => leafFrom(x, ctx)) };
    });
  }

  function proxyFolders(list, ctx, level, parents) {
    return list.map((x) => ({
      kind: "folder", id: String(x.id ?? x._id), name: x.name || x.title || `${LEVELS[level - 1] || "Item"}`, level, _raw: x,
      load: () => loadProxyLevel(ctx, level + 1, Object.assign({}, parents, { [["subjectid", "topicid", "conceptid"][level - 1]]: x.id ?? x._id }))
    }));
  }

  async function loadProxyLevel(ctx, level, p) {
    const base = { courseid: ctx.courseId, user: ctx.user };
    if (level === 1) return proxyFolders(listOf(await getJson(api("subjects", base))), ctx, 1, {});
    if (level === 2) return proxyFolders(listOf(await getJson(api("topics", Object.assign({}, base, { subjectid: p.subjectid })))), ctx, 2, p);
    if (level === 3) return proxyFolders(listOf(await getJson(api("concepts", Object.assign({}, base, { subjectid: p.subjectid, topicid: p.topicid })))), ctx, 3, p);
    const items = listOf(await getJson(api("content", Object.assign({}, base, { subjectid: p.subjectid, topicid: p.topicid, conceptid: p.conceptid }))));
    return items.map((x) => leafFrom(x, ctx));
  }

  async function rootNodes(batch) {
    const ctx = { courseId: batch.courseId || "", user: Number(batch.user ?? CFG.user) || 0 };
    const offline = offlineFolder(batch.subjects, ctx, 1);
    if (CFG.useProxy && ctx.courseId) {
      try { return { nodes: await loadProxyLevel(ctx, 1, {}), source: "live" }; }
      catch (e) {
        console.warn("[RGV] proxy unreachable, falling back to offline data:", e.message);
        if (offline.length) return { nodes: offline, source: "offline" };
        throw e;
      }
    }
    return { nodes: offline, source: "offline" };
  }

  /* ---------- URL builders ---------- */
  const tokenUrl = (t) => CFG.playerBase + String(t).replace(/[&#\s]/g, encodeURIComponent);
  const pdfUrl = (u) => (u.startsWith(CFG.pdfViewerBase) ? u : CFG.pdfViewerBase + encodeURIComponent(u));

  async function resolveLeaf(leaf) {
    if (leaf.kind === "pdf") {
      if (!leaf.pdfUrl) throw new Error("No PDF link set for this note yet.");
      if (leaf.direct) return leaf.pdfUrl;
      return pdfUrl(leaf.pdfUrl);
    }
    if (leaf.token && leaf.token !== "1234") return tokenUrl(leaf.token);
    if (leaf.videoId && leaf.courseId && CFG.useProxy) {
      try {
        const r = await getJson(api("video", { video_id: leaf.videoId, course_id: leaf.courseId, user: leaf.user }));
        const t = r && r.raw && r.raw.video_player_token;
        if (t && t !== "1234") return tokenUrl(t);
      } catch (e) { console.warn("[RGV] video token lookup failed:", e.message); }
    }
    if (leaf.playerUrl) return leaf.playerUrl;
    throw new Error("No lecture token available for this video yet.");
  }

  /* ---------- UI ---------- */
  let app, body, titleEl, crumbEl, player, frame, msg, drawer, plTitle, plList, theaterBtn;
  let batch = null, stack = [], playlist = [], plIndex = -1, theater = false, playerOpen = false, reqId = 0;

  function build() {
    if (app) return;
    app = document.createElement("div");
    app.className = "rgv"; app.hidden = true;
    app.innerHTML = `
      <header class="rgv-head">
        <button class="rgv-ib" id="rgvBack" aria-label="Back">${ic("back")}</button>
        <div class="rgv-ttl"><b id="rgvTitle">Course</b><small id="rgvCrumb"></small></div>
        <button class="rgv-ib" id="rgvClose" aria-label="Close course">${ic("x")}</button>
      </header>
      <div class="rgv-search"><input id="rgvFilter" type="search" placeholder="Filter this list…" autocomplete="off"></div>
      <div class="rgv-body" id="rgvBody"></div>`;
    player = document.createElement("div");
    player.className = "rgv-player"; player.hidden = true;
    player.innerHTML = `
      <header class="rgv-phead">
        <button class="rgv-ib" id="rgvPBack" aria-label="Back to list">${ic("back")}</button>
        <div class="rgv-ttl"><b id="rgvPTitle">Now playing</b><small id="rgvPSub"></small></div>
        <button class="rgv-ib" id="rgvTheater" aria-label="Theater mode" title="Theater mode">${ic("theater")}</button>
        <button class="rgv-ib" id="rgvList" aria-label="Chapter playlist" title="Playlist">${ic("list")}</button>
        <a class="rgv-ib" id="rgvNewTab" aria-label="Open in new tab" title="Open in new tab" target="_blank" rel="noopener">${ic("ext")}</a>
        <button class="rgv-ib" id="rgvPClose" aria-label="Close player">${ic("x")}</button>
      </header>
      <div class="rgv-stage"><iframe id="rgvFrame" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen title="Lecture player"></iframe><div class="rgv-msg" id="rgvMsg"></div></div>
      <div class="rgv-pnav"><button class="rgv-btn" id="rgvPrev">${ic("back")} Prev</button><span id="rgvPos"></span><button class="rgv-btn" id="rgvNext">Next ${ic("next")}</button></div>
      <div class="rgv-tfloat"><button class="rgv-ib" id="rgvTExit" aria-label="Exit theater mode">${ic("x")}</button><button class="rgv-ib" id="rgvTList" aria-label="Chapter playlist">${ic("list")}</button></div>
      <div class="rgv-scrim" id="rgvScrim"></div>
      <aside class="rgv-drawer" id="rgvDrawer" aria-label="Chapter playlist">
        <div class="rgv-dhead"><b id="rgvPlTitle">Playlist</b><button class="rgv-ib" id="rgvDClose" aria-label="Close playlist">${ic("x")}</button></div>
        <div class="rgv-dlist" id="rgvPlList"></div>
      </aside>`;
    document.body.appendChild(app);
    document.body.appendChild(player);
    body = app.querySelector("#rgvBody"); titleEl = app.querySelector("#rgvTitle"); crumbEl = app.querySelector("#rgvCrumb");
    frame = player.querySelector("#rgvFrame"); msg = player.querySelector("#rgvMsg");
    drawer = player.querySelector("#rgvDrawer"); plTitle = player.querySelector("#rgvPlTitle"); plList = player.querySelector("#rgvPlList");
    theaterBtn = player.querySelector("#rgvTheater");

    app.querySelector("#rgvBack").onclick = () => back();
    app.querySelector("#rgvClose").onclick = () => closeAll();
    app.querySelector("#rgvFilter").addEventListener("input", (e) => filterRows(e.target.value));
    player.querySelector("#rgvPBack").onclick = () => back();
    player.querySelector("#rgvPClose").onclick = () => closeAll();
    theaterBtn.onclick = () => setTheater(!theater);
    player.querySelector("#rgvList").onclick = () => toggleDrawer(true);
    player.querySelector("#rgvTList").onclick = () => toggleDrawer(true);
    player.querySelector("#rgvTExit").onclick = () => setTheater(false);
    player.querySelector("#rgvDClose").onclick = () => toggleDrawer(false);
    player.querySelector("#rgvScrim").onclick = () => toggleDrawer(false);
    player.querySelector("#rgvPrev").onclick = () => step(-1);
    player.querySelector("#rgvNext").onclick = () => step(1);
    window.addEventListener("popstate", onPop);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (app.hidden && player.hidden) return;
      if (drawer.classList.contains("open")) toggleDrawer(false); else if (theater) setTheater(false); else back();
    });
  }

  function ic(n) {
    const p = {
      back: '<path d="M15 5l-7 7 7 7"/>', next: '<path d="M9 5l7 7-7 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
      theater: '<rect x="3" y="6" width="18" height="12" rx="2"/>', list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
      ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      play: '<path d="M8 5v14l11-7Z" fill="currentColor"/>', cam: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5 21 8v8l-5-2.5"/>', pdf: '<path d="M7 3h7l5 5v13H7Z"/><path d="M14 3v5h5"/>'
    }[n];
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  /* ---------- navigation (history-aware so the phone back button steps back one screen) ---------- */
  function push(view) {
    stack.push(view);
    try { history.pushState({ rgv: stack.length }, "", location.href); } catch (e) {}
    render();
  }
  function back() {
    if (!stack.length) return;
    if (stack.length === 1) { closeAll(); return; }
    try { history.back(); } catch (e) { stack.pop(); render(); }
  }
  function onPop(e) {
    const target = (e.state && e.state.rgv) || 0;
    if (!batch) return;
    if (target === 0) { hideAll(); return; }
    while (stack.length > target) stack.pop();
    render();
  }
  function closeAll() {
    const n = stack.length;
    hideAll();
    if (n) { try { history.go(-n); } catch (e) {} }
  }
  function hideAll() {
    stack = []; batch = null; playerOpen = false; reqId++;
    if (app) { app.hidden = true; player.hidden = true; frame.src = "about:blank"; toggleDrawer(false); setTheater(false); }
    document.body.style.overflow = "";
  }

  function open(b) {
    build();
    batch = b; stack = []; playlist = []; plIndex = -1;
    app.hidden = false; document.body.style.overflow = "hidden";
    push({ type: "folder", title: b.name || "Course", crumb: [], nodes: null, root: true, tabs: b.layout === "tabs", tab: "lectures" });
  }

  function render() {
    const v = stack[stack.length - 1];
    if (!v) return;
    if (v.type === "player") { showPlayer(v); return; }
    playerOpen = false; player.hidden = true; frame.src = "about:blank"; toggleDrawer(false); setTheater(false);
    app.hidden = false;
    titleEl.textContent = v.title;
    crumbEl.textContent = v.tabs ? "" : (v.crumb.length ? v.crumb.join(" › ") : [batch.instructor || batch.byName, batch.category].filter(Boolean).join(" · "));
    app.querySelector("#rgvFilter").value = "";
    app.querySelector(".rgv-search").style.display = v.tabs ? "none" : "";
    body.scrollTop = 0;
    if (v.nodes) { v.tabs ? drawBatchPage(v) : drawFolder(v); return; }
    body.innerHTML = skeleton();
    const my = ++reqId;
    const p = v.root ? rootNodes(batch).then((r) => { v.source = r.source; return r.nodes; }) : v.load();
    p.then((nodes) => { if (my !== reqId) return; v.nodes = nodes; v.tabs ? drawBatchPage(v) : drawFolder(v); })
     .catch((err) => { if (my !== reqId) return; drawError(v, err); });
  }

  function skeleton() {
    return '<div class="rgv-list">' + Array.from({ length: 6 }, () => '<div class="rgv-row rgv-sk"><div class="rgv-ico"></div><div class="rgv-rt"><i></i><i style="width:45%"></i></div></div>').join("") + "</div>";
  }

  function drawError(v, err) {
    body.innerHTML = `<div class="rgv-empty"><p>${esc(err && err.message || "Could not load this list.")}</p><button class="rgv-btn rgv-pri" id="rgvRetry">Retry</button></div>`;
    body.querySelector("#rgvRetry").onclick = () => { v.nodes = null; render(); };
  }

  /* ---------- batch page (hero + Lectures / Notes / About tabs) ---------- */
  function leavesOf(n) {
    if (n.kind !== "folder") return [n];
    return (n.children || []).reduce((a, c) => a.concat(leavesOf(c)), []);
  }

  function drawBatchPage(v) {
    const nodes = v.nodes || [];
    const rows = (nodes.length === 1 && nodes[0].kind === "folder" && nodes[0].children) ? nodes[0].children : nodes;
    const all = nodes.reduce((a, n) => a.concat(leavesOf(n)), []);
    const nVid = all.filter((x) => x.kind === "video").length, nPdf = all.filter((x) => x.kind === "pdf").length;
    const tab = v.tab || "lectures";
    const tags = (batch.tags && batch.tags.length ? batch.tags : [batch.category, batch.language]).filter(Boolean);
    const hero = `<section class="rgv-hero">
        <img class="rgv-hero-img" src="${esc(batch.previewImage || "assets/icon-512.png")}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='assets/icon-512.png'">
        <div class="rgv-hero-body"><h2>${esc(batch.name)}</h2>${batch.subtitle ? `<p>${esc(batch.subtitle)}</p>` : ""}
        <div class="rgv-tags">${tags.map((t, i) => `<span class="rgv-tag${i === 0 ? " pri" : ""}">${esc(t)}</span>`).join("")}</div></div></section>`;
    const tabs = `<div class="rgv-tabs" role="tablist">${[["lectures", "Lectures"], ["notes", "Notes"], ["about", "About"]].map(([k, l]) =>
      `<button class="rgv-tab${k === tab ? " on" : ""}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join("")}</div>`;
    let content = "";
    if (tab === "about") {
      const facts = [["Instructor", batch.instructor || batch.byName], ["Category", batch.category], ["Language", batch.language], ["Lectures", nVid], ["Notes / PDFs", nPdf], ["Chapters", rows.length]].filter((f) => f[1] !== "" && f[1] != null);
      content = `<div class="rgv-about">${batch.about ? `<p>${esc(batch.about)}</p>` : ""}<div class="rgv-facts">${facts.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(String(val))}</b></div>`).join("")}</div></div>`;
    } else {
      const kind = tab === "notes" ? "pdf" : "video", unit = tab === "notes" ? "note" : "lecture";
      const list = rows.map((r) => ({ r, items: leavesOf(r).filter((x) => x.kind === kind) })).filter((x) => x.items.length);
      v.list = list;
      content = list.length ? '<div class="rgv-list">' + list.map(({ r, items }, i) =>
        `<button class="rgv-row" data-i="${i}"><span class="rgv-ico ${kind}">${ic(kind === "pdf" ? "pdf" : "cam")}</span><span class="rgv-rt"><b>${esc(r.name || r.title)}</b><small>${items.length} ${unit}${items.length === 1 ? "" : "s"}</small></span><span class="rgv-chev">${ic("next")}</span></button>`).join("") + "</div>"
        : `<div class="rgv-empty"><p>No ${tab === "notes" ? "notes" : "lectures"} yet.</p></div>`;
    }
    body.innerHTML = hero + tabs + content;
    body.querySelectorAll(".rgv-tab").forEach((b) => b.addEventListener("click", () => { v.tab = b.dataset.tab; const y = body.scrollTop; drawBatchPage(v); body.scrollTop = y; }));
    body.querySelectorAll(".rgv-list .rgv-row").forEach((row) => row.addEventListener("click", () => {
      const e = v.list[Number(row.dataset.i)]; if (!e) return;
      push({ type: "folder", title: e.r.name || e.r.title, crumb: [batch.name], nodes: e.items });
    }));
  }

  function drawFolder(v) {
    const nodes = v.nodes || [];
    if (!nodes.length) {
      body.innerHTML = `<div class="rgv-empty"><p>Nothing here yet.${v.root ? " Add content for this batch in batches.json or set its courseId." : ""}</p></div>`;
      return;
    }
    const banner = v.root && v.source === "offline" && batch.courseId
      ? '<div class="rgv-note">Live server unreachable — showing offline data.</div>' : "";
    body.innerHTML = banner + '<div class="rgv-list">' + nodes.map((n, i) => rowHtml(n, i)).join("") + "</div>";
    body.querySelectorAll(".rgv-row").forEach((row) => row.addEventListener("click", () => onRow(v, nodes[Number(row.dataset.i)])));
  }

  function rowHtml(n, i) {
    if (n.kind === "folder") {
      const c = n.children ? `<small>${n.children.length} item${n.children.length === 1 ? "" : "s"}</small>` : "";
      return `<button class="rgv-row" data-i="${i}" data-q="${esc((n.name || "").toLowerCase())}"><span class="rgv-ico">${ic("folder")}</span><span class="rgv-rt"><b>${esc(n.name)}</b>${c}</span><span class="rgv-chev">${ic("next")}</span></button>`;
    }
    const dur = n.duration ? ` · ${Math.floor(n.duration / 60)}m` : "";
    const thumb = n.thumb ? `<img class="rgv-th" src="${esc(n.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="rgv-ico ${n.kind}">${ic(n.kind === "pdf" ? "pdf" : "play")}</span>`;
    return `<button class="rgv-row" data-i="${i}" data-q="${esc((n.title || "").toLowerCase())}">${thumb}<span class="rgv-rt"><b>${esc(n.title)}</b><small>${n.kind === "pdf" ? "PDF notes" : "Video lecture"}${dur}</small></span><span class="rgv-chev">${ic("next")}</span></button>`;
  }

  function filterRows(q) {
    q = q.trim().toLowerCase();
    body.querySelectorAll(".rgv-row").forEach((r) => { r.style.display = !q || (r.dataset.q || "").includes(q) ? "" : "none"; });
  }

  function onRow(v, n) {
    if (!n) return;
    if (n.kind === "pdf" && n.direct && n.pdfUrl) { window.open(n.pdfUrl, "_blank", "noopener"); return; }
    if (n.kind === "folder") {
      push({ type: "folder", title: n.name, crumb: v.root ? [] : v.crumb.concat(v.title), nodes: n.children || null, load: n.load });
      return;
    }
    playlist = (v.nodes || []).filter((x) => x.kind !== "folder");
    plIndex = playlist.indexOf(n);
    push({ type: "player", folderTitle: v.title });
  }

  /* ---------- player ---------- */
  async function showPlayer(v) {
    app.hidden = false; player.hidden = false; playerOpen = true;
    const leaf = playlist[plIndex];
    if (!leaf) return;
    player.querySelector("#rgvPTitle").textContent = leaf.title;
    player.querySelector("#rgvPSub").textContent = v.folderTitle || "";
    player.querySelector("#rgvPos").textContent = `${plIndex + 1} / ${playlist.length}`;
    player.querySelector("#rgvPrev").disabled = plIndex <= 0;
    player.querySelector("#rgvNext").disabled = plIndex >= playlist.length - 1;
    plTitle.textContent = v.folderTitle || "Playlist";
    drawPlaylist();
    const newTab = player.querySelector("#rgvNewTab");
    newTab.removeAttribute("href"); newTab.style.visibility = "hidden";
    msg.textContent = "Loading…"; msg.style.display = "flex"; frame.src = "about:blank";
    const my = ++reqId;
    try {
      const url = await resolveLeaf(leaf);
      if (my !== reqId) return;
      frame.onload = () => { if (my === reqId) msg.style.display = "none"; };
      frame.src = url;
      newTab.href = url; newTab.style.visibility = "visible";
      setTimeout(() => { if (my === reqId) msg.style.display = "none"; }, 4000);
    } catch (err) {
      if (my !== reqId) return;
      msg.innerHTML = `<div><p>${esc(err.message)}</p></div>`;
    }
  }

  function drawPlaylist() {
    plList.innerHTML = playlist.map((n, i) => `<button class="rgv-prow${i === plIndex ? " on" : ""}" data-i="${i}"><span class="rgv-ico ${n.kind}">${ic(n.kind === "pdf" ? "pdf" : "play")}</span><span class="rgv-rt"><b>${esc(n.title)}</b><small>${n.kind === "pdf" ? "PDF" : "Video"}</small></span></button>`).join("");
    plList.querySelectorAll(".rgv-prow").forEach((b) => b.addEventListener("click", () => { plIndex = Number(b.dataset.i); toggleDrawer(false); showPlayer(stack[stack.length - 1]); }));
    const on = plList.querySelector(".on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
  }

  function step(d) {
    const n = plIndex + d;
    if (n < 0 || n >= playlist.length) return;
    plIndex = n; showPlayer(stack[stack.length - 1]);
  }
  function toggleDrawer(on) {
    if (!drawer) return;
    drawer.classList.toggle("open", !!on);
    player.querySelector("#rgvScrim").classList.toggle("open", !!on);
  }
  function setTheater(on) {
    theater = !!on;
    if (!player) return;
    player.classList.toggle("theater", theater);
    theaterBtn.classList.toggle("on", theater);
  }

  window.RGV = { loadConfig, fetchRemoteBatches, open, close: closeAll, get config() { return CFG; } };
})();
