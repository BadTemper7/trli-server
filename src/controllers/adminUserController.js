import bcrypt from 'bcrypt';
import AdminUser from '../models/AdminUser.js';
import { MODULE_ACTIONS, normalizePermissions } from '../constants/permissions.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { sendAdminTemporaryPassword } from '../services/emailService.js';
import { emitToAdminUser, disconnectAdminUser, refreshAdminUserRooms } from '../socket/index.js';
import { AppError, asyncHandler, ok } from '../utils/http.js';
import { generateTemporaryPassword } from '../utils/adminPassword.js';

const emailRe=/^\S+@\S+\.\S+$/;
const safe=(u)=>{const o=u.toObject();delete o.passwordHash;o.isSystemProtected=isProtectedAdmin(u);return o};
const accountSetup=(u)=>!u.mustChangePassword?'COMPLETED':(u.temporaryPasswordExpiresAt && u.temporaryPasswordExpiresAt<new Date()?'TEMPORARY_PASSWORD_EXPIRED':'PASSWORD_SETUP_PENDING');
async function activeSuperCount(){return AdminUser.countDocuments({role:'SUPER_ADMIN',status:'ACTIVE'});}
export function isProtectedAdmin(target){return Boolean(target?.isSystemProtected || (process.env.SUPER_ADMIN_EMAIL && String(target?.email||'').toLowerCase()===process.env.SUPER_ADMIN_EMAIL.trim().toLowerCase() && target?.role==='SUPER_ADMIN'));}
function ensureCanTarget(actor,target){if(isProtectedAdmin(target))throw new AppError('The designated system Super Admin is read-only in User Management.',403);if(actor.role!=='SUPER_ADMIN' && target.role==='SUPER_ADMIN')throw new AppError('Only a Super Admin can manage another Super Admin.',403)}

export const permissionCatalog=asyncHandler(async(req,res)=>ok(res,{modules:MODULE_ACTIONS}));
export const listUsers=asyncHandler(async(req,res)=>{
  const filter={}; const search=String(req.query.search||'').trim();
  if(search) filter.$or=[{firstName:{$regex:search,$options:'i'}},{lastName:{$regex:search,$options:'i'}},{email:{$regex:search,$options:'i'}}];
  if(['SUPER_ADMIN','ADMIN_USER'].includes(req.query.role))filter.role=req.query.role;
  if(['ACTIVE','INACTIVE'].includes(req.query.status))filter.status=req.query.status;
  if(req.query.module)filter.permissions={$elemMatch:{module:String(req.query.module).toUpperCase()}};
  const rows=await AdminUser.find(filter).sort({createdAt:-1});
  ok(res,{items:rows.map(u=>({...safe(u),accountSetup:accountSetup(u)}))});
});
export const getUser=asyncHandler(async(req,res)=>{const u=await AdminUser.findById(req.params.id);if(!u)throw new AppError('Admin user not found.',404);ok(res,{user:{...safe(u),accountSetup:accountSetup(u)}})});

export const createUser=asyncHandler(async(req,res)=>{
  const b=req.body; const role=String(b.role||'ADMIN_USER').toUpperCase(); const status=String(b.status||'ACTIVE').toUpperCase(); const email=String(b.email||'').trim().toLowerCase();
  if(b.isSystemProtected!==undefined || (process.env.SUPER_ADMIN_EMAIL && email===process.env.SUPER_ADMIN_EMAIL.trim().toLowerCase()))throw new AppError('The protected system identity cannot be created or assigned through User Management.',403);
  if(!b.firstName||!b.lastName||!emailRe.test(email))throw new AppError('First name, last name, and a valid email are required.',400);
  if(!['SUPER_ADMIN','ADMIN_USER'].includes(role)||!['ACTIVE','INACTIVE'].includes(status))throw new AppError('Invalid role or status.',400);
  if(role==='SUPER_ADMIN'&&req.admin.role!=='SUPER_ADMIN')throw new AppError('Only a Super Admin can create another Super Admin.',403);
  if(await AdminUser.exists({email}))throw new AppError('An admin user with this email already exists.',409);
  const temporaryPassword=generateTemporaryPassword(); const expires=new Date(Date.now()+24*3600*1000);
  const user=await AdminUser.create({firstName:String(b.firstName).trim(),middleName:String(b.middleName||'').trim(),lastName:String(b.lastName).trim(),suffix:String(b.suffix||'').trim(),email,phoneNumber:String(b.phoneNumber||'').trim(),position:String(b.position||'').trim(),passwordHash:await bcrypt.hash(temporaryPassword,12),role,status,permissions:role==='SUPER_ADMIN'?[]:normalizePermissions(b.permissions),mustChangePassword:true,temporaryPasswordExpiresAt:expires,createdBy:req.admin._id,updatedBy:req.admin._id});
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:role==='SUPER_ADMIN'?'SUPER_ADMIN_CREATED':'USER_CREATED',changes:{role,status,email}});
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:'TEMP_PASSWORD_GENERATED'});
  let emailSent=true,emailMessage='Login instructions and a temporary password have been sent to the user.';
  try{const r=await sendAdminTemporaryPassword(email,{firstName:user.firstName,email,temporaryPassword});if(r?.disabled){emailSent=false;emailMessage='User account was created, but email delivery is not configured.'}}catch{emailSent=false;emailMessage='User account was created, but the login email could not be sent.'}
  res.status(201).json({success:true,message:emailMessage,data:{user:{...safe(user),accountSetup:accountSetup(user)},emailSent}});
});

