import { prisma } from '../config/database.js';
export const users={
 normalize:(name:string)=>name.trim().replace(/\s+/g,' ').toLocaleLowerCase(),
 async create(displayName:string){const name=displayName.trim().replace(/\s+/g,' ');const existing=await prisma.user.findFirst({where:{displayName:{equals:name,mode:'insensitive'}},orderBy:{createdAt:'asc'}});return existing??prisma.user.create({data:{displayName:name}})},
 public:(id:string)=>prisma.user.findUnique({where:{id},select:{id:true,displayName:true,avatar:true,status:true,lastSeen:true}}),
 online:()=>prisma.user.findMany({where:{status:'ONLINE'},select:{id:true,displayName:true,avatar:true,status:true,lastSeen:true},orderBy:{displayName:'asc'}}),
 async attach(userId:string,socketId:string){await prisma.userSession.upsert({where:{socketId},create:{userId,socketId},update:{userId}});return prisma.user.update({where:{id:userId},data:{status:'ONLINE'}})},
 async detach(socketId:string){const s=await prisma.userSession.findUnique({where:{socketId}});if(!s)return;await prisma.userSession.delete({where:{socketId}});if(!await prisma.userSession.count({where:{userId:s.userId}}))await prisma.user.update({where:{id:s.userId},data:{status:'OFFLINE',lastSeen:new Date()}});return s.userId;}
};
