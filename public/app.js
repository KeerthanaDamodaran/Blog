const postList = document.querySelector("#post-list");
const feedStatus = document.querySelector("#feed-status");
const emptyState = document.querySelector("#empty-state");
const authDialog = document.querySelector("#auth-dialog");
const editorDialog = document.querySelector("#editor-dialog");
const postDialog = document.querySelector("#post-dialog");
const toast = document.querySelector("#toast");

let currentUser = null;
let authMode = "login";
let editingPostId = null;
let activePostId = null;
let toastTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function getCookie(name) {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : "";
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = getCookie("blog_csrf");
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function formatDate(value) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function setUser(user) {
  currentUser = user;
  document.querySelector("#welcome").textContent = user ? `Hello, ${user.name}` : "";
  document.querySelector("#welcome").hidden = !user;
  document.querySelector("#write-button").hidden = !user;
  document.querySelector("#login-button").hidden = Boolean(user);
  document.querySelector("#register-button").hidden = Boolean(user);
  document.querySelector("#logout-button").hidden = !user;
}

async function loadPosts(search = "") {
  feedStatus.textContent = "Gathering stories...";
  emptyState.hidden = true;
  try {
    const data = await api(`/api/posts${search ? `?q=${encodeURIComponent(search)}` : ""}`);
    feedStatus.textContent = "";
    emptyState.hidden = data.posts.length > 0;
    postList.innerHTML = data.posts.map(renderPostCard).join("");
  } catch (error) {
    feedStatus.textContent = error.message;
  }
}

function renderPostCard(post) {
  const isOwner = currentUser && currentUser.id === post.author_id;
  const excerpt = post.body.length > 185 ? `${post.body.slice(0, 185).trim()}…` : post.body;
  return `
    <article class="post-card">
      <div class="post-meta">
        <span>${escapeHtml(post.author_name)}</span><span class="meta-dot"></span>
        <time datetime="${escapeHtml(post.created_at)}">${escapeHtml(formatDate(post.created_at))}</time>
      </div>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="post-excerpt">${escapeHtml(excerpt)}</p>
      <div class="post-card-bottom">
        <button class="read-link" type="button" data-open-post="${post.id}">Read story <span aria-hidden="true">↗</span></button>
        <div class="post-actions">
          <span class="card-comment-count">${post.comment_count} ${post.comment_count === 1 ? "comment" : "comments"}</span>
          ${isOwner ? `<button type="button" data-edit-post="${post.id}">Edit</button><button type="button" class="delete-post" data-delete-post="${post.id}">Delete</button>` : ""}
        </div>
      </div>
    </article>`;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  document.querySelector("#auth-title").textContent = registering ? "Join the conversation" : "Welcome back";
  document.querySelector("#auth-subtitle").textContent = registering ? "Create an account and share what you're thinking." : "Sign in to join the conversation.";
  document.querySelector("#name-field").hidden = !registering;
  document.querySelector("#name-field input").required = registering;
  document.querySelector("#auth-form [name=password]").autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#auth-submit").textContent = registering ? "Create account" : "Sign in";
  document.querySelector("#auth-switch-prompt").textContent = registering ? "Already a member?" : "New to Inkwell?";
  document.querySelector("#auth-switch").textContent = registering ? "Sign in" : "Create an account";
  document.querySelector("#auth-error").textContent = "";
}

function openAuth(mode = "login") {
  setAuthMode(mode);
  authDialog.showModal();
}

function openEditor(post) {
  editingPostId = post ? post.id : null;
  const form = document.querySelector("#editor-form");
  form.reset();
  form.elements.title.value = post ? post.title : "";
  form.elements.body.value = post ? post.body : "";
  document.querySelector("#editor-title").textContent = post ? "Edit your story" : "Write a story";
  document.querySelector("#editor-error").textContent = "";
  editorDialog.showModal();
  form.elements.title.focus();
}

async function openPost(postId) {
  activePostId = postId;
  try {
    const { post, comments } = await api(`/api/posts/${postId}`);
    const isOwner = currentUser && currentUser.id === post.author_id;
    const detail = document.querySelector("#post-detail");
    detail.innerHTML = `
      <button type="button" class="dialog-close" data-close-dialog aria-label="Close">×</button>
      <p class="eyebrow"><span class="eyebrow-line"></span> A story from the community</p>
      <h2>${escapeHtml(post.title)}</h2>
      <p class="detail-author">By ${escapeHtml(post.author_name)} <span aria-hidden="true">·</span> ${escapeHtml(formatDate(post.created_at))}</p>
      <div class="detail-body">${escapeHtml(post.body)}</div>
      ${isOwner ? `<div class="detail-controls"><button type="button" data-edit-post="${post.id}">Edit story</button><button type="button" class="danger-link" data-delete-post="${post.id}">Delete story</button></div>` : ""}
      <section class="comments">
        <h3>Conversation <span class="card-comment-count">(${comments.length})</span></h3>
        <div class="comment-list">${comments.length ? comments.map(renderComment).join("") : '<p class="signin-prompt">No comments yet. Start the conversation.</p>'}</div>
        ${currentUser ? `<form class="comment-form" data-comment-form="${post.id}"><label class="sr-only" for="comment-input">Write a comment</label><textarea id="comment-input" name="body" maxlength="2000" placeholder="Add your voice to the conversation..." required></textarea><button class="button button-dark" type="submit">Comment ↗</button></form>` : `<p class="signin-prompt"><button type="button" data-open-auth="login">Sign in</button> to leave a comment.</p>`}
      </section>`;
    postDialog.showModal();
  } catch (error) {
    showToast(error.message);
  }
}

function renderComment(comment) {
  const canDelete = currentUser && currentUser.id === comment.author_id;
  return `<article class="comment">
    <div class="comment-head"><span class="comment-author">${escapeHtml(comment.author_name)}</span>
      <time class="comment-date" datetime="${escapeHtml(comment.created_at)}">${escapeHtml(formatDate(comment.created_at))}</time>
      ${canDelete ? `<button class="comment-delete" type="button" data-delete-comment="${comment.id}">Delete</button>` : ""}
    </div>
    <p class="comment-body">${escapeHtml(comment.body)}</p>
  </article>`;
}

async function deletePost(postId) {
  if (!window.confirm("Delete this story and its comments? This cannot be undone.")) return;
  try {
    await api(`/api/posts/${postId}`, { method: "DELETE" });
    postDialog.close();
    await loadPosts(document.querySelector("#search-input").value.trim());
    showToast("Your story has been deleted.");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#login-button").addEventListener("click", () => openAuth("login"));
document.querySelector("#register-button").addEventListener("click", () => openAuth("register"));
document.querySelector("#write-button").addEventListener("click", () => openEditor());

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    setUser(null);
    await loadPosts(document.querySelector("#search-input").value.trim());
    showToast("You have signed out.");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#auth-switch").addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "register" : "login");
});

document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const errorElement = document.querySelector("#auth-error");
  errorElement.textContent = "";
  try {
    const endpoint = authMode === "register" ? "/api/register" : "/api/login";
    const { user } = await api(endpoint, { method: "POST", body: JSON.stringify(values) });
    setUser(user);
    authDialog.close();
    await loadPosts(document.querySelector("#search-input").value.trim());
    showToast(authMode === "register" ? "Welcome to Inkwell!" : "Welcome back.");
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

document.querySelector("#editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = JSON.stringify({ title: form.elements.title.value, body: form.elements.body.value });
  const endpoint = editingPostId ? `/api/posts/${editingPostId}` : "/api/posts";
  const method = editingPostId ? "PUT" : "POST";
  const errorElement = document.querySelector("#editor-error");
  errorElement.textContent = "";
  try {
    await api(endpoint, { method, body: payload });
    editorDialog.close();
    await loadPosts(document.querySelector("#search-input").value.trim());
    if (activePostId && postDialog.open) await openPost(activePostId);
    showToast(editingPostId ? "Your story has been updated." : "Your story is live.");
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadPosts(document.querySelector("#search-input").value.trim());
});

postList.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-post]");
  const editButton = event.target.closest("[data-edit-post]");
  const deleteButton = event.target.closest("[data-delete-post]");
  if (openButton) await openPost(Number(openButton.dataset.openPost));
  if (editButton) {
    try {
      const { post } = await api(`/api/posts/${editButton.dataset.editPost}`);
      openEditor(post);
    } catch (error) { showToast(error.message); }
  }
  if (deleteButton) await deletePost(Number(deleteButton.dataset.deletePost));
});

