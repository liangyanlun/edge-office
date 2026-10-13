import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {createMobilePpt,parsePptCalls,replayPpt} from '../public/mobile-ppt.js';
globalThis.DOMParser=DOMParser;
globalThis.XMLSerializer=class {serializeToString(node){return node.toString();}};

function fixture() {
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'ppt/presentation.xml':'<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="rId1" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml':'<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
    'ppt/slides/slide2.xml':'<p:sld xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="5000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr lvl="1"/><a:r><a:rPr sz="3200" b="1"/><a:t>原始中文标题</a:t></a:r></a:p><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000"/></p:blipFill><p:spPr><a:xfrm><a:off x="100" y="2000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="4"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels':'<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>',
  }).map(([name,value])=>[name,strToU8(value)])));
}

test('mobile PPT accepts only literal API calls',()=>{
  assert.equal(parsePptCalls("replace_paragraph(2, 0, '中文')\nclone_paragraph(2,0)").length,2);
  for(const s of ['__import__("os").system("x")','del_image(foo)','del_image(-1)','del_image(3);x=1','replace_paragraph(2,0,eval("x"))'])assert.throws(()=>parsePptCalls(s));
});
test('mobile five operations preserve styles, original, non-target slide and picture geometry',()=>{
  const bytes=fixture(),original=bytes.slice();
  const uri='asset://upload/12345678-abcd',image=new Uint8Array([137,80,78,71,13,10,26,10]);
  const operations=parsePptCalls(`replace_paragraph(2,0,'新标题')\nclone_paragraph(2,0)\ndel_paragraph(2,1)\nreplace_image(3,'${uri}')\ndel_image(4)`);
  const result=replayPpt(bytes,'slide-1',operations,[{id:'12345678-abcd',uri,bytes:image}]);
  assert.equal(result.verification.operationCount,5);assert.deepEqual(bytes,original);
  const before=unzipSync(bytes),after=unzipSync(result.bytes);
  assert.deepEqual(after['ppt/slides/slide1.xml'],before['ppt/slides/slide1.xml']);
  const slide=new TextDecoder().decode(after['ppt/slides/slide2.xml']);
  assert.equal(slide.match(/新标题/g).length,2);assert.ok(slide.includes('b="1"'));assert.ok(slide.includes('l="10000"'));
  assert.ok(!slide.includes('id="4"'));assert.ok(slide.includes('rIdEdge'));
  assert.throws(()=>replayPpt(bytes,'slide-1',parsePptCalls("replace_image(3,'C:/private.png')")));
  assert.throws(()=>replayPpt(bytes,'slide-1',parsePptCalls('del_image(999)')));
});
test('mobile PPT preview/confirm persists, stale and tampered patches fail closed',async()=>{
  const records=new Map();let response="replace_paragraph(2,0,'已更新')";
  const ppt=createMobilePpt({read:async id=>structuredClone(records.get(id)),write:async doc=>records.set(doc.id,structuredClone(doc)),list:async()=>structuredClone([...records.values()]),infer:async()=>({answer:response,finishReason:'stop',model:'4B-test'})});
  const file={name:'test.pptx',arrayBuffer:async()=>fixture().buffer};
  const doc=await ppt.importFile(file),base=doc.currentVersionId,path=`/api/v1/presentations/${doc.id}`;
  const slides=await ppt.request(path+'/slides');assert.equal(slides.slideSize.height,6858000);assert.ok(slides.items[0].previewUrl.startsWith('blob:'));
  const create=()=>ppt.request(path+'/patches',{method:'POST',body:JSON.stringify({baseVersion:base,slideId:'slide-1',instruction:'修改标题'})});
  const {item:p}=await create();const {item:other}=await create();
  await assert.rejects(ppt.request(`/api/v1/ppt-patches/${p.id}/confirm`,{method:'POST'}));
  await ppt.request(`/api/v1/ppt-patches/${p.id}/simulate`,{method:'POST'});
  await assert.rejects(ppt.request(`/api/v1/ppt-patches/${p.id}/confirm`,{method:'POST',body:'{"operations":[]}'}));
  const result=await ppt.request(`/api/v1/ppt-patches/${p.id}/confirm`,{method:'POST'});
  assert.notEqual(result.version.id,base);assert.ok((await ppt.download(doc.id,result.version.id)).bytes.length);
  await assert.rejects(ppt.request(`/api/v1/ppt-patches/${p.id}/confirm`,{method:'POST'}));
  await assert.rejects(ppt.request(`/api/v1/ppt-patches/${other.id}/simulate`,{method:'POST'}));
  const restore=await ppt.request(`${path}/versions/${base}/restore`,{method:'POST'});assert.notEqual(restore.item.id,base);
  response='del_image(3)';const current=(await ppt.request(path)).item.currentVersionId;
  const {item:tampered}=await ppt.request(path+'/patches',{method:'POST',body:JSON.stringify({baseVersion:current,slideId:'slide-1',instruction:'删除图片'})});
  await ppt.request(`/api/v1/ppt-patches/${tampered.id}/simulate`,{method:'POST'});
  records.get(doc.id).patches.find(p=>p.id===tampered.id).patchHash='bad';
  await assert.rejects(ppt.request(`/api/v1/ppt-patches/${tampered.id}/confirm`,{method:'POST'}));
});
