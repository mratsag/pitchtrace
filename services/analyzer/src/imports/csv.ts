import { IMPORT_LIMITS } from './codes.js';

export class CsvContractError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422) { super(message); }
}
export interface CsvDataRow { row: number; values: Record<string,string>; raw: string[]; }
export interface ParsedCompanyCsv { headers: string[]; rows: CsvDataRow[]; }

const ALLOWED = new Set(['company_name','website','contact_name','contact_email']);
const REQUIRED = ['company_name','website'];

export function parseCompanyCsv(buffer: Buffer): ParsedCompanyCsv {
  let text: string;
  try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer); }
  catch { throw new CsvContractError('CSV_INVALID_UTF8','CSV must be valid UTF-8'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseRecords(text);
  const nonEmpty = records.filter((r)=>!r.fields.every((v)=>v.trim()===''));
  if (!nonEmpty.length) throw new CsvContractError('CSV_EMPTY','CSV is empty');
  const headers=nonEmpty[0]!.fields.map((h)=>h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new CsvContractError('CSV_DUPLICATE_HEADER','CSV contains duplicate headers');
  const unknown=headers.filter((h)=>!ALLOWED.has(h));
  if (unknown.length) throw new CsvContractError('CSV_UNKNOWN_HEADER',`unsupported headers: ${unknown.join(', ')}`);
  const missing=REQUIRED.filter((h)=>!headers.includes(h));
  if (missing.length) throw new CsvContractError('CSV_MISSING_HEADER',`missing required headers: ${missing.join(', ')}`);
  const data=nonEmpty.slice(1);
  if (data.length > IMPORT_LIMITS.maxRows) throw new CsvContractError('CSV_TOO_MANY_ROWS',`CSV contains more than ${IMPORT_LIMITS.maxRows} data rows`);
  return {headers,rows:data.map((record)=>({row:record.row,raw:record.fields,values:Object.fromEntries(headers.map((h,i)=>[h,record.fields[i]??'']))}))};
}

function parseRecords(text:string):Array<{row:number;fields:string[]}>{
  const records:Array<{row:number;fields:string[]}>=[]; let fields:string[]=[]; let field=''; let quoted=false; let afterQuote=false; let line=1; let recordLine=1;
  const pushField=()=>{fields.push(field);field='';afterQuote=false;};
  const pushRecord=()=>{pushField();records.push({row:recordLine,fields});fields=[];recordLine=line+1;};
  for(let i=0;i<text.length;i+=1){const ch=text[i]!;
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){field+='"';i+=1;}else{quoted=false;afterQuote=true;}}else{field+=ch;if(ch==='\n')line+=1;}continue;}
    if(afterQuote&&ch!==','&&ch!=='\r'&&ch!=='\n')throw new CsvContractError('CSV_MALFORMED_QUOTING',`unexpected character after quote at line ${line}`);
    if(ch==='"'){if(field!=='')throw new CsvContractError('CSV_MALFORMED_QUOTING',`quote inside unquoted field at line ${line}`);quoted=true;continue;}
    if(ch===','){pushField();continue;}
    if(ch==='\n'){pushRecord();line+=1;continue;}
    if(ch==='\r'){if(text[i+1]==='\n')continue;pushRecord();line+=1;continue;}
    field+=ch;
  }
  if(quoted)throw new CsvContractError('CSV_MALFORMED_QUOTING','unterminated quoted field');
  if(field!==''||fields.length>0)pushRecord();
  return records;
}
