import test from "node:test";
import assert from "node:assert/strict";
import {File} from "node:buffer";
import {DOMParser} from "linkedom";
import {zipSync, strToU8} from "fflate";
import {parseMobileDocument} from "../public/mobile-document-parser.js";

globalThis.DOMParser = DOMParser;

function archive(name, files) {
  const packed = zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
  return new File([packed], name);
}

function pdfFile(stream = "BT /F1 18 Tf 72 720 Td (Hello PDF) Tj ET") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(data.length);
    data += (index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xref = data.length;
  data += "xref\n0 6\n0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => { data += String(offset).padStart(10, "0") + " 00000 n \n"; });
  data += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return new File([data], "sample.pdf", {type: "application/pdf"});
}

test("DOCX paragraphs and table rows retain locators", async () => {
  const file = archive("memo.docx", {"word/document.xml": '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>项目结论</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>小李</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'});
  const result = await parseMobileDocument(file);
  assert.deepEqual(result.units.map((item) => item.locator), ["段落 1", "表格 1 · 行 2"]);
  assert.match(result.units[1].text, /负责人：小李/);
  assert.equal(result.fileSha256.length, 64);
});

test("PPTX slides retain page locators", async () => {
  const file = archive("deck.pptx", {
    "ppt/slides/slide2.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:t>第二页</a:t></a:p></p:sp></p:sld>',
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:t>第一页</a:t></a:p></p:sp></p:sld>',
  });
  const result = await parseMobileDocument(file);
  assert.deepEqual(result.units.map((item) => item.locator), ["第 1 页", "第 2 页"]);
  assert.equal(result.units[1].text, "第二页");
});

test("PPTX uses presentation relationship order instead of slide filenames", async () => {
  const file = archive("reordered.pptx", {
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId7"/><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId7" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:t>文件名第一页</a:t></a:p></p:sp></p:sld>',
    "ppt/slides/slide2.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:t>实际第一页</a:t></a:p></p:sp></p:sld>',
  });
  const result = await parseMobileDocument(file);
  assert.deepEqual(result.units, [
    {locator: "第 1 页", text: "实际第一页"},
    {locator: "第 2 页", text: "文件名第一页"},
  ]);
});

test("XLSX shared strings and row locators are retained", async () => {
  const file = archive("table.xlsx", {
    "xl/workbook.xml": '<workbook xmlns="urn:x"><sheets><sheet name="计划"/></sheets></workbook>',
    "xl/sharedStrings.xml": '<sst xmlns="urn:x"><si><t>事项</t></si><si><t>写报告</t></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="urn:x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const result = await parseMobileDocument(file);
  assert.deepEqual(result.units, [{locator: "工作表 计划 · 行 2", text: "事项：写报告"}]);
});

test("XLSX uses workbook relationships to preserve display order and names", async () => {
  const row = (text) => '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>事项</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>' + text + '</t></is></c></row></sheetData></worksheet>';
  const file = archive("reordered.xlsx", {
    "xl/workbook.xml": '<workbook xmlns:r="urn:r"><sheets><sheet name="优先事项" r:id="rId2"/><sheet name="次要事项" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": row("第二项"),
    "xl/worksheets/sheet2.xml": row("第一项"),
  });
  const result = await parseMobileDocument(file);
  assert.deepEqual(result.units, [
    {locator: "工作表 优先事项 · 行 2", text: "事项：第一项"},
    {locator: "工作表 次要事项 · 行 2", text: "事项：第二项"},
  ]);
});

test("CSV quoted fields and HTML active content", async () => {
  const csv = await parseMobileDocument(new File(['名称,说明\n项目,"甲,乙"'], "table.csv"));
  assert.equal(csv.units[0].text, "名称：项目；说明：甲,乙");
  const html = await parseMobileDocument(new File(['<main>正文<script>secret</script><style>hidden</style></main>'], "page.html"));
  assert.equal(html.units[0].text, "正文");
});

test("PDF text layer is extracted; invalid and oversize archives fail", async () => {
  const pdf = await parseMobileDocument(pdfFile());
  assert.equal(pdf.units[0].locator, "第 1 页");
  assert.match(pdf.units[0].text, /Hello PDF/);
  await assert.rejects(parseMobileDocument(pdfFile("q 10 0 0 10 0 0 cm Q")), /扫描件需要 OCR/);
  await assert.rejects(parseMobileDocument(new File(["not a zip"], "broken.docx")), /OOXML/);
  await assert.rejects(parseMobileDocument(new File(["old format"], "old.xls")), /另存为 DOCX、XLSX 或 PPTX/);
  const oversized = {name: "huge.txt", size: 41 * 1024 * 1024, arrayBuffer() { throw new Error("must not read"); }};
  await assert.rejects(parseMobileDocument(oversized), /40 MB/);
});

test("Office macro content, XML entities and external relationships fail closed", async () => {
  const macro = archive("macro.docx", {
    "word/document.xml": "<document><body><p><t>正文</t></p></body></document>",
    "word/vbaProject.bin": "macro",
  });
  await assert.rejects(parseMobileDocument(macro), /宏|可执行/);
  const entity = archive("entity.docx", {
    "word/document.xml": '<!DOCTYPE document [<!ENTITY xx "injected">]><document><body><p><t>&xx;</t></p></body></document>',
  });
  await assert.rejects(parseMobileDocument(entity), /XML 实体/);
  const external = archive("external.pptx", {
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="https://example.com/slide.xml"/></Relationships>',
  });
  await assert.rejects(parseMobileDocument(external), /关系不安全/);
});
