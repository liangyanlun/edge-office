// Inspect the staged Git tree without printing matched credential contents.
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const args=['-c',`safe.directory=${root.replaceAll('\\','/')}`];
const git=(...more)=>execFileSync('git',[...args,...more],{cwd:root,maxBuffer:128*1024*1024,windowsHide:true});
const files=git('ls-files','-z').toString('utf8').split('\0').filter(Boolean);
if(files.some(file=>/[\r\n]/.test(file)))throw new Error('Unsupported control character in Git path');
const blobs=execFileSync('git',[...args,'cat-file','--batch'],{cwd:root,input:files.map(file=>`:${file}\n`).join(''),maxBuffer:128*1024*1024,windowsHide:true});
let offset=0;
const findings=[];
let bytes=0;
const forbidden=/\.(gguf|safetensors|db|sqlite3?|apk|exe|dll|so|pt|pth|ckpt|pem|key|jks|keystore)$/i;
const secrets=[/gh[pousr]_[A-Za-z0-9]{20,}/,/github_pat_[A-Za-z0-9_]{20,}/,/sk-[A-Za-z0-9]{20,}/,/AKIA[A-Z0-9]{16}/,/-----BEGIN (?:OPENSSH|RSA|EC|DSA)?\s*PRIVATE KEY-----/];
for(const file of files){
  if(forbidden.test(file)||/(^|\/)(?:node_modules|\.venv|\.gradle|\.cxx)\//.test(file)||/^artifacts\/(?:data|indexes|evaluations)\//.test(file)||/^(?:build|dist|dist-mobile|dist-installer)\//.test(file)||/^(?:.*\/)?\.env(?:\.|$)/.test(file)&&!file.endsWith('.example'))findings.push({file,kind:'excluded-file-class'});
  const end=blobs.indexOf(10,offset),header=blobs.subarray(offset,end).toString('utf8');
  const match=header.match(/^[a-f0-9]+ blob (\d+)$/);
  if(!match)throw new Error('Cannot read staged blob: '+file);
  const size=Number(match[1]),data=blobs.subarray(end+1,end+1+size);offset=end+1+size+1;bytes+=data.length;
  if(data.length>95*1024*1024)findings.push({file,kind:'oversized-file'});
  if(!data.subarray(0,8192).includes(0)&&secrets.some(pattern=>pattern.test(data.toString('utf8'))))findings.push({file,kind:'credential-pattern'});
}
console.log(JSON.stringify({files:files.length,bytes,findings},null,2));
if(findings.length)process.exitCode=1;
