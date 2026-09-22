import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';

export async function suppressionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{Body:{scope:'email'|'domain';value:string;reason:string;created_by:string}}>('/suppression', {
    schema:{body:{type:'object',required:['scope','value','reason','created_by'],additionalProperties:false,properties:{scope:{enum:['email','domain']},value:{type:'string',minLength:3,maxLength:320},reason:{type:'string',minLength:1,maxLength:500},created_by:{type:'string',minLength:1,maxLength:200}}}},
  }, async(request,reply)=>{
    const value=request.body.value.trim().toLowerCase().replace(request.body.scope==='domain'?/^www\./:/^$/,'');
    const row=await query<{id:string}>(`INSERT INTO pitchtrace.suppression_list (scope,value,reason,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (scope,value) DO UPDATE SET reason=EXCLUDED.reason RETURNING id`,[request.body.scope,value,request.body.reason,request.body.created_by]);
    return reply.code(201).send({id:row.rows[0]!.id,scope:request.body.scope,value});
  });
}
