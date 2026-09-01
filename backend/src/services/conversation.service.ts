import { prisma } from '../config/database.js';
export const conversations={
 async assertMember(id:string,userId:string){const row=await prisma.conversationParticipant.findUnique({where:{conversationId_userId:{conversationId:id,userId}}});if(!row)throw new Error('Conversation access denied');},
 async privateFor(a:string,b:string){const include={participants:{include:{user:{select:{id:true,displayName:true,avatar:true,status:true,lastSeen:true}}}}};const existing=await prisma.conversation.findFirst({where:{type:'PRIVATE',AND:[{participants:{some:{userId:a}}},{participants:{some:{userId:b}}}],participants:{every:{userId:{in:[a,b]}}}},include});if(existing)return existing;return prisma.$transaction(async tx=>tx.conversation.create({data:{type:'PRIVATE',participants:{create:[{userId:a},{userId:b}]}},include}));},
 async list(userId:string){return prisma.conversation.findMany({where:{participants:{some:{userId}}},include:{participants:{include:{user:{select:{id:true,displayName:true,avatar:true,status:true,lastSeen:true}}}},messages:{orderBy:{createdAt:'desc'},take:1}},orderBy:{updatedAt:'desc'}})}
};
