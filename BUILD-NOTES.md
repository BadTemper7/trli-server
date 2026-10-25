# Build Notes

- Added separate AdminUser authentication and authorization; ClientUser authentication remains unchanged.
- Added AdminAuditLog, forced first-login password setup, temporary-password expiry/reissue and Super Admin bootstrap script.
- Operational Admin routes use module/action permission middleware and first-login restrictions.
- Socket.IO admin subscriptions are permission-aware and support live permission changes and deactivation/reset events.
- Storage capacity is bounded by physical slots and displays TEU for 20FT / FEU for 40FT.
- All server JavaScript files pass `node --check`.
- Runtime MongoDB/SMTP verification still requires valid local `.env` credentials and services.

## Bootstrap Super Admin revision

The first seeded Super Admin is now an explicit exception to the temporary-password workflow:

- `mustChangePassword = false`
- `temporaryPasswordExpiresAt = null`
- `passwordChangedAt` is set when seeded
- login goes directly to the authorized Admin Dashboard

All Admin Users created later through User Management still use generated temporary passwords and mandatory first-login password setup.

For an existing bootstrap Super Admin created with an older build, run:

```bash
npm run migrate:bootstrap-super-admin
```

The migration uses `SUPER_ADMIN_EMAIL` and does not change the existing password.
