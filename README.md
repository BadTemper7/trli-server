# Trans Roadway Logistics Server

Node.js + Express + MongoDB/Mongoose + Socket.IO backend for the Client Portal and Admin Dashboard.

## Setup

1. Copy `.env.example` to `.env`.
2. Configure MongoDB, JWT secrets, client/admin origins, SMTP and the bootstrap Super Admin values.
3. Install dependencies with `npm install`.
4. Create the first Super Admin once with `npm run seed:super-admin`.
5. Start development with `npm run dev`.

The bootstrap Super Admin is created only when no Super Admin exists. Its password is bcrypt-hashed and is treated as the permanent password for this first account. The bootstrap Super Admin is the exception to the temporary-password first-login flow.

## Required local origins

```env
CLIENT_URL=http://localhost:5173
ADMIN_URL=http://localhost:5174
ADMIN_LOGIN_URL=http://localhost:5174/login
```

## Initial Super Admin

```env
SUPER_ADMIN_FIRST_NAME=System
SUPER_ADMIN_LAST_NAME=Administrator
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=replace-with-a-strong-bootstrap-password
```

Then run:

```bash
npm run seed:super-admin
```

The seeded bootstrap Super Admin can log in directly to the Admin Dashboard and is not redirected to `/setup-password`. Every Admin User created afterward through User Management still receives a temporary password and must create a permanent password on first login.

If you already seeded a Super Admin using an older build that set `mustChangePassword=true`, run:

```bash
npm run migrate:bootstrap-super-admin
```

This only updates the matching `SUPER_ADMIN_EMAIL` account setup flags. It does not change its password.

## Admin authentication

Admin authentication is separate from Client Portal authentication and uses an HTTP-only `adminToken` cookie.

```text
POST /api/admin/auth/login
GET  /api/admin/auth/me
POST /api/admin/auth/change-initial-password
POST /api/admin/auth/logout
```

There is no `ADMIN_API_KEY` requirement anymore.

## User Management

Admin users are created without a password field. The server generates a cryptographically secure temporary password, stores only its bcrypt hash, gives it a 24-hour expiration, and emails it through Nodemailer. Admin users must create their permanent password after first login.

```text
GET    /api/admin/users
GET    /api/admin/users/:id
POST   /api/admin/users
PUT    /api/admin/users/:id
PATCH  /api/admin/users/:id/status
PUT    /api/admin/users/:id/permissions
POST   /api/admin/users/:id/reissue-temporary-password
```

Permissions are enforced in the backend. `SUPER_ADMIN` is an unrestricted override. The last active Super Admin cannot be deactivated or demoted.

## Storage Monitoring

Storage routes require Admin authentication plus `STORAGE_MONITORING` action permissions. Block capacity is expressed as TEU for 20FT blocks and FEU for 40FT blocks. Capacity cannot exceed physical slots (`bays × rows × tiers`).

## Development seed

`npm run seed` creates sample client/storage data only and must not be used in production.

## Validation

```bash
npm run check
```

## Rate Setup API

Rate Setup is persisted in MongoDB through the `Rate` model. Admin routes are mounted at `/api/admin/rates` and use normal Admin authentication plus granular `RATE_SETUP` permissions. Supported rate types include Lift On, Lift Off, Storage, and Other, with Local/International, Empty/Loaded, 20FT/40FT/All Sizes, amount, Gate-in/Gate-out collection point, and status.
