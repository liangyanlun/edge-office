import { unzipSync } from "fflate";

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
function decodePlain(buffer) {
  try { return decoder.decode(buffer); }
  catch { return new TextDecoder("gb18030", {fatal: true}).decode(buffer); }
}

function fail(message) { throw new Error(message); }
function nameExtension(name) { return String(name || "").toLowerCase().split(".").pop(); }
function parseXml(bytes, label) {
  if (!bytes) fail(label + " 结构缺失或文件损坏");
  const source = decoder.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail(label + " 包含不支持的 XML 实体");
  const xml = new DOMParser().parseFromString(source, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) fail(label + " XML 结构损坏");
  return xml;
}
function localName(node) { return (node?.localName || node?.tagName || "").split(":").pop(); }
function children(node, name) {
  return Array.from(node?.children || []).filter((child) => localName(child) === name);
}
function descendants(node, name) {
  const found = [];
  const visit = (parent) => {
    for (const child of Array.from(parent?.children || [])) {
      if (localName(child) === name) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}
function textRuns(node, textTag = "t") {
  return descendants(node, textTag).map((item) => item.textContent || "").join("").trim();
}
function unit(locator, text) {
  const value = String(text || "").trim();
  return value ? {locator, text: value} : null;
}
function readOfficeZip(buffer, requiredPrefix) {
  const data = new Uint8Array(buffer);
  if (data[0] !== 0x50 || data[1] !== 0x4b) fail("Office 文件不是有效的 OOXML 压缩包");
  let count = 0;
  let expanded = 0;
  let archive;
  try {
    archive = unzipSync(data, {filter(info) {
      count++;
      expanded += info.originalSize || 0;
      const name = info.name.replaceAll("\\", "/");
      if (count > 5000 || expanded > MAX_EXPANDED_BYTES) fail("Office 文件内部内容超过安全上限");
      if (name.startsWith("/") || name.split("/").includes("..")) fail("Office 文件内部路径不安全");
      const printer = /^(ppt|word|xl)\/printerSettings\/printerSettings\d+\.bin$/i.test(name);
      if (/vbaProject|\/(embeddings|activeX)\//i.test(name) || (/\.bin$/i.test(name) && !printer)) fail("不支持含宏或嵌入可执行对象的 Office 文件");
      return name.startsWith(requiredPrefix) && (name.endsWith(".xml") || name.endsWith(".rels"));
    }});
  } catch (error) { throw new Error(error.message || "Office 文件损坏，无法解析"); }
  return archive;
}

function parseDocx(buffer) {
  const zip = readOfficeZip(buffer, "word/");
  const document = parseXml(zip["word/document.xml"], "Word 正文");
  const body = descendants(document, "body")[0];
  if (!body) fail("Word 正文为空");
  const units = [];
  let paragraph = 0;
  let table = 0;
  for (const block of Array.from(body.children)) {
    if (localName(block) === "p") {
      paragraph++;
      const text = textRuns(block);
      const style = descendants(block, "pStyle")[0]?.getAttribute("w:val") || "";
      const found = unit(/Heading|标题/i.test(style) ? "标题 " + paragraph : "段落 " + paragraph, text);
      if (found) units.push(found);
    } else if (localName(block) === "tbl") {
      table++;
      const rows = children(block, "tr").map((row) => children(row, "tc").map((cell) => textRuns(cell)));
      const headers = rows[0] || [];
      rows.slice(1).forEach((row, index) => {
        const text = row.map((value, column) => value ? (headers[column] || "列 " + (column + 1)) + "：" + value : "").filter(Boolean).join("；");
        const found = unit("表格 " + table + " · 行 " + (index + 2), text);
        if (found) units.push(found);
      });
    }
  }
  return {units, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parser: "mobile-docx", extractionQuality: "native-structure"};
}

function parsePptx(buffer) {
  const zip = readOfficeZip(buffer, "ppt/");
  const fallbackSlides = Object.keys(zip).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  let slides = fallbackSlides;
  if (zip["ppt/presentation.xml"] && zip["ppt/_rels/presentation.xml.rels"]) {
    const presentation = parseXml(zip["ppt/presentation.xml"], "PPT 页面目录");
    const relationships = parseXml(zip["ppt/_rels/presentation.xml.rels"], "PPT 页面关系");
    const targets = new Map(descendants(relationships, "Relationship").map((item) => [item.getAttribute("Id"), item.getAttribute("Target")]));
    slides = descendants(presentation, "sldId").map((item) => {
      const target = targets.get(item.getAttribute("r:id"));
      if (!target || target.includes("..") || /^[a-z]+:/i.test(target)) fail("PPT 页面关系不安全或不完整");
      const path = target.startsWith("/") ? target.slice(1) : "ppt/" + target;
      if (!zip[path]) fail("PPT 页面结构缺失");
      return path;
    });
  }
  if (slides.length > 300) fail("PPT 超过 300 页限制");
  const units = slides.map((name, index) => {
    const slide = parseXml(zip[name], "PPT 第 " + (index + 1) + " 页");
    const shapes = descendants(slide, "sp").concat(descendants(slide, "graphicFrame"));
    const body = shapes.map((shape) => textRuns(shape)).filter(Boolean).join("\n");
    return unit("第 " + (index + 1) + " 页", body);
  }).filter(Boolean);
  return {units, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", parser: "mobile-pptx", extractionQuality: "native-structure"};
}

function columnIndex(reference) {
  const letters = (reference.match(/^[A-Z]+/i) || [""])[0].toUpperCase();
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}
function parseXlsx(buffer) {
  const zip = readOfficeZip(buffer, "xl/");
  const shared = zip["xl/sharedStrings.xml"] ? descendants(parseXml(zip["xl/sharedStrings.xml"], "Excel 字符串"), "si").map((item) => textRuns(item)) : [];
  const workbook = parseXml(zip["xl/workbook.xml"], "Excel 工作簿");
  const definitions = descendants(workbook, "sheet");
  const names = definitions.map((item) => item.getAttribute("name") || "工作表");
  const fallbackPaths = Object.keys(zip).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  let sheetPaths = fallbackPaths;
  if (zip["xl/_rels/workbook.xml.rels"]) {
    const relationships = parseXml(zip["xl/_rels/workbook.xml.rels"], "Excel 工作表关系");
    const targets = new Map(descendants(relationships, "Relationship").map((item) => [item.getAttribute("Id"), item.getAttribute("Target")]));
    sheetPaths = definitions.map((item) => {
      const target = targets.get(item.getAttribute("r:id"));
      if (!target || target.includes("..") || /^[a-z]+:/i.test(target)) fail("Excel 工作表关系不安全或不完整");
      const path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
      if (!zip[path]) fail("Excel 工作表结构缺失");
      return path;
    });
  }
  if (sheetPaths.length > 30) fail("Excel 超过 30 张工作表限制");
  const units = [];
  sheetPaths.forEach((path, sheetIndex) => {
    const sheet = parseXml(zip[path], "Excel 工作表");
    const rows = descendants(sheet, "row");
    if (rows.length > 5000) fail("Excel 单张工作表超过 5000 行限制");
    let headers = [];
    rows.forEach((row, rowIndex) => {
      const values = [];
      for (const cell of children(row, "c")) {
        const col = columnIndex(cell.getAttribute("r") || "");
        if (col < 0 || col >= 100) fail("Excel 数据列超过 100 列限制");
        const type = cell.getAttribute("t");
        let value = children(cell, "v")[0]?.textContent || "";
        if (type === "s") value = shared[Number(value)] || "";
        else if (type === "inlineStr") value = textRuns(cell);
        if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
        values[col] = value.trim();
      }
      if (rowIndex === 0) { headers = values; return; }
      const body = values.map((value, col) => value ? (headers[col] || "列 " + (col + 1)) + "：" + value : "").filter(Boolean).join("；");
      const found = unit("工作表 " + (names[sheetIndex] || sheetIndex + 1) + " · 行 " + (row.getAttribute("r") || rowIndex + 1), body);
      if (found) units.push(found);
    });
  });
  return {units, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", parser: "mobile-xlsx", extractionQuality: "native-structure"};
}

async function parsePdf(buffer) {
  if (!Uint8Array.prototype.toHex) {
    Object.defineProperty(Uint8Array.prototype, "toHex", {value() {
      return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }});
  }
  if (!Uint8Array.prototype.toBase64) {
    Object.defineProperty(Uint8Array.prototype, "toBase64", {value() {
      let text = "";
      for (let offset = 0; offset < this.length; offset += 8192) text += String.fromCharCode(...this.subarray(offset, offset + 8192));
      return btoa(text);
    }});
  }
  if (!Uint8Array.fromBase64) {
    Object.defineProperty(Uint8Array, "fromBase64", {value(text) { return Uint8Array.from(atob(text), (char) => char.charCodeAt(0)); }});
  }
  const pdfjs = await import("./vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
  let task;
  let pdf;
  try {
    task = pdfjs.getDocument({data: new Uint8Array(buffer), useSystemFonts: true, stopAtErrors: true});
    pdf = await task.promise;
    if (pdf.numPages > 200) fail("PDF 超过 200 页限制");
    const units = [];
    const emptyPages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts = [];
      for (const item of content.items) {
        if (typeof item.str === "string") parts.push(item.str + (item.hasEOL ? "\n" : " "));
      }
      const found = unit("第 " + pageNumber + " 页", parts.join("").replaceAll(/ {2,}/g, " "));
      if (found) units.push(found);
      else emptyPages.push(pageNumber);
      page.cleanup();
    }
    if (!units.length) fail("PDF 没有可提取的文本；扫描件需要 OCR，可在电脑端导入");
    return {
      units, mimeType: "application/pdf", parser: "pdfjs", extractionQuality: emptyPages.length ? "partial-text" : "native-text",
      warning: emptyPages.length ? "第 " + emptyPages.slice(0, 8).join("、") + " 页没有文本层，未参与检索；扫描页需 OCR。" : "",
      pageCount: pdf.numPages
    };
  } catch (error) {
    if (/password/i.test(String(error?.name || error?.message))) fail("加密 PDF 暂不能导入");
    throw error;
  } finally {
    if (task?.destroy) await task.destroy();
  }
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"' && quoted && raw[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && raw[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      if (rows.length > 5001) fail("CSV 超过 5000 行限制");
    } else field += char;
  }
  if (quoted) fail("CSV 引号未闭合");
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  const headers = rows[0] || [];
  const units = rows.slice(1).map((values, index) => unit("第 " + (index + 2) + " 行",
    values.map((value, col) => value ? (headers[col] || "列 " + (col + 1)) + "：" + value : "").filter(Boolean).join("；"))).filter(Boolean);
  return {units, mimeType: "text/csv", parser: "mobile-csv", extractionQuality: "native-structure"};
}

export async function parseMobileDocument(file) {
  if (!file?.name || !Number.isFinite(file.size) || file.size < 1) fail("文件为空");
  if (file.size > MAX_FILE_BYTES) fail("手机端单文件上限 40 MB");
  const ext = nameExtension(file.name);
  const buffer = await file.arrayBuffer();
  let result;
  if (ext === "docx") result = parseDocx(buffer);
  else if (ext === "pptx") result = parsePptx(buffer);
  else if (ext === "xlsx") result = parseXlsx(buffer);
  else if (ext === "pdf") result = await parsePdf(buffer);
  else if (ext === "xls" || ext === "doc" || ext === "ppt") fail("旧版 Office 格式暂不支持；请另存为 DOCX、XLSX 或 PPTX");
  else if (["txt", "md", "markdown", "csv", "html", "htm", "json"].includes(ext)) {
    const raw = decodePlain(buffer);
    if (ext === "csv") result = parseCsv(raw);
    else if (ext === "html" || ext === "htm") {
      const html = new DOMParser().parseFromString(raw, "text/html");
      html.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
      result = {units: [unit("网页正文", html.body?.textContent || html.documentElement?.textContent)], mimeType: "text/html", parser: "mobile-html", extractionQuality: "native-text"};
    } else result = {units: [unit("文本内容", raw)], mimeType: "text/plain", parser: "mobile-text", extractionQuality: "native-text"};
  } else fail("支持 TXT、Markdown、PDF、DOCX、XLSX、CSV、PPTX、HTML 和 JSON");
  const units = result.units.filter(Boolean);
  if (!units.length) fail("文件未提取到可检索内容，未写入知识库");
  if (units.reduce((sum, item) => sum + item.text.length, 0) > MAX_TEXT_CHARS) fail("提取的文字超过 200 万字符限制");
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const fileSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return {...result, units, fileSha256, fileSize: file.size};
}
