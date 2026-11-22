const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { promisify } = require("node:util");
const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT) || 3000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function createDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS comments_post_id_idx ON comments(post_id, created_at);
  `);
  return db;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return cookies;
}

function appendCookie(response, cookie) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current ? [...current, cookie] : [cookie]);
}

function cookieOptions(request, siteOrigin) {
  const secure = request.socket.encrypted || (siteOrigin && siteOrigin.startsWith("https://"));
  return `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (bytes === 0) {
    const error = new Error("A JSON request body is required.");
    error.status = 400;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validString(value, minLength, maxLength) {
  return typeof value === "string" && value.trim().length >= minLength && value.trim().length <= maxLength;
}

function getUser(db, userId) {
  return db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) || null;
}

function createServer({ databasePath = path.join(__dirname, "blog.sqlite"), siteOrigin } = {}) {
  const db = createDatabase(databasePath);

  async function handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const cookies = readCookies(request);
    const isApi = url.pathname.startsWith("/api/");

    if (!isApi) {
      serveStatic(url.pathname, response);
      return;
    }

    if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
      response.setHeader("Allow", "GET, POST, PUT, DELETE");
      sendError(response, 405, "Method not allowed.");
      return;
    }

    const csrfCookie = cookies.blog_csrf;
    if (!csrfCookie) {
      const token = randomBytes(24).toString("hex");
      appendCookie(response, `blog_csrf=${token}; ${cookieOptions(request, siteOrigin)}`);
    }

    let user = null;
    const sessionToken = cookies.blog_session;
    if (sessionToken) {
      const session = db.prepare(`
        SELECT user_id FROM sessions
        WHERE token_hash = ? AND expires_at > ?
      `).get(hashToken(sessionToken), Math.floor(Date.now() / 1000));
      if (session) user = getUser(db, session.user_id);
    }

    const isMutation = ["POST", "PUT", "DELETE"].includes(request.method);
    if (isMutation) {
      const origin = request.headers.origin;
      const expectedOrigin = siteOrigin || `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
      if (origin && origin !== expectedOrigin) {
        sendError(response, 403, "Requests from this origin are not allowed.");
        return;
      }
      const headerToken = request.headers["x-csrf-token"];
      const cookieToken = cookies.blog_csrf;
      const headerBuffer = Buffer.from(typeof headerToken === "string" ? headerToken : "");
      const cookieBuffer = Buffer.from(typeof cookieToken === "string" ? cookieToken : "");
      if (headerBuffer.length === 0 || headerBuffer.length !== cookieBuffer.length ||
          !timingSafeEqual(headerBuffer, cookieBuffer)) {
        sendError(response, 403, "Invalid CSRF token. Refresh the page and try again.");
        return;
      }
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/me") {
        sendJson(response, 200, { user });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/register") {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!validString(name, 2, 60)) {
          sendError(response, 400, "Name must be between 2 and 60 characters.");
          return;
        }
        if (!EMAIL_PATTERN.test(email) || email.length > 254) {
          sendError(response, 400, "Enter a valid email address.");
          return;
        }
        if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
          sendError(response, 400, "Password must be between 8 and 128 characters.");
          return;
        }
        const salt = randomBytes(16);
        const derivedKey = await scrypt(body.password, salt, 64);
        let result;
        try {
          result = db.prepare(`
            INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)
          `).run(name, email, `${salt.toString("hex")}:${derivedKey.toString("hex")}`);
        } catch (error) {
          if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" ||
              (error.errcode & 0xff) === 19 && error.message.includes("users.email")) {
            sendError(response, 409, "An account with that email already exists.");
            return;
          }
          throw error;
        }
        user = getUser(db, Number(result.lastInsertRowid));
        createSession(db, user.id, request, response, siteOrigin);
        sendJson(response, 201, { user });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/login") {
        const body = await readJson(request);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const record = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
        if (!record || typeof body.password !== "string" || !(await verifyPassword(body.password, record.password_hash))) {
          sendError(response, 401, "Email or password is incorrect.");
          return;
        }
        user = getUser(db, record.id);
        createSession(db, user.id, request, response, siteOrigin);
        sendJson(response, 200, { user });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        if (sessionToken) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(sessionToken));
        const options = cookieOptions(request, siteOrigin);
        appendCookie(response, `blog_session=; ${options}; HttpOnly; Max-Age=0`);
        sendJson(response, 200, { user: null });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/posts") {
        const search = (url.searchParams.get("q") || "").trim();
        const query = `
          SELECT p.id, p.title, p.body, p.created_at, p.updated_at,
                 u.id AS author_id, u.name AS author_name,
                 (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
          FROM posts p JOIN users u ON u.id = p.user_id
          ${search ? "WHERE p.title LIKE ? OR p.body LIKE ?" : ""}
          ORDER BY p.created_at DESC, p.id DESC LIMIT 100
        `;
        const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
        const rows = search
          ? db.prepare(query).all(pattern, pattern)
          : db.prepare(query).all();
        sendJson(response, 200, { posts: rows });
        return;
      }

      const postMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);
      if (postMatch) {
        const postId = Number(postMatch[1]);
        if (request.method === "GET") {
          const post = db.prepare(`
            SELECT p.id, p.title, p.body, p.created_at, p.updated_at,
                   u.id AS author_id, u.name AS author_name
            FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?
          `).get(postId);
          if (!post) {
            sendError(response, 404, "Post not found.");
            return;
          }
          const comments = db.prepare(`
            SELECT c.id, c.body, c.created_at, c.user_id AS author_id, u.name AS author_name
            FROM comments c JOIN users u ON u.id = c.user_id
            WHERE c.post_id = ? ORDER BY c.created_at, c.id
          `).all(postId);
          sendJson(response, 200, { post, comments });
          return;
        }
        if (!user) {
          sendError(response, 401, "Sign in to manage posts.");
          return;
        }
        const existing = db.prepare("SELECT id, user_id FROM posts WHERE id = ?").get(postId);
        if (!existing) {
          sendError(response, 404, "Post not found.");
          return;
        }
        if (existing.user_id !== user.id) {
          sendError(response, 403, "You can only manage your own posts.");
          return;
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          if (!validString(body.title, 3, 120) || !validString(body.body, 1, 20000)) {
            sendError(response, 400, "Title must be 3-120 characters and post content 1-20,000 characters.");
            return;
          }
          db.prepare(`
            UPDATE posts SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?
          `).run(body.title.trim(), body.body.trim(), postId);
          sendJson(response, 200, { post: { ...existing, title: body.title.trim(), body: body.body.trim() } });
          return;
        }
        if (request.method === "DELETE") {
          db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
          sendJson(response, 200, { deleted: true });
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/posts") {
        if (!user) {
          sendError(response, 401, "Sign in to publish a post.");
          return;
        }
        const body = await readJson(request);
        if (!validString(body.title, 3, 120) || !validString(body.body, 1, 20000)) {
          sendError(response, 400, "Title must be 3-120 characters and post content 1-20,000 characters.");
          return;
        }
        const result = db.prepare("INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)")
          .run(user.id, body.title.trim(), body.body.trim());
        sendJson(response, 201, { post: { id: Number(result.lastInsertRowid), title: body.title.trim(), body: body.body.trim() } });
        return;
      }

      const commentsMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (request.method === "POST" && commentsMatch) {
        if (!user) {
          sendError(response, 401, "Sign in to leave a comment.");
          return;
        }
        const postId = Number(commentsMatch[1]);
        if (!db.prepare("SELECT id FROM posts WHERE id = ?").get(postId)) {
          sendError(response, 404, "Post not found.");
          return;
        }
        const body = await readJson(request);
        if (!validString(body.body, 1, 2000)) {
          sendError(response, 400, "Comment must be between 1 and 2,000 characters.");
          return;
        }
        const result = db.prepare("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)")
          .run(postId, user.id, body.body.trim());
        sendJson(response, 201, { comment: { id: Number(result.lastInsertRowid), body: body.body.trim(), author_id: user.id, author_name: user.name } });
        return;
      }

      const commentMatch = url.pathname.match(/^\/api\/comments\/(\d+)$/);
      if (request.method === "DELETE" && commentMatch) {
        if (!user) {
          sendError(response, 401, "Sign in to delete a comment.");
          return;
        }
        const commentId = Number(commentMatch[1]);
        const comment = db.prepare("SELECT id, user_id FROM comments WHERE id = ?").get(commentId);
        if (!comment) {
          sendError(response, 404, "Comment not found.");
          return;
        }
        if (comment.user_id !== user.id) {
          sendError(response, 403, "You can only delete your own comments.");
          return;
        }
        db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
        sendJson(response, 200, { deleted: true });
        return;
      }

      sendError(response, 404, "API route not found.");
    } catch (error) {
      if (error.status) {
        sendError(response, error.status, error.message);
        return;
      }
      console.error("API request failed:", error);
      sendError(response, 500, "An unexpected server error occurred.");
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("Request failed:", error);
      if (!response.headersSent) sendError(response, 500, "An unexpected server error occurred.");
      else response.destroy();
    });
  });
  server.database = db;
  return server;
}

function createSession(db, userId, request, response, siteOrigin) {
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, now + SESSION_TTL_SECONDS);
  appendCookie(response, `blog_session=${token}; ${cookieOptions(request, siteOrigin)}; HttpOnly; Max-Age=${SESSION_TTL_SECONDS}`);
}

async function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = storedHash.split(":");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendError(response, 403, "Forbidden.");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") {
        sendError(response, 404, "Not found.");
        return;
      }
      console.error("Static file read failed:", error);
      sendError(response, 500, "Unable to load this page.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    response.end(content);
  });
}

if (require.main === module) {
  const server = createServer({ siteOrigin: process.env.SITE_ORIGIN });
  server.listen(PORT, () => {
    console.log(`Inkwell is running at http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
