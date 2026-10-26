import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import AdminUser from '../models/AdminUser.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { AppError, asyncHandler, ok } from '../utils/http.js';
import { isStrongPassword } from '../utils/adminPassword.js';

const secret = () => process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
const cookieOptions = () => ({ httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:process.env.NODE_ENV==='production'?'none':'lax', maxAge: Number(process.env.ADMIN_SESSION_HOURS || 12)*3600*1000, path:'/' });
function sign(admin){return jwt.sign({sub:String(admin._id),type:'admin',tv:admin.tokenVersion||0},secret(),{expiresIn:process.env.ADMIN_JWT_EXPIRES_IN||'12h'})}
function safe(admin){const obj=admin.toObject();delete obj.passwordHash;obj.isSystemProtected=Boolean(admin.isSystemProtected||(process.env.SUPER_ADMIN_EMAIL && admin.role==='SUPER_ADMIN' && admin.email===process.env.SUPER_ADMIN_EMAIL.trim().toLowerCase()));return obj}

export const login = asyncHandler(async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  const password=String(req.body.password||'');
  const admin=await AdminUser.findOne({email}).select('+passwordHash');
  if(!admin || !(await bcrypt.compare(password,admin.passwordHash))) throw new AppError('Invalid email or password.',401);
  if(admin.status!=='ACTIVE') throw new AppError('This administrator account is inactive.',403);
  if(admin.mustChangePassword && admin.temporaryPasswordExpiresAt && admin.temporaryPasswordExpiresAt < new Date()) {
    throw new AppError('Temporary Password Expired',403);
  }
  admin.lastLoginAt=new Date(); await admin.save();
  res.cookie('adminToken',sign(admin),cookieOptions());
  ok(res,{user:safe(admin),requiresPasswordChange:Boolean(admin.mustChangePassword)},admin.mustChangePassword?'Password setup required.':'Login successful.');
});

export const logout=asyncHandler(async(req,res)=>{res.clearCookie('adminToken',{...cookieOptions(),maxAge:0});ok(res,{},'Logged out.')});
export const me=asyncHandler(async(req,res)=>ok(res,{user:safe(req.admin),requiresPasswordChange:Boolean(req.admin.mustChangePassword)}));
export const changeInitialPassword=asyncHandler(async(req,res)=>{
  const password=String(req.body.password||''), confirm=String(req.body.confirmPassword||'');
  if(!req.admin.mustChangePassword) throw new AppError('Initial password setup has already been completed.',409);
  if(password!==confirm) throw new AppError('Passwords do not match.',400);
  if(!isStrongPassword(password)) throw new AppError('Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',400);
  const admin=await AdminUser.findById(req.admin._id).select('+passwordHash');
  if(await bcrypt.compare(password,admin.passwordHash)) throw new AppError('Your new password must be different from the temporary password.',400);
  admin.passwordHash=await bcrypt.hash(password,12); admin.mustChangePassword=false; admin.passwordChangedAt=new Date(); admin.temporaryPasswordExpiresAt=null; admin.tokenVersion+=1; await admin.save();
  await auditAdminAction({performedBy:admin._id,targetUser:admin._id,action:'INITIAL_PASSWORD_CHANGED'});
  res.cookie('adminToken',sign(admin),cookieOptions());
  ok(res,{user:safe(admin)},'Password created successfully.');
});
