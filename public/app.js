/* Footnote frontend. All network calls use the contract in docs/API.md. */
const $ = (selector, root = document) => root.querySelector(selector);
const dom = {
  main: $("#main"), balance: $("#balance"), modes: $("#mode-badges"),
  sessionError: $("#session-error"), addCredits: $("#add-credits"),
  dialog: $("#credits-dialog"), closeCredits: $("#close-credits"),
  creditForm: $("#credits-form"), packs: $("#credit-packs"),
  checkoutError: $("#checkout-error"), checkoutSubmit: $("#checkout-submit"),
  checkoutMode: $("#checkout-mode"), toasts: $("#toast-region"),
};

const state = {
  user: null, config: null, sessionError: "", sessionLoading: false,
  route: null, version: 0, controller: null, pollTimer: null,
  answerId: null, answer: null, answerError: "", progressKey: "", contentKey: "",
  submittedQuestion: "", submittedAnswerId: null, submitting: false, operation: null, checkoutBusy: false,
  draft: { question: "", ownDomain: "", feeCents: null },
};
const stages = ["researching", "attributing", "resolving", "paying"];
const stageNames = ["Researching", "Attributing", "Resolving payees", "Paying"];
const methodNames = {
  meta_tag: "Meta tag", footnote_json: "footnote.json", funding_yml: "FUNDING.yml",
  paypal_me: "paypal.me", none: "Unclaimed",
};
let toastTimer;
let highlightTimer;

function escapeHTML(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}
const array = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = cents => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(number(cents) / 100);
const percent = value => Math.min(100, Math.max(0, number(value)));
const minimumPayout = () => money(state.config?.minPayoutCents ?? 100);
const creatorHref = domain => `#/creator/${encodeURIComponent(domain)}`;
const answerHref = id => `#/?answer=${encodeURIComponent(id)}`;

function safeURL(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function externalLink(url, label, className = "") {
  const href = safeURL(url);
  return href
    ? `<a class="${className}" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>`
    : `<span class="${className}">${escapeHTML(label)}</span>`;
}

function dateLabel(value, includeTime = false) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Something went wrong. Please try again.");
}

