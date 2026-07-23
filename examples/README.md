# NuralJS Examples

Production-grade examples demonstrating all NuralJS features, wired to `@nuraljs/core` via the workspace.

## Quick Start

```bash
# Install the whole monorepo first (from nuraljs_packages/)
pnpm install

# Run the basic example
pnpm --filter @nuraljs-examples/basic dev
# or: cd examples/basic && pnpm dev

# Run the full-featured API
pnpm --filter @nuraljs-examples/full-api dev
# or: cd examples/full-api && pnpm dev
```

Each example is a private workspace package (`@nuraljs-examples/*`) that depends on `@nuraljs/core` through `workspace:*`. Type-check either with `pnpm --filter @nuraljs-examples/<name> typecheck`.

---

## Basic Example

Simple hello world API demonstrating core features.

```bash
pnpm --filter @nuraljs-examples/basic dev
```

**Features:**

- Health check endpoint
- Query parameter validation
- POST body handling
- CORS/Helmet enabled
- Auto documentation at `/docs`

---

## Full-Featured API

Production-grade REST API with authentication and CRUD operations.

```bash
pnpm --filter @nuraljs-examples/full-api dev
```

### Project Structure

```
examples/full-api/
├── src/
│   ├── config/           # App configuration
│   │   ├── app.config.ts
│   │   └── error-handler.ts
│   ├── middleware/       # Auth middleware
│   │   └── auth.middleware.ts
│   ├── routes/           # API routes
│   │   ├── auth.routes.ts
│   │   ├── user.routes.ts
│   │   └── health.routes.ts
│   ├── schemas/          # Zod validation
│   │   ├── user.schema.ts
│   │   ├── auth.schema.ts
│   │   └── common.schema.ts
│   ├── services/         # Business logic
│   │   └── user.service.ts
│   └── server.ts         # Entry point
```

### Features

- 🔐 **Authentication** - JWT-style token middleware
- 👥 **CRUD Operations** - Full user management
- ✅ **Validation** - Zod schemas for all inputs
- ⚠️ **Error Handling** - Custom categorized errors
- 🔒 **Security** - CORS + Helmet configured
- 📚 **Documentation** - Auto-generated at `/docs`

### API Endpoints

| Method | Path        | Description      | Auth  |
| ------ | ----------- | ---------------- | ----- |
| GET    | /health     | Health check     | ❌    |
| POST   | /auth/login | Get access token | ❌    |
| GET    | /auth/me    | Current user     | ✅    |
| GET    | /users      | List users       | Admin |
| GET    | /users/:id  | Get user         | ✅    |
| POST   | /users      | Create user      | Admin |
| PATCH  | /users/:id  | Update user      | ✅    |
| DELETE | /users/:id  | Delete user      | Admin |

### Test Commands

```bash
# 1. Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}'

# Returns: {"accessToken":"user:550e8400-...","expiresIn":3600}

# 2. Get current user (use token from login)
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer user:550e8400-e29b-41d4-a716-446655440001"

# 3. List users (admin only)
curl http://localhost:3000/users \
  -H "Authorization: Bearer user:550e8400-e29b-41d4-a716-446655440001"

# 4. Create user
curl -X POST http://localhost:3000/users \
  -H "Authorization: Bearer user:550e8400-e29b-41d4-a716-446655440001" \
  -H "Content-Type: application/json" \
  -d '{"email":"new@example.com","name":"New User","password":"secret123"}'

# 5. View API documentation
open http://localhost:3000/docs
```

### Test Credentials

| Email             | Password | Role  |
| ----------------- | -------- | ----- |
| admin@example.com | admin123 | admin |