document.querySelector("#post-detail").addEventListener("click", async (event) => {
  const closeButton = event.target.closest("[data-close-dialog]");
  const authButton = event.target.closest("[data-open-auth]");
  const editButton = event.target.closest("[data-edit-post]");
  const deleteButton = event.target.closest("[data-delete-post]");
  const commentDelete = event.target.closest("[data-delete-comment]");
  if (closeButton) postDialog.close();
  if (authButton) {
    postDialog.close();
    openAuth(authButton.dataset.openAuth);
  }
  if (editButton) {
    try {
      const { post } = await api(`/api/posts/${editButton.dataset.editPost}`);
      openEditor(post);
    } catch (error) { showToast(error.message); }
  }
  if (deleteButton) await deletePost(Number(deleteButton.dataset.deletePost));
  if (commentDelete) {
    try {
      await api(`/api/comments/${commentDelete.dataset.deleteComment}`, { method: "DELETE" });
      await openPost(activePostId);
      await loadPosts(document.querySelector("#search-input").value.trim());
    } catch (error) { showToast(error.message); }
  }
});

document.querySelector("#post-detail").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-comment-form]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api(`/api/posts/${form.dataset.commentForm}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: form.elements.body.value }),
    });
    await openPost(activePostId);
    await loadPosts(document.querySelector("#search-input").value.trim());
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

for (const dialog of [authDialog, editorDialog, postDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function initialize() {
  try {
    const { user } = await api("/api/me");
    setUser(user);
  } catch (error) {
    feedStatus.textContent = error.message;
  }
  await loadPosts();
}

initialize();