// Timeout and JSON failures are surfaced by the caller in an inline error region.
async function api(endpoint, { method = "GET", body, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const response = await fetch(endpoint, {
      method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try { data = await response.json(); }
    catch {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error(`The server returned an unreadable response (${response.status}). Please try again.`);
    }
    if (!response.ok) {
      const message = response.status === 402 || data?.error === "insufficient_credits"
        ? "You need more credits for this knowledge fee. Add credits and try again."
        : typeof data?.error === "string" ? data.error.replace(/_/g, " ")
          : typeof data?.message === "string" ? data.message : `Request failed (${response.status}). Please try again.`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (timedOut) throw new Error("The server took too long to respond. Please try again.");
    if (error.name === "AbortError") throw error;
    if (error instanceof TypeError) throw new Error("Couldn't reach Footnote. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function inlineError(message, action = "", label = "Try again") {
  return `<div class="inline-error" role="alert"><p>${escapeHTML(message)}</p>${action ? `<button type="button" class="text-link" data-action="${action}">${label}</button>` : ""}</div>`;
}

function emptyState(title, description) {
  return `<div class="empty-state"><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p></div>`;
}

function statusPill(value) {
  const status = String(value || "UNKNOWN").toUpperCase();
  const className = status.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `<span class="badge status-pill status-${className}">${escapeHTML(status)}</span>`;
}

function methodBadge(payee) {
  const method = payee?.method || "none";
  const text = methodNames[method] || method;
  const title = [payee?.label, payee?.email].filter(Boolean).join(" · ");
  const evidence = safeURL(payee?.evidenceUrl);
  return evidence
    ? `<a class="badge" href="${escapeHTML(evidence)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(title || "View payee declaration")}" aria-label="${escapeHTML(text)}: view payee declaration (opens in a new tab)">${escapeHTML(text)} ↗</a>`
    : `<span class="badge" title="${escapeHTML(title)}">${escapeHTML(text)}</span>`;
}

function isFixture(llm) {
  return Boolean(llm?.fixture || llm?.provider === "fixture");
}

function modelLabel(llm) {
  if (!llm) return "";
  const provider = { anthropic: "Anthropic", openai: "OpenAI", fixture: "Fixture" }[llm.provider] || llm.provider || "";
  return [provider, llm.model].filter(Boolean).join(" / ");
}

function renderHeader() {
  dom.balance.textContent = state.user ? money(state.user.balanceCents) : "—";
  dom.addCredits.disabled = !state.config || state.sessionLoading;
  const mode = state.config?.mode;
  if (mode) {
    const llm = { provider: mode.llm, model: mode.llmModel, fixture: mode.llm === "fixture" };
    const fixture = isFixture(llm) || (state.route?.name === "ask" && isFixture(state.answer?.llm));
    dom.modes.innerHTML = `<span class="mode-tag"><span class="mode-dot" aria-hidden="true"></span>PayPal ${escapeHTML(mode.paypal)}</span>
      <span class="mode-tag">${escapeHTML(modelLabel(llm))}</span>
      ${fixture ? '<span class="mode-tag fixture-tag">FIXTURE MODE</span>' : ""}`;
  } else {
    dom.modes.innerHTML = `<span class="mode-tag">${state.sessionLoading ? "Connecting…" : "Services unavailable"}</span>`;
  }
  dom.sessionError.innerHTML = state.sessionError ? inlineError(state.sessionError, "retry-session", "Reconnect") : "";
  document.querySelectorAll("[data-route]").forEach(link => {
    const active = link.dataset.route === state.route?.name || (link.dataset.route === "creators" && state.route?.name === "creator");
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function refreshSession() {
  if (state.sessionLoading) return false;
  state.sessionLoading = true;
  renderHeader();
  try {
    const data = await api("/api/me");
    if (!data?.user || !data?.config) throw new Error("The session response was incomplete. Reconnect to continue.");
    state.user = data.user;
    state.config = data.config;
    state.sessionError = "";
    if (state.draft.feeCents === null) state.draft.feeCents = data.config.defaultFeeCents ?? 50;
    return true;
  } catch (error) {
    state.sessionError = errorMessage(error);
    return false;
  } finally {
    state.sessionLoading = false;
    renderHeader();
  }
}

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  dom.toasts.innerHTML = `<div class="toast${isError ? " is-error" : ""}"><p>${escapeHTML(message)}</p><button type="button" class="icon-button" data-action="dismiss-toast" aria-label="Dismiss notification">×</button></div>`;
  toastTimer = setTimeout(() => { dom.toasts.innerHTML = ""; }, 9000);
}

function consumeCheckout(params) {
  const outcome = params.get("checkout");
  if (!outcome) return;
  if (outcome === "success") {
    const added = number(params.get("added"));
    toast(added > 0 ? `${money(added)} added. Your next question is covered.` : "Credits added. You're ready to ask.");
  } else if (outcome === "cancelled") toast("Checkout cancelled. Your balance is unchanged.");
  else toast("Checkout couldn't be completed. Please try adding credits again.", true);
  params.delete("checkout");
  params.delete("added");
  const routePath = (location.hash.slice(1) || "/").split("?")[0];
  history.replaceState(null, "", `${location.pathname}${location.search}#${routePath}${params.size ? `?${params}` : ""}`);
}

function parseRoute() {
  const [pathname, query = ""] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query);
  consumeCheckout(params);
  if (pathname === "/" || pathname === "") return { name: "ask", answerId: params.get("answer") };
  if (pathname === "/creators") return { name: "creators" };
  if (pathname === "/ledger") return { name: "ledger" };
  const match = pathname.match(/^\/creator\/([^/]+)\/?$/);
  if (match) {
    try { return { name: "creator", domain: decodeURIComponent(match[1]) }; }
    catch { return { name: "missing" }; }
  }
  return { name: "missing" };
}

function pageHeading(eyebrow, title, description, count = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHTML(eyebrow)}</span><h1>${escapeHTML(title)}</h1><p>${escapeHTML(description)}</p></div>${count ? `<span class="section-count">${escapeHTML(count)}</span>` : ""}</div>`;
}

function loadingPage(label) {
  return `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>Loading ${escapeHTML(label)}…</div>`;
}

async function handleRoute({ feedback = "" } = {}) {
  clearTimeout(state.pollTimer);
  state.controller?.abort();
  state.controller = new AbortController();
  const version = ++state.version;
  state.route = parseRoute();
  renderHeader();
  dom.main.setAttribute("aria-busy", "false");
  const { name, answerId, domain } = state.route;
  if (name === "ask") {
    document.title = "Footnote — Answers that give back.";
    if (!answerId) {
      state.answerId = null;
      state.answer = null;
      renderHeader();
      renderAsk();
    } else {
      if (state.answerId !== answerId) state.answer = null;
      state.answerId = answerId;
      state.answerError = "";
      state.progressKey = "";
      renderAnswerShell();
      await pollAnswer(answerId, version);
    }
  } else if (["creators", "creator", "ledger"].includes(name)) {
    document.title = `${name === "creator" ? domain : name === "creators" ? "Creators" : "Ledger"} — Footnote`;
    dom.main.innerHTML = loadingPage(name === "creator" ? "creator" : name);
    dom.main.setAttribute("aria-busy", "true");
    const endpoint = name === "creator" ? `/api/creators/${encodeURIComponent(domain)}` : `/api/${name}`;
    try {
      const data = await api(endpoint, { signal: state.controller.signal });
      if (version !== state.version) return;
      if (name === "creators") renderCreators(array(data), feedback);
      else if (name === "creator") renderCreator(data, feedback);
      else renderLedger(data, feedback);
    } catch (error) {
      if (error.name === "AbortError" || version !== state.version) return;
      dom.main.innerHTML = pageHeading("The paper trail", "A brief interruption.", "This page couldn't be loaded.") + feedbackRegion(feedback) + inlineError(errorMessage(error), "reload-page") + '<a class="back-link" href="#/">← Back to Ask</a>';
    } finally {
      if (version === state.version) dom.main.setAttribute("aria-busy", "false");
    }
  } else {
    document.title = "Page not found — Footnote";
    dom.main.innerHTML = pageHeading("An unnumbered page", "Nothing to cite here.", "That page doesn't exist. Start with a question.") + '<a class="button" href="#/">Back to Ask <span aria-hidden="true">→</span></a>';
  }
}

function renderAsk() {
  const config = state.config;
  const minFee = Math.min(100, Math.max(25, number(config?.minFeeCents ?? 25)));
  const maxFee = Math.max(minFee, Math.min(100, number(config?.maxFeeCents ?? 100)));
  const fee = Math.min(maxFee, Math.max(minFee, state.draft.feeCents ?? 50));
  state.draft.feeCents = fee;
  dom.main.innerHTML = `<section class="ask-hero" aria-labelledby="ask-title">
    <div class="hero-copy"><span class="eyebrow">Curiosity, with a conscience</span><h1 id="ask-title">Good answers owe<br>something to their sources.</h1><p>Ask anything. Get a researched answer. Pay the people whose work made it possible.</p></div>
    <aside class="margin-note"><span class="note-number" aria-hidden="true">[1]</span><h2>Credit where it's due.</h2><p>Your knowledge fee follows the evidence, from the first citation to the final payout.</p></aside>
  </section>
  <form id="ask-form" class="composer">
    <div class="question-area"><label for="question" class="question-label"><span class="eyebrow">Your question</span><span class="question-shortcut">⌘ / Ctrl + Enter to ask</span></label><textarea id="question" name="question" rows="3" placeholder="What would you like to understand?" required>${escapeHTML(state.draft.question)}</textarea></div>
    <div class="composer-settings">
      <div class="fee-control"><label class="fee-label" for="fee"><span>Knowledge fee</span><output id="fee-output" for="fee">${money(fee)}</output></label><input id="fee" class="fee-range" name="feeCents" type="range" min="${minFee}" max="${maxFee}" step="1" value="${fee}" aria-describedby="fee-help" aria-valuetext="${money(fee)} knowledge fee"><div class="range-labels" aria-hidden="true"><span>${money(minFee)}</span><span>${money(maxFee)}</span></div></div>
      <div class="own-domain"><details${state.draft.ownDomain ? " open" : ""}><summary>My own domain <span class="muted">(optional)</span></summary><label for="own-domain">Domain excluded from payouts</label><input id="own-domain" class="text-input" name="ownDomain" type="text" placeholder="yourdomain.com" autocomplete="url" autocapitalize="none" spellcheck="false" value="${escapeHTML(state.draft.ownDomain)}"></details><p>Your own work can inform the answer. It won't pay you back.</p></div>
    </div>
    <div id="ask-error" role="alert"></div>
    <div class="composer-bottom"><p id="fee-help">Your fee is allocated to cited sources. Unused shares return to your credits.</p><button id="ask-submit" class="button" type="submit"${!config || state.submitting ? " disabled" : ""}>${state.submitting ? "Starting research…" : 'Ask Footnote <span aria-hidden="true">→</span>'}</button></div>
  </form>
  ${array(config?.sampleQuestions).length ? `<div class="sample-questions" aria-label="Sample questions"><span>A place to start</span>${config.sampleQuestions.map((question, i) => `<button class="sample-chip" type="button" data-sample="${i}">${escapeHTML(question)}</button>`).join("")}</div>` : ""}
  ${!config ? inlineError("Connect to Footnote to load your credits and start a question.", "retry-session", "Reconnect") : ""}
  <section class="how-it-works" aria-label="How Footnote works">
    <div class="how-step"><span>01</span><div><h3>Follow the evidence.</h3><p>Sources are researched, cited, and weighted by their contribution.</p></div></div>
    <div class="how-step"><span>02</span><div><h3>Make credit tangible.</h3><p>Your knowledge fee becomes royalties for the people behind the answer.</p></div></div>
    <div class="how-step"><span>03</span><div><h3>Keep the receipt.</h3><p>See every share, every payee, and the status of every payout.</p></div></div>
  </section>`;
}

async function submitQuestion(form) {
  if (state.submitting || !state.config) return;
  const values = new FormData(form);
  const question = String(values.get("question") || "").trim();
  const ownDomain = String(values.get("ownDomain") || "").trim();
  const feeCents = number(values.get("feeCents"));
  const errorRegion = $("#ask-error");
  if (!question) {
    errorRegion.innerHTML = inlineError("Start with a question.");
    $("#question")?.focus();
    return;
  }
  state.draft = { question, ownDomain, feeCents };
  state.submitting = true;
  const version = state.version;
  const submit = $("#ask-submit");
  submit.disabled = true;
  submit.textContent = "Starting research…";
  errorRegion.innerHTML = "";
  form.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/ask", { method: "POST", body: { question, feeCents, ...(ownDomain ? { ownDomain } : {}) } });
    if (!data?.answerId) throw new Error("The server didn't return an answer reference. Please try again.");
    state.submittedQuestion = question;
    state.submittedAnswerId = data.answerId;
    if (version === state.version) location.hash = answerHref(data.answerId);
    else {
      // Keep a completed submission reachable if the reader navigated during the request.
      showFeedback(`<p>Your question is underway. <a href="${answerHref(data.answerId)}">Follow its progress →</a></p>`);
    }
  } catch (error) {
    if (version === state.version && $("#ask-error")) {
      $("#ask-error").innerHTML = inlineError(errorMessage(error));
    } else showFeedback(inlineError(errorMessage(error)));
  } finally {
    state.submitting = false;
    // The user may have returned to a newly rendered Ask form during this request.
    const currentForm = $("#ask-form");
    const currentSubmit = $("#ask-submit");
    if (currentForm && currentSubmit) {
      currentForm.setAttribute("aria-busy", "false");
      currentSubmit.disabled = !state.config;
      currentSubmit.innerHTML = 'Ask Footnote <span aria-hidden="true">→</span>';
    }
  }
}

function renderAnswerShell() {
  state.contentKey = "";
  const pendingQuestion = state.answerId === state.submittedAnswerId ? state.submittedQuestion : "";
  const question = state.answer?.question || pendingQuestion || "Following the evidence…";
  dom.main.innerHTML = `<div class="result-intro"><div><span class="eyebrow">Your question, followed through</span><h1 id="answer-question">${escapeHTML(question)}</h1></div><a class="button button-secondary button-small" href="#/" data-action="new-question">New question <span aria-hidden="true">↗</span></a></div>
    <div id="answer-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    <div id="answer-load-error"></div><div id="progress-panel">${loadingPage("research")}</div><div id="answer-content"></div>`;
  if (state.answer) updateAnswerView(state.answer, true);
}

function currentStage(answer) {
  if (answer.status === "done") return stages.length;
  const index = stages.indexOf(answer.status);
  if (index >= 0) return index;
  if (answer.status === "error") {
    return Math.max(-1, ...array(answer.events).map(event => stages.indexOf(event.stage)));
  }
  return -1;
}

function progressTemplate(answer, logOpen = false) {
  const stage = currentStage(answer);
  const done = answer.status === "done";
  const failed = answer.status === "error";
  const events = array(answer.events);
  const latest = events.at(-1);
  const message = state.answerError ? "Live updates paused. Retry to continue." : failed ? "Research stopped. See the error below." : done ? "Research complete. Every source is accounted for." : latest?.message || (answer.status === "queued" ? "Your question is in the research queue." : "Following the evidence…");
  return `<section class="pipeline" aria-label="Answer progress"><div class="pipeline-header"><span class="eyebrow">The paper trail</span><span class="pipeline-caption">${done ? `${array(answer.sources).filter(source => !source.dropped).length} sources cited` : failed ? "Interrupted" : state.answerError ? "Connection interrupted" : "Research in progress"}</span></div>
    <ol class="stepper">${stageNames.map((name, i) => {
      const complete = stage > i;
      const active = stage === i && !failed;
      return `<li class="step${complete ? " is-complete" : active ? " is-active" : ""}"${active ? ' aria-current="step"' : ""}><span class="step-number" aria-hidden="true">${complete ? "✓" : `0${i + 1}`}</span><span class="step-name">${name}<span class="sr-only">: ${complete ? "complete" : active ? "in progress" : "waiting"}</span></span></li>`;
    }).join("")}</ol>
    <p class="progress-live">${!done && !failed && !state.answerError ? '<span class="spinner" aria-hidden="true"></span>' : ""}<span>${escapeHTML(message)}</span></p>
    <details class="event-log" id="event-log"${logOpen ? " open" : ""}><summary>Research log <span class="mono">(${events.length})</span></summary>${events.length ? `<ol>${events.map(event => `<li><time datetime="${escapeHTML(event.t)}">${escapeHTML(timeLabel(event.t))}</time><span><span class="sr-only">${escapeHTML(event.stage)}: </span>${escapeHTML(event.message)}</span></li>`).join("")}</ol>` : '<p>No events yet. Research will appear here as it happens.</p>'}</details>
  </section>`;
}

async function pollAnswer(id, version) {
  if (version !== state.version) return;
  try {
    const data = await api(`/api/answers/${encodeURIComponent(id)}`, { signal: state.controller.signal });
    if (version !== state.version) return;
    if (!data || !data.status) throw new Error("The answer response was incomplete. Try loading it again.");
    state.answer = data;
    state.answerError = "";
    if (state.user && Number.isFinite(data.balanceCents)) state.user.balanceCents = data.balanceCents;
    renderHeader();
    updateAnswerView(data);
    if (!["done", "error"].includes(data.status)) {
      state.pollTimer = setTimeout(() => { void pollAnswer(id, version); }, 700);
    }
  } catch (error) {
    if (error.name === "AbortError" || version !== state.version) return;
    state.answerError = errorMessage(error);
    const region = $("#answer-load-error");
    if (region) region.innerHTML = inlineError(`${state.answerError} You can safely resume updates for this answer.`, "retry-answer", "Resume updates");
    if (state.answer) updateAnswerView(state.answer);
    else if ($("#progress-panel")) $("#progress-panel").innerHTML = "";
    if ($("#answer-live")) $("#answer-live").textContent = "Answer updates paused. Resume updates to try again.";
  }
}

function updateAnswerView(answer, force = false) {
  const question = $("#answer-question");
  if (!question) return;
  question.textContent = answer.question || "Your answer";
  document.title = `${answer.question || "Answer"} — Footnote`;
  const errorRegion = $("#answer-load-error");
  if (!state.answerError && errorRegion) errorRegion.innerHTML = "";
  const key = JSON.stringify([answer.status, answer.events, state.answerError]);
  if (force || state.progressKey !== key) {
    const open = $("#event-log")?.open || false;
    const logFocused = document.activeElement === $("#event-log > summary");
    $("#progress-panel").innerHTML = progressTemplate(answer, open);
    if (logFocused) $("#event-log > summary")?.focus({ preventScroll: true });
    const latest = array(answer.events).at(-1);
    $("#answer-live").textContent = answer.status === "done" ? "Your answer and royalty receipt are ready." : answer.status === "error" ? "Research stopped with an error." : latest?.message || `Answer status: ${answer.status}.`;
    state.progressKey = key;
  }
  const content = $("#answer-content");
  const contentKey = JSON.stringify([answer.status, answer.answerMarkdown, answer.llm, answer.sources, answer.receipt, answer.error]);
  if (answer.status === "done" && (force || state.contentKey !== contentKey)) {
    content.innerHTML = renderAnswer(answer) + renderReceipt(answer);
    state.contentKey = contentKey;
  } else if (answer.status === "error" && (force || state.contentKey !== contentKey)) {
    const message = typeof answer.error === "string" ? answer.error : answer.error?.message || "This question couldn't be completed. Try asking again.";
    content.innerHTML = inlineError(message) + '<a class="button button-secondary" href="#/" data-action="new-question">Ask another question →</a>';
    state.contentKey = contentKey;
  }
}

// Escape first: source content can produce only the small set of markup below.
function markdownLite(markdown, sources) {
  const citations = new Set(array(sources).map(source => String(source.n)));
  const inline = text => escapeHTML(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d+)\]/g, (_, n) => citations.has(n)
      ? `<a class="citation" href="#source-${n}" data-source="${n}" aria-label="Citation ${n}: go to source ${n}">[${n}]</a>`
      : `<sup class="citation-missing">[${n}]</sup>`);
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let listType = "";
  function flushParagraph() {
    if (paragraph.length) blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }
  function flushList() {
    if (listItems.length) blocks.push(`<${listType}>${listItems.map(item => `<li>${inline(item)}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = "";
  }
  for (const line of String(markdown || "").replace(/\r/g, "").split("\n")) {
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); blocks.push(`<h2>${inline(heading[1])}</h2>`);
    } else if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? "ul" : "ol";
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push((unordered || ordered)[1]);
    } else {
      flushList(); paragraph.push(line.trim());
    }
  }
  flushParagraph(); flushList();
  return blocks.join("");
}

function renderAnswer(answer) {
  const fixture = isFixture(answer.llm);
  return `<article class="answer-sheet" aria-labelledby="answer-label"><div class="answer-meta"><span id="answer-label" class="eyebrow">The answer</span><div class="answer-model">${fixture ? '<span class="fixture-tag">FIXTURE MODE</span>' : ""}<span>${escapeHTML(modelLabel(answer.llm))}</span></div></div><div class="answer-prose">${markdownLite(answer.answerMarkdown, answer.sources) || '<p>The answer is complete. Source allocations are recorded below.</p>'}</div></article>`;
}

function payoutExplanation(status) {
  return {
    ACCRUED: `Waiting to reach the ${minimumPayout()} payout minimum.`,
    PENDING: "Submitted for payment; awaiting confirmation.",
    UNCLAIMED: "No payee declaration found. The creator can add one to claim royalties.",
    ESCROW: "Held in escrow for the creator to claim.",
    LINK_ONLY: "A payment link was found; no automated payout was sent.",
    REFUNDED: "Returned to the questioner's credits.",
    FAILED: "Payment failed. This payout needs attention.",
  }[status] || "";
}

function sourceRow(source) {
  const n = Math.max(0, Math.trunc(number(source.n)));
  const share = source.dropped ? 0 : percent(source.sharePct);
  const flags = array(source.flags);
  const flagged = source.flagged || flags.some(flag => flag.kind === "prompt_injection");
  const explanation = payoutExplanation(source.payoutStatus);
  return `<article class="source-row${source.dropped ? " is-dropped" : ""}" id="source-${n}" tabindex="-1" aria-label="Source ${n}: ${escapeHTML(source.domain)}">
    <div class="source-top"><div class="source-identity"><span class="source-number">[${n}]</span><div><a class="source-title" href="${creatorHref(source.domain)}">${escapeHTML(source.domain)}</a>${externalLink(source.url, source.title || source.domain, "source-subtitle")}</div></div><span class="source-money">${money(source.shareCents)}</span></div>
    <div class="source-allocation"><div class="share-track" aria-hidden="true"><div class="share-fill" style="width:${share}%"></div></div><span class="share-text">${share}% share</span></div>
    <p class="source-justification">${source.dropped ? `<strong>Excluded.</strong> ${escapeHTML(source.dropReason || "This source did not qualify for a royalty.")}` : escapeHTML(source.justification || "No attribution note supplied.")}</p>
    <div class="source-badges">${methodBadge(source.payee)}${statusPill(source.payoutStatus)}</div>
    ${explanation ? `<p class="payout-explanation">${escapeHTML(explanation)}</p>` : ""}
    ${flagged ? `<details class="source-injection"><summary>Prompt injection stripped</summary>${flags.length ? flags.map(flag => `<blockquote>${escapeHTML(flag.snippet || "No snippet supplied.")}</blockquote>`).join("") : '<blockquote>The source contained instructions that were removed before attribution. No snippet supplied.</blockquote>'}</details>` : ""}
    ${source.payoutBatchId ? `<p class="source-batch">Batch ${escapeHTML(source.payoutBatchId)}${source.payoutItemId ? ` / Item ${escapeHTML(source.payoutItemId)}` : ""}</p>` : ""}
  </article>`;
}

function settlementLabel(value) {
  if (value === "agent") return "Settled by Claude agent via PayPal Payouts";
  if (value === "deterministic") return "Settled by deterministic rules via PayPal Payouts";
  return "Settlement not yet recorded";
}

function renderReceipt(answer) {
  const receipt = answer.receipt || {};
  const sources = array(answer.sources);
  const batches = array(receipt.batches);
  return `<section class="receipt-section" aria-labelledby="receipt-title"><div class="receipt-caption">The fine print, made visible</div><div class="receipt">
    <header class="receipt-head"><span class="receipt-brand">footnote</span><h2 id="receipt-title">ROYALTY RECEIPT</h2><p>${escapeHTML(answer.id)} · ${escapeHTML(dateLabel(answer.createdAt, true))}</p><p>${sources.length} sources reviewed / USD</p></header>
    <div class="receipt-column-head"><span>Source / allocation</span><span>Royalty</span></div>
    ${sources.length ? sources.map(sourceRow).join("") : emptyState("No sources allocated.", "Any refund is recorded in the totals below.")}
    <dl class="receipt-totals"><dt>Paid to sources</dt><dd>${money(receipt.paidToSourcesCents)}</dd><dt>Refunded to your credits</dt><dd>${money(receipt.refundedCents)}</dd><dt class="total-label">KNOWLEDGE FEE</dt><dd class="total-value">${money(receipt.totalCents ?? answer.feeCents)}</dd></dl>
    <div class="receipt-settlement"><p>${escapeHTML(settlementLabel(receipt.settledBy))}</p>${batches.length ? `<ul class="receipt-batches">${batches.map(batch => `<li>Batch ${escapeHTML(batch.batchId)} ${statusPill(batch.status)}</li>`).join("")}</ul>` : '<p class="fine-print">No payout batches yet.</p>'}<p class="fine-print">Royalties below ${minimumPayout()} accrue until the payout minimum is reached.</p></div>
  </div><div class="receipt-bottom"><p>Thank you for funding the footnotes.</p><a href="#/ledger">View the global ledger →</a></div></section>`;
}

function feedbackRegion(feedback = "") {
  return `<div id="action-feedback" class="action-feedback" role="status" aria-live="polite">${feedback}</div>`;
}

function toolbar(includeSettlement = true) {
  const disabled = state.operation ? " disabled" : "";
  return `<div class="page-toolbar">
    ${includeSettlement ? `
      <button class="button button-small" type="button" data-operation="settle"${disabled}>Settle now</button>
      <button class="button button-secondary button-small" type="button" data-operation="sweep"${disabled}>Sweep expired escrow</button>` : ""}
    <button class="button button-secondary button-small" type="button" data-operation="refresh"${disabled}>Refresh payout statuses</button>
    ${includeSettlement ? `<span class="toolbar-note">Payout minimum: ${minimumPayout()}</span>` : ""}
  </div>`;
}

function dataTable(caption, columns, rows, empty) {
  if (!rows.length) return `<div class="table-frame">${empty}</div>`;
  const headings = columns.map(column => {
    const { label, amount } = typeof column === "string" ? { label: column } : column;
    return `<th scope="col"${amount ? ' class="amount"' : ""}>${escapeHTML(label)}</th>`;
  }).join("");
  return `<div class="table-frame">
    <div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHTML(caption)}; scroll horizontally for all columns">
      <table class="data-table">
        <caption class="sr-only">${escapeHTML(caption)}</caption>
        <thead><tr>${headings}</tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
  </div>`;
}

function creatorRow(creator, index) {
  return `<tr>
    <td><div class="creator-cell">
      <span class="creator-rank">${String(index + 1).padStart(2, "0")}</span>
      <div>
        <a class="creator-name" href="${creatorHref(creator.domain)}">${escapeHTML(creator.label || creator.domain)}</a>
        <div class="creator-domain">${escapeHTML(creator.domain)}</div>
      </div>
    </div></td>
    <td class="amount">${money(creator.earnedCents)}</td>
    <td class="amount">${money(creator.pendingCents)}</td>
    <td class="amount">${money(creator.escrowCents)}</td>
    <td class="amount">${number(creator.answers)}</td>
  </tr>`;
}

function renderCreators(creators, feedback = "") {
  const columns = ["Creator / domain", ...["Earned", "Pending", "Escrow", "Answers"].map(label => ({ label, amount: true }))];
  const leaderboard = dataTable("Creator royalties and answer counts", columns, creators.map(creatorRow),
    emptyState("The first royalty starts with a question.", "Ask Footnote something. The sources it cites will appear here."));
  dom.main.innerHTML = pageHeading("The people behind the answers", "Good work adds up.", "A public record of the creators who make answers possible, and the royalties their work earns.", `${creators.length} creator${creators.length === 1 ? "" : "s"}`)
    + toolbar() + feedbackRegion(feedback)
    + `<section aria-labelledby="leaderboard-title">
      <div class="section-heading"><h2 id="leaderboard-title">Creator leaderboard</h2><span class="eyebrow">Follow the contribution</span></div>
      ${leaderboard}
      ${creators.length ? '<p class="table-hint">Scroll the table to see every column.</p>' : ""}
    </section>
    ${renderDemoSites()}`;
}

function renderDemoSites() {
  const sites = array(state.config?.demoSites);
  const cards = sites.map((site, i) => `<article class="demo-card">
    <span class="eyebrow">Source ${String(i + 1).padStart(2, "0")}</span>
    <h3>${escapeHTML(site.title || site.slug)}</h3>
    <p>${escapeHTML(site.blurb || "Explore this source and its payee declaration.")}</p>
    ${externalLink(site.url, "Visit source", "demo-link")}
    ${methodBadge({ method: site.payeeMethod })}
  </article>`).join("");
  return `<section aria-labelledby="demo-title">
    <div class="section-heading"><h2 id="demo-title">Meet the sources.</h2><span class="eyebrow">Demo library</span></div>
    <p class="demo-intro">Independent voices, with a payment address in the fine print. Open a site to inspect its declaration, including the <code>footnote:paypal</code> meta tag where available.</p>
    ${sites.length ? `<div class="demo-grid">${cards}</div>` : emptyState("No demo sites available.", state.config ? "The demo library hasn't been configured." : "Reconnect to load the demo library.")}
  </section>`;
}

function stat(label, value, note) {
  return `<div class="stat"><span class="eyebrow">${escapeHTML(label)}</span><strong class="stat-value">${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`;
}

function claimPanel(creator) {
  return `<section class="claim-panel" aria-labelledby="claim-title">
    <div>
      <span class="eyebrow">Your work. Your royalties.</span>
      <h2 id="claim-title">Claim this domain.</h2>
      <p>${money(creator.escrowCents)} is held for ${escapeHTML(creator.domain)}. Add this exact declaration to the <code>&lt;head&gt;</code> of your site's homepage, replacing the example with your PayPal email.</p>
    </div>
    <div>
      <pre class="claim-code"><code>&lt;meta name="footnote:paypal" content="you@example.com"&gt;</code></pre>
      <p class="fine-print">Publish the change, then verify. Footnote checks your site's declaration and releases the escrow.</p>
      <button class="button button-small" type="button" data-operation="claim" data-domain="${escapeHTML(creator.domain)}"${state.operation ? " disabled" : ""}>Verify declaration <span aria-hidden="true">→</span></button>
      <div id="claim-feedback" role="status" aria-live="polite"></div>
    </div>
  </section>`;
}

function creatorCitation(answer) {
  return `<li class="citation-entry">
    <div class="citation-entry-top">
      <a class="citation-question" href="${answerHref(answer.answerId)}">${escapeHTML(answer.question)}</a>
      <span class="mono numeric">${money(answer.shareCents)}</span>
    </div>
    <p>${escapeHTML(answer.justification || "No attribution note supplied.")}</p>
    <div class="citation-entry-meta">
      <span>${percent(answer.sharePct)}% share</span>
      <time datetime="${escapeHTML(answer.createdAt)}">${escapeHTML(dateLabel(answer.createdAt))}</time>
      ${statusPill(answer.payoutStatus)}
    </div>
  </li>`;
}

function renderCreator(creator, feedback = "") {
  const answers = array(creator.answers);
  const payouts = array(creator.payouts);
  const claimable = number(creator.escrowCents) > 0 && (!creator.payeeMethod || creator.payeeMethod === "none");
  dom.main.innerHTML = `<a class="back-link" href="#/creators">← All creators</a>
    <div class="page-heading creator-heading"><div>
      <span class="eyebrow">Creator notebook</span>
      <h1>${escapeHTML(creator.label || creator.domain)}</h1>
      <p class="creator-domain">${escapeHTML(creator.domain)}</p>
      <div class="creator-method">${methodBadge({ method: creator.payeeMethod })}${creator.email ? `<span>${escapeHTML(creator.email)}</span>` : ""}</div>
    </div></div>
    <div class="stats-grid" aria-label="Creator totals">
      ${stat("Earned", money(creator.earnedCents), "Royalties earned")}
      ${stat("Pending", money(creator.pendingCents), "Awaiting settlement")}
      ${stat("In escrow", money(creator.escrowCents), "Held for this creator")}
      ${stat("Answers", String(answers.length), "Cited contributions")}
    </div>
    ${toolbar(false)}${feedbackRegion(feedback)}
    ${claimable ? claimPanel(creator) : ""}
    <section aria-labelledby="creator-answers-title">
      <div class="section-heading"><h2 id="creator-answers-title">In the footnotes</h2><span class="eyebrow">${answers.length} answer${answers.length === 1 ? "" : "s"}</span></div>
      ${answers.length ? `<ul class="citation-list">${answers.map(creatorCitation).join("")}</ul>` : emptyState("No citations yet.", "Answers that cite this creator will appear here with an attribution note.")}
    </section>
    <section aria-labelledby="payout-history-title">
      <div class="section-heading"><h2 id="payout-history-title">Payout history</h2><span class="eyebrow">The payment trail</span></div>
      ${payoutTable(payouts)}
    </section>`;
}

function payoutTable(payouts) {
  const rows = payouts.map(payout => `<tr>
    <td class="batch-id">${escapeHTML(payout.batchId || "—")}<div class="creator-domain">${escapeHTML(payout.itemId || "")}</div></td>
    <td><time datetime="${escapeHTML(payout.createdAt)}">${escapeHTML(dateLabel(payout.createdAt))}</time></td>
    <td>${statusPill(payout.status)}</td>
    <td class="amount">${money(payout.amountCents)}</td>
  </tr>`);
  return dataTable("Creator payout history", ["Batch / item", "Date", "Status", { label: "Amount", amount: true }], rows,
    emptyState("No payouts recorded.", `Royalties accrue until the ${minimumPayout()} minimum is reached. Settled payments will appear here.`));
}

function renderLedger(ledger, feedback = "") {
  const batches = array(ledger.batches);
  const rows = batches.map(batch => `<tr>
    <td class="batch-id">${escapeHTML(batch.batchId)}</td>
    <td><time datetime="${escapeHTML(batch.createdAt)}">${escapeHTML(dateLabel(batch.createdAt, true))}</time></td>
    <td>${statusPill(batch.status)}</td>
    <td class="amount">${number(batch.itemCount)}</td>
    <td class="amount">${money(batch.totalCents)}</td>
  </tr>`);
  const columns = ["Batch ID", "Created", "Status", { label: "Items", amount: true }, { label: "Total", amount: true }];
  const table = dataTable("Global payout batches", columns, rows,
    emptyState("A clean ledger, ready for its first entry.", "Payout batches appear when eligible creator royalties are settled."));
  dom.main.innerHTML = pageHeading("Nothing hidden in the fine print", "The open ledger.", "Every knowledge fee has a destination. Follow the money from questions to the people who inform the answers.")
    + `<div class="stats-grid ledger-stats" aria-label="Global ledger totals">
      ${stat("Knowledge fees", money(ledger.totalFeesCents), "All questions")}
      ${stat("Paid to sources", money(ledger.paidCents), "Source royalties")}
      ${stat("Accrued", money(ledger.accruedCents), `Below ${minimumPayout()} minimum`)}
      ${stat("In escrow", money(ledger.escrowCents), "Awaiting a creator claim")}
      ${stat("Refunded", money(ledger.refundedCents), "Returned to credits")}
    </div>
    <p class="ledger-note">Small royalties accumulate. Payees become eligible for settlement at ${minimumPayout()}. Unclaimed shares are held in escrow; expired escrow returns to the questioner's credits.</p>`
    + toolbar() + feedbackRegion(feedback)
    + `<section aria-labelledby="batches-title">
      <div class="section-heading"><h2 id="batches-title">Payout batches</h2><span class="eyebrow">${batches.length} batch${batches.length === 1 ? "" : "es"}</span></div>
      ${table}
      ${batches.length ? '<p class="table-hint">Scroll the table to see every column.</p>' : ""}
    </section>`;
}

function showFeedback(html, target = "action-feedback") {
  let region = document.getElementById(target);
  if (!region) {
    dom.main.insertAdjacentHTML("afterbegin", feedbackRegion());
    region = $("#action-feedback");
  }
  region.innerHTML = html;
}

async function performOperation(operation, button) {
  if (state.operation) return;
  const endpoints = { settle: "/api/settle", sweep: "/api/escrow/sweep", refresh: "/api/payouts/refresh", claim: "/api/claim" };
  if (!endpoints[operation]) return;
  const version = state.version;
  const target = operation === "claim" ? "claim-feedback" : "action-feedback";
  const domain = button.dataset.domain;
  const originalLabel = button.innerHTML;
  state.operation = operation;
  document.querySelectorAll("[data-operation]").forEach(control => { control.disabled = true; });
  button.textContent = operation === "claim" ? "Verifying…" : operation === "settle" ? "Settling royalties…" : operation === "sweep" ? "Sweeping escrow…" : "Refreshing…";
  showFeedback('<p class="muted">Working through the ledger…</p>', target);
  try {
    const data = await api(endpoints[operation], { method: "POST", ...(operation === "claim" ? { body: { domain } } : {}) });
    let message;
    if (operation === "claim") {
      if (!data.ok) {
        showFeedback(inlineError(data.message || "No payee declaration found. Publish the meta tag and verify again."), version === state.version ? target : "action-feedback");
        return;
      }
      message = [data.message || "Domain verified.", data.verifiedEmail ? `Payee: ${data.verifiedEmail}.` : "", `${money(data.releasedCents)} released from escrow.`, data.payout?.batchId ? `Batch ${data.payout.batchId} (${data.payout.status}).` : ""].filter(Boolean).join(" ");
    } else if (operation === "settle") {
      const batches = array(data.batches);
      message = [data.message, settlementLabel(data.settledBy), batches.length ? batches.map(batch => `Batch ${batch.batchId}: ${money(batch.totalCents)}, ${number(batch.itemCount)} items (${batch.status}).`).join(" ") : `No new batches. Eligible balances start at ${minimumPayout()}.`].filter(Boolean).join(" ");
    } else if (operation === "sweep") {
      message = `${number(data.count)} expired escrow ${number(data.count) === 1 ? "entry" : "entries"} swept. ${money(data.refundedCents)} refunded to credits.`;
    } else {
      message = `${number(data.updated)} payout ${number(data.updated) === 1 ? "status" : "statuses"} updated.`;
    }
    const feedback = `<div class="inline-success">${escapeHTML(message)}</div>`;
    if (version === state.version) await handleRoute({ feedback });
    else showFeedback(feedback);
    await refreshSession();
  } catch (error) {
    showFeedback(inlineError(errorMessage(error)), version === state.version ? target : "action-feedback");
  } finally {
    state.operation = null;
    document.querySelectorAll("[data-operation]").forEach(control => { control.disabled = false; });
    if (button.isConnected) button.innerHTML = originalLabel;
  }
}

function openCredits() {
  if (!state.config || dom.dialog.open) return;
  const packs = array(state.config.packs);
  dom.packs.innerHTML = '<legend class="sr-only">Credit pack</legend>' + packs.map((pack, i) => `<label class="pack-option"><input type="radio" name="packId" value="${escapeHTML(pack.id)}"${i === 0 ? " checked" : ""} required><span>${escapeHTML(pack.label)}</span><strong>${money(pack.cents)}</strong></label>`).join("");
  dom.checkoutError.hidden = Boolean(packs.length);
  dom.checkoutError.textContent = packs.length ? "" : "No credit packs are available. Try reconnecting to Footnote.";
  dom.checkoutSubmit.disabled = !packs.length;
  dom.checkoutMode.textContent = state.config.mode?.paypal === "simulator" ? "Simulator checkout. No real payment will be collected." : "PayPal sandbox checkout. Test funds only.";
  dom.dialog.showModal();
}

async function checkout(event) {
  event.preventDefault();
  if (state.checkoutBusy) return;
  const packId = new FormData(dom.creditForm).get("packId");
  if (!packId) return;
  state.checkoutBusy = true;
  dom.checkoutSubmit.disabled = true;
  dom.closeCredits.disabled = true;
  dom.checkoutSubmit.textContent = "Opening checkout…";
  dom.checkoutError.hidden = true;
  dom.creditForm.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/checkout/create", { method: "POST", body: { packId } });
    const approveUrl = safeURL(data?.approveUrl);
    if (!approveUrl) throw new Error("Checkout didn't return a valid approval link. Please try again.");
    location.href = approveUrl;
  } catch (error) {
    dom.checkoutError.textContent = errorMessage(error);
    dom.checkoutError.hidden = false;
  } finally {
    state.checkoutBusy = false;
    dom.checkoutSubmit.disabled = false;
    dom.closeCredits.disabled = false;
    dom.checkoutSubmit.innerHTML = 'Continue to PayPal <span aria-hidden="true">↗</span>';
    dom.creditForm.setAttribute("aria-busy", "false");
  }
}