export const updateUser=asyncHandler(async(req,res)=>{
  const user=await AdminUser.findById(req.params.id); if(!user)throw new AppError('Admin user not found.',404); ensureCanTarget(req.admin,user);
  const nextRole=req.body.role?String(req.body.role).toUpperCase():user.role;
  if(nextRole==='SUPER_ADMIN'&&req.admin.role!=='SUPER_ADMIN')throw new AppError('Only a Super Admin can assign the Super Admin role.',403);
  if(user.role==='SUPER_ADMIN'&&nextRole!=='SUPER_ADMIN'&&user.status==='ACTIVE'&&await activeSuperCount()<=1)throw new AppError('At least one active Super Admin must remain in the system.',409);
  const before={firstName:user.firstName,middleName:user.middleName,lastName:user.lastName,suffix:user.suffix,phoneNumber:user.phoneNumber,position:user.position,role:user.role};
  for(const k of ['firstName','middleName','lastName','suffix','phoneNumber','position'])if(req.body[k]!==undefined)user[k]=String(req.body[k]).trim();
  user.role=nextRole; if(nextRole==='SUPER_ADMIN')user.permissions=[]; user.updatedBy=req.admin._id; await user.save();
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:before.role!==user.role?'ROLE_CHANGED':'USER_UPDATED',changes:{before,after:{...before,...req.body,role:user.role}}});
  ok(res,{user:{...safe(user),accountSetup:accountSetup(user)}},'Admin user updated.');
});

export const updateStatus=asyncHandler(async(req,res)=>{
  const user=await AdminUser.findById(req.params.id);if(!user)throw new AppError('Admin user not found.',404);ensureCanTarget(req.admin,user);
  const status=String(req.body.status||'').toUpperCase();if(!['ACTIVE','INACTIVE'].includes(status))throw new AppError('Status must be ACTIVE or INACTIVE.',400);
  if(String(user._id)===String(req.admin._id)&&status==='INACTIVE')throw new AppError('You cannot deactivate your own account.',409);
  if(user.role==='SUPER_ADMIN'&&user.status==='ACTIVE'&&status==='INACTIVE'&&await activeSuperCount()<=1)throw new AppError('At least one active Super Admin must remain in the system.',409);
  const previous=user.status;user.status=status;user.updatedBy=req.admin._id;if(status==='INACTIVE')user.tokenVersion+=1;await user.save();
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:status==='ACTIVE'?'USER_REACTIVATED':'USER_DEACTIVATED',changes:{from:previous,to:status}});
  if(status==='INACTIVE'){emitToAdminUser(user._id,'admin:user-deactivated',{userId:String(user._id)});disconnectAdminUser(user._id);}
  ok(res,{user:{...safe(user),accountSetup:accountSetup(user)}},`User ${status==='ACTIVE'?'reactivated':'deactivated'}.`);
});

export const updatePermissions=asyncHandler(async(req,res)=>{
  const user=await AdminUser.findById(req.params.id);if(!user)throw new AppError('Admin user not found.',404);ensureCanTarget(req.admin,user);
  if(user.role==='SUPER_ADMIN')throw new AppError('Super Admin always has full system access and cannot be restricted.',409);
  if(String(user._id)===String(req.admin._id))throw new AppError('You cannot change your own permissions.',409);
  const before=user.permissions;user.permissions=normalizePermissions(req.body.permissions);user.updatedBy=req.admin._id;await user.save();
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:'PERMISSIONS_UPDATED',changes:{before,after:user.permissions}});
  refreshAdminUserRooms(user);
  emitToAdminUser(user._id,'admin:permissions-updated',{userId:String(user._id)});
  ok(res,{user:{...safe(user),accountSetup:accountSetup(user)}},'Permissions updated.');
});

export const reissueTemporaryPassword=asyncHandler(async(req,res)=>{
  const user=await AdminUser.findById(req.params.id).select('+passwordHash');if(!user)throw new AppError('Admin user not found.',404);ensureCanTarget(req.admin,user);
  const temporaryPassword=generateTemporaryPassword();user.passwordHash=await bcrypt.hash(temporaryPassword,12);user.mustChangePassword=true;user.temporaryPasswordExpiresAt=new Date(Date.now()+24*3600*1000);user.passwordChangedAt=null;user.tokenVersion+=1;user.updatedBy=req.admin._id;await user.save();
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:'TEMP_PASSWORD_REISSUED'});await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:'PASSWORD_RESET_REQUIRED'});
  let emailSent=true,message='A new temporary password has been emailed to the user.';try{const r=await sendAdminTemporaryPassword(user.email,{firstName:user.firstName,email:user.email,temporaryPassword});if(r?.disabled){emailSent=false;message='Temporary password was regenerated, but email delivery is not configured.'}}catch{emailSent=false;message='Temporary password was regenerated, but the login email could not be sent.'}
  emitToAdminUser(user._id,'admin:password-reset-required',{userId:String(user._id)});disconnectAdminUser(user._id);
  ok(res,{user:{...safe(user),accountSetup:accountSetup(user)},emailSent},message);
});

/** Never allow a protected bootstrap identity to be removed through public admin routes. */
export const deleteUser = asyncHandler(async (req,res)=>{
  const user=await AdminUser.findById(req.params.id);
  if(!user)throw new AppError('Admin user not found.',404);
  ensureCanTarget(req.admin,user);
  if(String(user._id)===String(req.admin._id))throw new AppError('You cannot delete your own account.',409);
  if(user.status!=='INACTIVE')throw new AppError('Deactivate the account before deletion.',409);
  await auditAdminAction({performedBy:req.admin._id,targetUser:user._id,action:'USER_DELETED',changes:{email:user.email,role:user.role}});
  await user.deleteOne();
  ok(res,{id:String(user._id)},'Inactive admin user deleted.');
});
