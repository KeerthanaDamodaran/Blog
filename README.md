# Inkwell

A small, full-stack blogging platform for publishing stories and discussing them in comments.

## Run locally

Requires Node.js 22.5 or newer (uses the built-in SQLite module).

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). The SQLite database is created as `blog.sqlite` in the project directory. No package installation is required.

For a development server that restarts on file changes, use `npm run dev`. Run the API tests with `npm test`.

## Features

- Account registration, sign-in, and sign-out, with scrypt password hashes and expiring HTTP-only session cookies.
- Create, edit, and delete your own posts; browse and search community stories.
- Read and delete your own comments, and add comments to any story when signed in.
- SQLite persistence and JSON REST endpoints under `/api`.
- SameSite cookies, CSRF token checks, request size limits, input validation, and ownership checks.

For an HTTPS deployment behind a proxy, set `SITE_ORIGIN` to the exact public origin (for example `https://blog.example.com`) and configure TLS and secure cookie handling at the proxy.

## API overview

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/posts?q=...`, `POST /api/posts`
- `GET /api/posts/:id`, `PUT /api/posts/:id`, `DELETE /api/posts/:id`
- `POST /api/posts/:id/comments`, `DELETE /api/comments/:id`

Mutating endpoints require the `blog_csrf` cookie value in the `X-CSRF-Token` header. Fetch `GET /api/me` first to initialize the token cookie.
