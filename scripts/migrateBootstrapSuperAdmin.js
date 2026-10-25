import 'dotenv/config';
import { connectDB } from '../src/config/db.js';
import AdminUser from '../src/models/AdminUser.js';

if (!process.env.SUPER_ADMIN_EMAIL) {
  throw new Error('SUPER_ADMIN_EMAIL is required');
}

await connectDB();

const email = process.env.SUPER_ADMIN_EMAIL.trim().toLowerCase();
const user = await AdminUser.findOne({ email, role: 'SUPER_ADMIN' });

if (!user) {
  console.log(`No Super Admin found for ${email}. Nothing was changed.`);
  process.exit(1);
}

user.mustChangePassword = false;
user.temporaryPasswordExpiresAt = null;
user.passwordChangedAt = user.passwordChangedAt || new Date();
await user.save();

console.log(`Bootstrap Super Admin ${email} updated. Forced initial password setup is disabled.`);
process.exit(0);
