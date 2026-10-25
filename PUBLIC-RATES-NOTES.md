# Public Rates API

Added `GET /api/rates` as a read-only public endpoint for the Client website.

Security behavior:
- returns ACTIVE rates only
- does not expose createdBy / updatedBy
- does not expose inactive rate setup records
- does not allow create, edit, or delete operations
- Admin Rate Setup remains protected under `/api/admin/rates`
