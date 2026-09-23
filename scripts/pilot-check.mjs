import fs from 'node:fs';

const checks=[];
const add=(code,ok,message)=>checks.push({code,status:ok?'pass':'fail',message});
const required=['POSTGRES_PASSWORD','ANALYZER_API_KEY','PREVIEW_TOKEN_SECRET','N8N_DB_PASSWORD','N8N_ENCRYPTION_KEY','BACKUP_TARGET'];
for(const key of required){const value=process.env[key]??'';add(key,value.length>=16&&!/change-me|example|placeholder/i.test(value),value?'Configured (value hidden)':'Missing');}
add('AUTOMATIC_SENDING',process.env.AUTOMATIC_SENDING==='false','Must be explicitly false');
add('PILOT_LIMIT',Number(process.env.PILOT_MAXIMUM_COMPANIES??20)<=20,'Maximum companies <= 20');
add('MIN_SCORE',Number(process.env.PILOT_MINIMUM_REVIEW_SCORE??50)>=50,'Review threshold >= 50');
add('ARTIFACT_RETENTION',Number(process.env.ARTIFACT_RETENTION_DAYS??30)>0,'Artifact retention enabled');
const compose=fs.readFileSync('deploy/compose.production.yml','utf8');
add('PRIVATE_SERVICES',!/^\s*ports:/m.test(compose.split('caddy:')[0]),'Analyzer and databases have no published ports');
const workflow=fs.readFileSync('workflows/01-campaign-audit-review.json','utf8');
add('NO_EMAIL_SENDER',!/(smtp|gmail|outlook|sendgrid|resend)/i.test(workflow),'No automatic email sender node');
add('HUMAN_APPROVAL',workflow.includes('Human Approved Draft?'),'Human approval gate present');
add('PREVIEW_TOKEN',workflow.includes('/preview-access'),'Short-lived preview access present');
add('HTTPS_PROXY',fs.readFileSync('deploy/Caddyfile.example','utf8').includes('pitchtrace.muratsag.online'),'HTTPS reverse proxy configured');
const result={ready:checks.every(c=>c.status==='pass'),checks};
if(process.argv.includes('--json')) console.log(JSON.stringify(result));
else { console.log(`Pilot readiness: ${result.ready?'READY':'NOT READY'}`); for(const c of checks) console.log(`${c.status==='pass'?'PASS':'FAIL'} ${c.code}: ${c.message}`); }
process.exitCode=result.ready?0:1;
