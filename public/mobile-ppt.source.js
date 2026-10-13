import {unzipSync, zipSync} from 'fflate';

const NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const keys = {replace_paragraph:['div_id','paragraph_id','text'], clone_paragraph:['div_id','paragraph_id'], del_paragraph:['div_id','paragraph_id'], replace_image:['image_id','image_path'], del_image:['image_id']};
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const fail = message => {throw new Error(message);};
const local = n => (n.localName || n.nodeName).split(':').at(-1);
const children = (n, name) => Array.from(n?.children || []).filter(c => local(c) === name);
const all = (n, name) => {const out=[];function visit(parent){for(const child of Array.from(parent?.children||[])){if(local(child)===name)out.push(child);visit(child);}}visit(n);return out;};
const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
function xml(bytes) {
  const source = dec.decode(bytes || fail('PPT 结构缺失'));
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('不允许 XML 实体');
  const doc = new DOMParser().parseFromString(source,'application/xml');
  if (doc.getElementsByTagName('parsererror').length) fail('PPT XML 损坏');
  return doc;
}
const serialize = node => enc.encode(new XMLSerializer().serializeToString(node));
function archive(bytes) {
  if (bytes.length > 20*1024*1024) fail('PPTX 超过 20MB');
  let total=0, count=0;
  const files=unzipSync(bytes,{filter(info){
    total+=info.originalSize; count++;
    if (count>5000 || total>100*1024*1024) fail('PPT 展开内容过大');
    if (/\\|^\/|(^|\/)\.\.(\/|$)|^[a-z]+:/i.test(info.name)) fail('PPT 内部路径不安全');
    const printer=/^ppt\/printerSettings\/printerSettings\d+\.bin$/i.test(info.name);
    if (/vbaProject|^ppt\/(embeddings|activeX)\//i.test(info.name) || (/\.bin$/i.test(info.name)&&!printer)) fail('不支持含宏或嵌入程序的 PPT');
    return true;
  }});
  for(const [name, data] of Object.entries(files)) if (/\.(xml|rels)$/.test(name)) {
    const doc=xml(data);
    if (name.endsWith('.rels') && all(doc,'Relationship').some(n=>n.getAttribute('TargetMode')==='External')) fail('不支持外部引用，请先在 PowerPoint 中嵌入资源');
  }
  return files;
}
function resolvePart(base, target) {
  if (/^[a-z]+:|\\/i.test(target)) fail('PPT 关系路径不安全');
  const parts=target.startsWith('/')?[]:base.split('/').slice(0,-1);
  for(const p of target.split('/')) {if(!p||p==='.')continue; if(p==='..'){if(!parts.length)fail('关系路径越界');parts.pop();}else parts.push(p);}
  return parts.join('/');
}
function relName(name) {return name.replace(/([^/]+)$/, '_rels/$1.rels');}
function relationships(files, name) {
  const doc=xml(files[relName(name)] || enc.encode(`<Relationships xmlns="${REL}"/>`));
  return {doc, map:new Map(all(doc,'Relationship').map(n=>[n.getAttribute('Id'),resolvePart(name,n.getAttribute('Target')||'')]))};
}
function deck(bytes) {
  const files=archive(bytes), p=xml(files['ppt/presentation.xml']);
  const rels=relationships(files,'ppt/presentation.xml');
  const names=all(p,'sldId').map(n=>rels.map.get(n.getAttribute('r:id')));
  if(!names.length||names.length>300||names.some(n=>!n||!files[n]))fail('PPT 页面目录缺失或超过 300 页');
  const size=all(p,'sldSz')[0];
  const width=Number(size?.getAttribute('cx')), height=Number(size?.getAttribute('cy'));
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>500000000||height>500000000)fail('PPT 页面尺寸无效');
  return {files,names,slideSize:{width,height}};
}
function snapshot(d, index, version) {
  const name=d.names[index]; if(!name)fail('幻灯片不存在');
  const doc=xml(d.files[name]), tree=all(doc,'spTree')[0]; if(!tree)fail('幻灯片形状树缺失');
  const elements=[];
  for(const shape of Array.from(tree.children)) {
    const type=local(shape); if(!['sp','pic','grpSp','graphicFrame','cxnSp'].includes(type))continue;
    const id=Number(all(shape,'cNvPr')[0]?.getAttribute('id'));
    if(!Number.isSafeInteger(id)||id<0||elements.some(e=>e.id===id))fail('对象 ID 无效或重复');
    const x=all(shape,'xfrm')[0], off=children(x,'off')[0], ext=children(x,'ext')[0];
    const bounds={left:Number(off?.getAttribute('x')||0), top:Number(off?.getAttribute('y')||0), width:Number(ext?.getAttribute('cx')||0), height:Number(ext?.getAttribute('cy')||0)};
    if(Object.values(bounds).some(n=>!Number.isSafeInteger(n)||Math.abs(n)>1000000000)||bounds.width<0||bounds.height<0)fail('对象位置或尺寸无效');
    const body=children(shape,'txBody')[0], ph=all(shape,'ph')[0];
    const editable=!ph || ['title','ctrTitle','subTitle','body','obj'].includes(ph.getAttribute('type')||'obj');
    const paragraphs=body?children(body,'p').map((p,i)=>({id:i,paragraphId:i,text:Array.from(p.children).map(n=>local(n)==='br'?'\n':all(n,'t').map(t=>t.textContent).join('')).join(''), fontSize:Number(all(p,'rPr')[0]?.getAttribute('sz')||2000)/100})):[];
    const embed=all(shape,'blip')[0]?.getAttribute('r:embed');
    elements.push({id,kind:type==='pic'?'image':type==='sp'&&body?'text':'unsupported',editable,paragraphs,bounds,embed,shape});
  }
  const html=elements.map(e=>e.kind==='text'?`<div id="${e.id}" data-editable="${e.editable}">${e.paragraphs.map(p=>`<p id="${p.id}">${esc(p.text)}</p>`).join('')}</div>`:e.kind==='image'?`<img id="${e.id}" />`:'').join('');
  return {slideId:`slide-${index+1}`,slideNumber:index+1,baseVersion:version,elements,html:`<section data-slide-id="slide-${index+1}" data-base-version="${esc(version)}">${html}</section>`,doc,name};
}
function mime(bytes) {
  if(bytes?.[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return 'image/png';
  if(bytes?.[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes && String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
  return null;
}
function base64(bytes) {let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function svgPreview(d,s) {
  const {width,height}=d.slideSize, w=1280,h=Math.round(w*height/width),scale=w/width, rels=relationships(d.files,s.name);
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/>`];
  for(const e of s.elements) {
    const x=e.bounds.left*scale,y=e.bounds.top*scale,ew=e.bounds.width*scale,eh=e.bounds.height*scale;
    if(e.kind==='text') {
      const clip=`c${e.id}`;parts.push(`<defs><clipPath id="${clip}"><rect x="${x}" y="${y}" width="${ew}" height="${eh}"/></clipPath></defs>`);
      let ty=y;
      for(const p of e.paragraphs) {
        const fs=Math.max(10,p.fontSize*w/(width/914400)/72), limit=Math.max(1,Math.floor(ew/fs));
        for(const para of p.text.split('\n')) for(let start=0;start<Math.max(1,para.length);start+=limit) {ty+=fs*1.25;parts.push(`<text x="${x}" y="${ty}" font-size="${fs}" font-family="sans-serif" fill="#1f2c3d" clip-path="url(#${clip})">${esc(para.slice(start,start+limit))}</text>`);}
      }
    }else if(e.kind==='image') {
      const data=d.files[rels.map.get(e.embed)], type=data&&mime(data);
      if(type)parts.push(`<image x="${x}" y="${y}" width="${ew}" height="${eh}" preserveAspectRatio="none" href="data:${type};base64,${base64(data)}"/>`);
      else parts.push(`<rect x="${x}" y="${y}" width="${ew}" height="${eh}" fill="none" stroke="#98a5b5"/>`);
    }else parts.push(`<rect x="${x}" y="${y}" width="${ew}" height="${eh}" fill="none" stroke="#d9dfe7"/>`);
  }
  return parts.join('')+'</svg>';
}
// Strict literal-only parser. No eval, function invocation, assignments, paths,
// property access, or arbitrary JS/Python reaches the executor.
export function parsePptCalls(source) {
  if(typeof source!=='string'||source.length>100000)fail('模型操作序列无效');
  let text=source.trim().replace(/^```[^\n]*\n/,'').replace(/\n```$/,'');
  let at=0;const ops=[];const ws=()=>{while(/\s/.test(text[at]||'')&&at<text.length)at++;};
  function literal(){ws();const quote=text[at]; if(quote==='"'||quote==="'"){at++;let out='';while(at<text.length){let c=text[at++];if(c===quote)return out;if(c==='\\'){const n=text[at++];if(n==='u'){const hex=text.slice(at,at+4);if(!/^[a-f\d]{4}$/i.test(hex))fail('字符串转义无效');c=String.fromCharCode(parseInt(hex,16));at+=4;}else{const escapes={n:'\n',r:'\r',t:'\t',"'":"'",'"':'"','\\':'\\'};if(!(n in escapes))fail('字符串转义不支持');c=escapes[n];}}out+=c;}fail('字符串未闭合');}const m=text.slice(at).match(/^\d+/);if(!m)fail('只接受字符串或整数常量');at+=m[0].length;return Number(m[0]);}
  while(at<text.length){ws();if(at===text.length)break;const m=text.slice(at).match(/^[a-z_]+/);if(!m||!keys[m[0]])fail('不支持的 PPT 操作');const operation=m[0];at+=m[0].length;ws();if(text[at++]!=='(')fail('调用语法错误');const args=[];ws();if(text[at]!==')'){while(true){args.push(literal());ws();if(text[at]!==',')break;at++;}}if(text[at++]!==')'||args.length!==keys[operation].length)fail('调用参数数量错误');if(args.some(a=>typeof a==='string'&&(a.length>20000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(a))))fail('非法文本');ops.push({operation,...Object.fromEntries(keys[operation].map((k,i)=>[k,args[i]]))});if(ops.length>32)fail('最多 32 项操作');if(at<text.length&&!/[\s;]/.test(text[at]))fail('不允许表达式');if(text[at]===';')at++;}
  if(!ops.length)fail('没有可执行的 PPT 操作');return ops;
}
export function replayPpt(bytes, slideId, operations, assets=[]) {
  const d=deck(bytes), index=Number(slideId.replace(/^slide-/,''))-1;
  if(!/^slide-[1-9]\d*$/.test(slideId)||!d.names[index])fail('页面 ID 无效');
  if(!operations.length||operations.length>32)fail('操作数量无效');
  const s=snapshot(d,index,'candidate'), map=new Map(s.elements.map(e=>[e.id,e]));
  const paragraphs=new Map(s.elements.filter(e=>e.kind==='text').map(e=>[e.id,new Map(children(children(e.shape,'txBody')[0],'p').map((p,i)=>[i,p]))]));
  const integer=value=>{if(!/^(0|[1-9]\d*)$/.test(String(value))||typeof value==='boolean'||!Number.isSafeInteger(Number(value)))fail('对象 ID 必须为非负整数');return Number(value);};
  const rels=relationships(d.files,s.name);
  for(const op of operations) {
    if(!keys[op.operation]||Object.keys(op).sort().join()!==['operation',...keys[op.operation]].sort().join())fail('操作契约无效');
    if(op.operation.endsWith('paragraph')) {
      const id=integer(op.div_id), pid=integer(op.paragraph_id), e=map.get(id), p=paragraphs.get(id)?.get(pid);
      if(e?.kind!=='text'||!e.editable||!p)fail('文本对象不存在、已删除或不允许编辑');
      if(op.operation==='replace_paragraph') {
        if(typeof op.text!=='string'||op.text.length>10000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(op.text))fail('替换文本无效');
        const runs=children(p,'r');let run=runs[0];if(!run){run=p.ownerDocument.createElementNS(NS,'a:r');p.appendChild(run);}
        for(const child of Array.from(p.children))if(local(child)==='br'||local(child)==='fld')p.removeChild(child);
        for(const r of runs.slice(1))for(const t of all(r,'t'))t.textContent='';
        let t=children(run,'t')[0];if(!t){t=p.ownerDocument.createElementNS(NS,'a:t');run.appendChild(t);}t.textContent=op.text;
      }else if(op.operation==='clone_paragraph') {
        const clone=p.cloneNode(true);p.parentNode.insertBefore(clone,p.nextSibling);const pm=paragraphs.get(id);pm.set(Math.max(...pm.keys())+1,clone);
      }else {p.parentNode.removeChild(p);paragraphs.get(id).delete(pid);}
    }else {
      const id=integer(op.image_id),e=map.get(id);if(e?.kind!=='image')fail('图片不存在或已删除');
      if(op.operation==='del_image'){e.shape.parentNode.removeChild(e.shape);map.delete(id);}
      else {
        if(!/^asset:\/\/upload\/[a-z\d-]{8,80}$/i.test(op.image_path||''))fail('只允许本次上传的图片，不接受文件路径');
        const asset=assets.find(a=>a.uri===op.image_path);if(!asset||!mime(asset.bytes))fail('替换图片资源无效');
        const type=mime(asset.bytes), suffix=type==='image/png'?'png':type==='image/jpeg'?'jpg':'webp';
        const media=`ppt/media/edge-${asset.id}.${suffix}`,rid=`rIdEdge${asset.id.replace(/-/g,'')}`;d.files[media]=asset.bytes;
        let r=all(rels.doc,'Relationship').find(n=>n.getAttribute('Id')===rid);
        if(!r){r=rels.doc.createElementNS(REL,'Relationship');r.setAttribute('Id',rid);r.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');r.setAttribute('Target',`../media/edge-${asset.id}.${suffix}`);rels.doc.documentElement.appendChild(r);}
        all(e.shape,'blip')[0].setAttribute('r:embed',rid);
        const ct=xml(d.files['[Content_Types].xml']);if(!all(ct,'Default').some(n=>n.getAttribute('Extension')===suffix)){const n=ct.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types','Default');n.setAttribute('Extension',suffix);n.setAttribute('ContentType',type);ct.documentElement.appendChild(n);}d.files['[Content_Types].xml']=serialize(ct);
      }
    }
  }
  d.files[s.name]=serialize(s.doc);d.files[relName(s.name)]=serialize(rels.doc);
  const candidate=zipSync(d.files,{level:6}), reopened=deck(candidate), final=snapshot(reopened,index,'candidate');
  const digest=state=>canonical(state.elements.map(e=>({id:e.id,kind:e.kind,paragraphs:e.paragraphs.map(p=>p.text),embed:e.embed,bounds:e.bounds})));
  if(digest(final)!==digest(snapshot(d,index,'candidate')))fail('修改保存后状态不一致');
  for(let i=0;i<d.names.length;i++)if(i!==index&&hashSyncCompare(d.files[d.names[i]],reopened.files[d.names[i]])===false)fail('非目标页被改变');
  return {bytes:candidate,verification:{ok:true,operationCount:operations.length,nonTargetSlidesVerified:d.names.length-1,render:{mode:'mobile-structure-preview',approximate:true}}};
}
function hashSyncCompare(a,b){return a?.length===b?.length&&a.every((v,i)=>v===b[i]);}

export function createMobilePpt({read,write,list,infer}) {
  const urls=new Map();
  const remember=(key,svg)=>{if(!urls.has(key))urls.set(key,URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})));return urls.get(key);};
  const runtime={capability:{warning:'手机 PPT 编辑试用：使用本机模型与结构预览，建议 4B；复杂版式请导出后在 PowerPoint 核对。'}};
  const get=async id=>(await read(id))||fail('PPT 不存在');
  function version(doc,id=doc.currentVersionId){return doc.versions.find(v=>v.id===id)||fail('版本不存在');}
  function publicDoc(doc){return {id:doc.id,name:doc.name,currentVersionId:doc.currentVersionId,versionCount:doc.versions.length,versions:doc.versions.map(({bytes,...v})=>v),modelCapability:runtime.capability};}
  function slides(doc,v) {const d=deck(v.bytes);return {presentationId:doc.id,versionId:v.id,slideSize:d.slideSize,render:{mode:'mobile-structure-preview',approximate:true,warning:runtime.capability.warning},items:d.names.map((_,i)=>{const s=snapshot(d,i,v.id);return {slideId:s.slideId,slideNumber:i+1,elementCount:s.elements.length,previewUrl:remember(`${doc.id}/${v.id}/${i}`,svgPreview(d,s))};})};}
  const patchPublic=p=>{const {candidate,modelOutput,...rest}=p;return rest;};
  async function importFile(file){if(!/\.pptx$/i.test(file.name))fail('仅支持 PPTX');const bytes=new Uint8Array(await file.arrayBuffer()),d=deck(bytes),id=crypto.randomUUID(),digest=await hash(bytes),vid=id+'@'+digest.slice(0,12);const doc={id,name:file.name,currentVersionId:vid,versions:[{id:vid,sourceKind:'import',bytes,createdAt:new Date().toISOString()}],assets:[],patches:[]};await write(doc);return publicDoc(doc);}
  async function uploadAsset(id,file){if(file.size>12*1024*1024)fail('图片超过 12MB');const bytes=new Uint8Array(await file.arrayBuffer());if(!mime(bytes))fail('只支持 PNG、JPEG、WebP 位图');
    if(!globalThis.createImageBitmap)fail('当前 WebView 无法校验图片，请升级系统 WebView');
    const bitmap=await createImageBitmap(new Blob([bytes],{type:mime(bytes)}));try{if(bitmap.width*bitmap.height>40000000)fail('图片超过 4000 万像素');}finally{bitmap.close();}
    const doc=await get(id),aid=crypto.randomUUID(),asset={id:aid,uri:'asset://upload/'+aid,name:file.name,bytes};doc.assets.push(asset);await write(doc);return {id:aid,uri:asset.uri,name:file.name};}
  async function request(path,options={}) {
    const parts=path.split('/').map(decodeURIComponent),method=options.method||'GET',payload=JSON.parse(options.body||'{}');
    if(parts[3]==='presentations') {
      if(!parts[4])return {items:(await list()).map(publicDoc),runtime};
      const doc=await get(parts[4]),v=version(doc);
      if(!parts[5])return {item:publicDoc(doc)};
      if(parts[5]==='slides'){if(!parts[6])return slides(doc,v);const s=snapshot(deck(v.bytes),Number(parts[6].replace('slide-',''))-1,v.id);return {item:{...s,doc:undefined,elements:s.elements.map(({shape,...e})=>e)}};}
      if(parts[5]==='patches'&&method==='POST') {
        if(payload.baseVersion!==doc.currentVersionId)fail('页面已更新，请重新生成');
        if(typeof payload.instruction!=='string'||!payload.instruction.trim()||payload.instruction.length>4000)fail('修改要求无效');
        const s=snapshot(deck(v.bytes),Number(String(payload.slideId).replace('slide-',''))-1,v.id);
        const prompt=`你是 PPT 专用计划器。只输出以下 API 调用，每行一个，不输出解释：replace_paragraph(div_id, paragraph_id, text)、clone_paragraph(div_id, paragraph_id)、del_paragraph(div_id, paragraph_id)、replace_image(image_id, image_path)、del_image(image_id)。ID 只来自当前页 HTML，图片只能用列出的 asset URI。\n当前页 HTML：${s.html}\n位置：${canonical(s.elements.map(({shape,paragraphs,...e})=>e))}\n图片：${canonical(doc.assets.map(({bytes,...a})=>a))}\n用户要求：${payload.instruction}`;
        const generated=await infer({prompt,maxTokens:1024});if(generated.finishReason!=='stop')fail('模型计划未完整结束，请缩短修改要求');
        const operations=parsePptCalls(generated.answer);replayPpt(v.bytes,s.slideId,operations,doc.assets);
        const binding={contractVersion:'edge-office-ppt-patch/1.0',documentId:doc.id,baseVersion:v.id,slideId:s.slideId,operations};
        const p={id:crypto.randomUUID(),...binding,status:'PLANNED',model:generated.model,modelOutputSha256:await hash(enc.encode(generated.answer)),patchHash:await hash(enc.encode(canonical(binding))),previewReady:false};doc.patches.push(p);await write(doc);return {item:patchPublic(p)};
      }
      if(parts[5]==='versions'&&parts[7]==='restore'&&method==='POST') {
        if(Object.keys(payload).length)fail('恢复只接受版本 ID');const old=version(doc,parts[6]);const restored={...old,id:doc.id+'@'+crypto.randomUUID(),sourceKind:'restore',parentVersionId:v.id,createdAt:new Date().toISOString()};doc.versions.unshift(restored);doc.currentVersionId=restored.id;await write(doc);return {item:{id:restored.id}};
      }
    }
    if(parts[3]==='ppt-patches') {
      const docs=await list(),doc=docs.find(d=>d.patches.some(p=>p.id===parts[4]));if(!doc)fail('修改计划不存在');const p=doc.patches.find(p=>p.id===parts[4]);if(!parts[5])return {item:patchPublic(p)};
      if(Object.keys(payload).length)fail('确认仅接受 patch_id');
      if(parts[5]==='cancel'){if(p.status==='PUBLISHED')fail('已保存修改不能取消，请撤销');p.status='CANCELLED';delete p.candidate;await write(doc);return {item:patchPublic(p)};}
      if(doc.currentVersionId!==p.baseVersion)fail('基础版本已过期，请刷新');
      if(parts[5]==='simulate'){if(p.status!=='PLANNED')fail('计划状态无效');const replay=replayPpt(version(doc).bytes,p.slideId,p.operations,doc.assets);p.candidate=replay.bytes;p.verification={...replay.verification,candidateSha256:await hash(p.candidate)};p.status='PREVIEW_READY';p.previewReady=true;const d=deck(p.candidate),s=snapshot(d,Number(p.slideId.slice(6))-1,'preview');p.previewUrl=remember(p.id,svgPreview(d,s));await write(doc);return {item:patchPublic(p)};}
      if(parts[5]==='confirm') {
        if(p.status!=='PREVIEW_READY'||!p.candidate||await hash(p.candidate)!==p.verification.candidateSha256)fail('预览尚未验证或已被修改');
        const binding={contractVersion:p.contractVersion,documentId:p.documentId,baseVersion:p.baseVersion,slideId:p.slideId,operations:p.operations};if(await hash(enc.encode(canonical(binding)))!==p.patchHash)fail('修改计划已被篡改');
        const v={id:doc.id+'@'+crypto.randomUUID(),sourceKind:'edit',parentVersionId:p.baseVersion,bytes:p.candidate,createdAt:new Date().toISOString()};doc.versions.unshift(v);doc.currentVersionId=v.id;p.status='PUBLISHED';p.publishedVersionId=v.id;delete p.candidate;await write(doc);return {patch:patchPublic(p),version:{id:v.id}};
      }
    }
    fail('PPT 请求不支持');
  }
  async function download(id,vid){const doc=await get(id);return {bytes:version(doc,vid).bytes,name:doc.name};}
  let pending=Promise.resolve();
  const enqueue=task=>{const run=pending.then(task);pending=run.catch(()=>{});return run;};
  return {request:(path,options={})=>(options.method||'GET')==='POST'?enqueue(()=>request(path,options)):request(path,options),
          importFile:file=>enqueue(()=>importFile(file)),uploadAsset:(id,file)=>enqueue(()=>uploadAsset(id,file)),download};
}