function highlightSource(n) {
  const source = document.getElementById(`source-${n}`);
  if (!source) return;
  clearTimeout(highlightTimer);
  document.querySelectorAll(".source-row.is-highlighted").forEach(row => row.classList.remove("is-highlighted"));
  source.classList.add("is-highlighted");
  source.focus({ preventScroll: true });
  source.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  highlightTimer = setTimeout(() => source.classList.remove("is-highlighted"), 3000);
}

// Event delegation keeps route replacement independent of DOM references.
document.addEventListener("click", async event => {
  const citation = event.target.closest("[data-source]");
  if (citation) { event.preventDefault(); highlightSource(citation.dataset.source); return; }
  const sample = event.target.closest("[data-sample]");
  if (sample) {
    const question = array(state.config?.sampleQuestions)[number(sample.dataset.sample)];
    const field = $("#question");
    if (field && question) { field.value = question; state.draft.question = question; field.focus(); }
    return;
  }
  const operation = event.target.closest("[data-operation]");
  if (operation) { await performOperation(operation.dataset.operation, operation); return; }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "dismiss-toast") { clearTimeout(toastTimer); dom.toasts.innerHTML = ""; }
  if (action === "new-question") {
    state.draft.question = "";
    state.submittedQuestion = "";
    state.submittedAnswerId = null;
  }
  if (action === "reload-page") await handleRoute();
  if (action === "retry-session") {
    await refreshSession();
    // Preserve any question typed while the connection was unavailable.
    if (state.route?.name === "ask" && !state.route.answerId) renderAsk();
    else if (state.route?.name === "creators") await handleRoute();
  }
  if (action === "retry-answer" && state.answerId) {
    clearTimeout(state.pollTimer);
    state.answerError = "";
    const retryButton = event.target.closest("button");
    if (retryButton) { retryButton.disabled = true; retryButton.textContent = "Resuming…"; }
    await pollAnswer(state.answerId, state.version);
  }
});

document.addEventListener("submit", event => {
  if (event.target.id === "ask-form") { event.preventDefault(); void submitQuestion(event.target); }
});
document.addEventListener("input", event => {
  const { id, value } = event.target;
  if (id === "question") state.draft.question = value;
  if (id === "own-domain") state.draft.ownDomain = value;
  if (id === "fee") {
    state.draft.feeCents = number(value);
    const output = $("#fee-output");
    if (output) output.textContent = money(value);
    event.target.setAttribute("aria-valuetext", `${money(value)} knowledge fee`);
  }
});
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.id === "question") {
    event.preventDefault();
    $("#ask-form")?.requestSubmit();
  }
});
dom.addCredits.addEventListener("click", openCredits);
dom.closeCredits.addEventListener("click", () => dom.dialog.close());
dom.dialog.addEventListener("cancel", event => { if (state.checkoutBusy) event.preventDefault(); });
dom.dialog.addEventListener("close", () => dom.addCredits.focus());
dom.creditForm.addEventListener("submit", checkout);
$(".skip-link").addEventListener("click", event => { event.preventDefault(); dom.main.focus(); });
window.addEventListener("hashchange", () => { void handleRoute(); });

async function start() {
  await refreshSession();
  await handleRoute();
}
void start();
