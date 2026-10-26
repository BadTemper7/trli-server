import 'dotenv/config';
import {connectDB} from '../src/config/db.js';
import AdminUser from '../src/models/AdminUser.js';
import mongoose from 'mongoose';
const email=String(process.env.SUPER_ADMIN_EMAIL||'').trim().toLowerCase();
if(!email)throw new Error('Set SUPER_ADMIN_EMAIL to the verified bootstrap Super Admin address.');
await connectDB();
try{
 const account=await AdminUser.findOne({email,role:'SUPER_ADMIN'});
 if(!account)throw new Error('No matching Super Admin found. No changes were made.');
 const other=await AdminUser.exists({isSystemProtected:true,_id:{$ne:account._id}});
 if(other)throw new Error('A different protected Super Admin exists. Resolve this conflict manually.');
 if(!process.argv.includes('--apply')){console.log(`DRY RUN: protect bootstrap admin ID ${account._id}, email ${email}. Run with --apply after verification.`);}
 else{
  await AdminUser.collection.createIndex({isSystemProtected:1},{unique:true,partialFilterExpression:{isSystemProtected:true},name:'one_protected_system_admin'});
  await AdminUser.collection.updateOne({_id:account._id,role:'SUPER_ADMIN'},{$set:{isSystemProtected:true}});
  console.log(`Protected system administrator ${account._id}.`);
 }
}finally{await mongoose.disconnect();}
