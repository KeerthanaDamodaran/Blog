const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");

let server;
let baseUrl;
let temporaryDirectory;
let csrf;

function cookiesFrom(response) {
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
  return cookies;
}

function getCookie(name, cookieHeader) {
  const value = cookieHeader.split("; ").find((cookie) => cookie.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : "";
}

async function request(endpoint, { method = "GET", body, cookie = "", token = csrf } = {}) {
  const headers = {};
  const cookieHeader = [cookie, csrf ? `blog_csrf=${csrf}` : ""].filter(Boolean).join("; ");
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = token;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data, cookies: cookiesFrom(response) };
}

async function register(name, email) {
  const result = await request("/api/register", {
    method: "POST",
    body: { name, email, password: "passphrase123" },
  });
  assert.equal(result.response.status, 201);
  const sessionCookie = result.cookies.find((cookie) => cookie.startsWith("blog_session="));
  return { user: result.data.user, cookie: sessionCookie };
}

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-test-"));
  server = createServer({ databasePath: path.join(temporaryDirectory, "test.sqlite") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const initial = await request("/api/me");
  csrf = getCookie("blog_csrf", initial.cookies.join("; "));
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("registers users, publishes posts, and supports comments", async () => {
  const author = await register("Avery Writer", "avery@example.test");
  const postResponse = await request("/api/posts", {
    method: "POST",
    cookie: author.cookie,
    body: { title: "A thoughtful beginning", body: "A story from the road." },
  });
  assert.equal(postResponse.response.status, 201);

  const reader = await register("Riley Reader", "riley@example.test");
  const commentResponse = await request(`/api/posts/${postResponse.data.post.id}/comments`, {
    method: "POST",
    cookie: reader.cookie,
    body: { body: "Thank you for sharing this." },
  });
  assert.equal(commentResponse.response.status, 201);

  const detail = await request(`/api/posts/${postResponse.data.post.id}`);
  assert.equal(detail.data.comments.length, 1);
  assert.equal(detail.data.comments[0].author_name, "Riley Reader");
});

test("serves the app and rejects duplicate account emails", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stories are better/);

  await register("Morgan Writer", "morgan@example.test");
  const duplicate = await request("/api/register", {
    method: "POST",
    body: { name: "Morgan Again", email: "morgan@example.test", password: "passphrase123" },
  });
  assert.equal(duplicate.response.status, 409);
});

test("prevents other users from editing or deleting a post", async () => {
  const author = await register("Casey Author", "casey@example.test");
  const other = await register("Jordan Reader", "jordan@example.test");
  const created = await request("/api/posts", {
    method: "POST",
    cookie: author.cookie,
    body: { title: "Private ownership", body: "Only the author can edit this." },
  });
  const response = await request(`/api/posts/${created.data.post.id}`, {
    method: "PUT",
    cookie: other.cookie,
    body: { title: "Changed title", body: "Changed body" },
  });
  assert.equal(response.response.status, 403);
});

test("rejects state-changing requests without a matching CSRF token", async () => {
  const response = await request("/api/register", {
    method: "POST",
    token: "not-the-cookie-token",
    body: { name: "Taylor Writer", email: "taylor@example.test", password: "passphrase123" },
  });
  assert.equal(response.response.status, 403);
});
