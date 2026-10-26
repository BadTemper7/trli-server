import 'dotenv/config';
import bcrypt from 'bcrypt';
import { connectDB } from '../src/config/db.js';
import AdminUser from '../src/models/AdminUser.js';

const required = [
  'SUPER_ADMIN_FIRST_NAME',
  'SUPER_ADMIN_LAST_NAME',
  'SUPER_ADMIN_EMAIL',
  'SUPER_ADMIN_PASSWORD',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

await connectDB();

const existing = await AdminUser.findOne({ role: 'SUPER_ADMIN' });
if (existing) {
  console.log('A Super Admin already exists. No account was created.');
  process.exit(0);
}

const user = await AdminUser.create({
  firstName: process.env.SUPER_ADMIN_FIRST_NAME.trim(),
  lastName: process.env.SUPER_ADMIN_LAST_NAME.trim(),
  email: process.env.SUPER_ADMIN_EMAIL.trim().toLowerCase(),
  passwordHash: await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, 12),
  role: 'SUPER_ADMIN',
  isSystemProtected:true,
  status: 'ACTIVE',
  permissions: [],

  // Bootstrap exception: the first seeded Super Admin uses the permanent
  // password supplied through the environment and is not forced through
  // the temporary-password setup flow used by subsequently created users.
  mustChangePassword: false,
  temporaryPasswordExpiresAt: null,
  passwordChangedAt: new Date(),
});

console.log(`Super Admin created for ${user.email}. The bootstrap Super Admin can log in directly.`);
process.exit(0);
