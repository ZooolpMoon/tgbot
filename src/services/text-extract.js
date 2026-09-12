// ==========================================
// 📄 文档正文抽取（知识库上传用）
//
// 支持：
//   • 纯文本：.txt .md .csv .json .log .yml .yaml（直接 UTF-8 解码）
//   • Word：  .docx（本质是 zip，取出 word/document.xml 再剥标签）
//   • PDF：   .pdf（尽力抽取「文本层」：解压内容流 + 解析 Tj/TJ 文本操作符）
//
// 说明：纯 JS 解析 PDF 不可能覆盖全部情况（扫描件、加密、特殊字体编码都不行），
// 所以这里的原则是「能抽就抽，抽不出来就明确告诉管理员改成文本再传」。
// ==========================================

/** 支持的扩展名 → 解析方式 */
export const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yml", ".yaml"];
export const DOCX_EXTENSIONS = [".docx"];
export const PDF_EXTENSIONS = [".pdf"];

/** 由文件名/MIME 判断如何处理 */
export function detectFileKind(fileName = "", mimeType = "") {
  const name = String(fileName || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (DOCX_EXTENSIONS.some((e) => name.endsWith(e))) return "docx";
  if (PDF_EXTENSIONS.some((e) => name.endsWith(e))) return "pdf";
  if (TEXT_EXTENSIONS.some((e) => name.endsWith(e))) return "text";
  if (mime.startsWith("text/")) return "text";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime === "application/pdf") return "pdf";
  return "unknown";
}

/** 解开 XML 实体 */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** docx 的 document.xml → 纯文本（段落换行、表格用制表符） */
export function docxXmlToText(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- 极简 ZIP 读取（只为了拿 word/document.xml）----------

function u16(view, offset) {
  return view.getUint16(offset, true);
}
function u32(view, offset) {
  return view.getUint32(offset, true);
}

/** deflate-raw 解压（Workers 与 Node 18+ 都支持 DecompressionStream） */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 从 zip 里取出指定文件（找不到返回 null） */
async function readZipEntry(buffer, targetName) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;

  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (u32(view, offset) !== 0x02014b50) return null;
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (name === targetName) {
      // 本地文件头长度不固定，按它自己的 name/extra 长度定位数据
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return new TextDecoder("utf-8").decode(raw);
      if (method === 8) return new TextDecoder("utf-8").decode(await inflateRaw(raw));
      return null;
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** 解析 .docx → 文本 */
export async function extractDocxText(buffer) {
  const xml = await readZipEntry(buffer, "word/document.xml");
  if (!xml) return { ok: false, error: "无法解析这个 .docx（可能是 .doc 老格式，请另存为 .docx 或文本）" };
  const text = docxXmlToText(xml);
  if (!text) return { ok: false, error: "文档里没有可提取的文字" };
  return { ok: true, text, kind: "docx" };
}

// ---------- PDF ----------

/**
 * 真正的 ISO-8859-1 解码（逐字节 → 字符）。
 * 注意：TextDecoder 的 "latin1" 实际是 windows-1252，会把 0x80-0x9F 映射成 €、™ 等字符，
 * 导致后面无法把字符还原成原始字节，所以这里手动转换。
 */
function bytesToLatin1String(bytes) {
  let out = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return out;
}

/** PDF 字符串里的转义（\n \r \t \\ \( \) \ddd） */
function unescapePdfString(raw) {
  return String(raw).replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, code) => {
    switch (code) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "(": return "(";
      case ")": return ")";
      case "\\": return "\\";
      default: return String.fromCharCode(Number.parseInt(code, 8) & 0xff);
    }
  });
}

/** 从内容流里抽取可读文本（Tj / TJ / ' / " 操作符） */
export function pdfContentToText(content) {
  const out = [];
  // 括号字符串
  const stringRe = /\((?:\\.|[^\\()])*\)/g;
  const hexRe = /<([0-9A-Fa-f\s]+)>/g;

  // 逐行处理，尽量保留换行结构
  const lines = String(content).split(/\r?\n/);
  for (const line of lines) {
    // 文本操作符可能不在行尾（例如 "… Tj ET" 写在同一行），因此按「是否包含」判断
    const isTextOp = /(Tj|TJ)/.test(line) || /['"]\s*$/.test(line.trim());
    if (!isTextOp) continue;

    let text = "";
    for (const m of line.matchAll(stringRe)) {
      text += unescapePdfString(m[0].slice(1, -1));
    }
    if (!text) {
      for (const m of line.matchAll(hexRe)) {
        const hex = m[1].replace(/\s+/g, "");
        // 常见情况：UTF-16BE
        let decoded = "";
        for (let i = 0; i + 1 < hex.length; i += 2) {
          const code = Number.parseInt(hex.slice(i, i + 2), 16);
          if (code === 0) continue;
          decoded += String.fromCharCode(code);
        }
        text += decoded;
      }
    }
    if (text.trim()) out.push(text.trim());
  }
  return repairLatin1Mojibake(out.join("\n").trim());
}

/**
 * 有些 PDF 把 UTF-8 文本直接塞进字符串，按 Latin-1 读出来就是乱码（"é€€è´§"）。
 * 这里检测一下：如果按 UTF-8 重新解码后中文比例更高，就采用修复结果。
 */
function repairLatin1Mojibake(text) {
  if (!/[\u00c0-\u00ff]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (decoded.includes("\uFFFD")) return text;
    const before = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const after = (decoded.match(/[\u4e00-\u9fa5]/g) || []).length;
    return after > before ? decoded : text;
  } catch {
    return text;
  }
}

/** 解析 .pdf → 文本（尽力而为，扫不出文字层时给出明确提示） */
export async function extractPdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const latin = bytesToLatin1String(bytes);
  const chunks = [];

  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  for (const m of latin.matchAll(streamRe)) {
    const start = m.index + m[0].indexOf(m[1]);
    const raw = bytes.subarray(start, start + m[1].length);
    let text = "";

    // 先试 FlateDecode（绝大多数 PDF 都是）
    try {
      const inflated = bytesToLatin1String(await inflateRaw(raw));
      text = pdfContentToText(inflated);
    } catch {
      text = pdfContentToText(m[1]);
    }
    if (text) chunks.push(text);
  }

  const text = chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 30) {
    return {
      ok: false,
      error: "这个 PDF 里没有可提取的文字层（可能是扫描件/图片版或加密文档）。请用 OCR 转成文本后再上传。"
    };
  }
  return { ok: true, text, kind: "pdf" };
}

/**
 * 统一入口：按文件类型抽取正文。
 * @returns {Promise<{ok:boolean, text?:string, kind?:string, error?:string}>}
 */
export async function extractTextFromFile({ buffer, fileName = "", mimeType = "" }) {
  if (!buffer) return { ok: false, error: "文件内容为空" };
  const kind = detectFileKind(fileName, mimeType);

  try {
    if (kind === "text") {
      const text = new TextDecoder("utf-8").decode(buffer).replace(/\u0000/g, "").trim();
      if (!text) return { ok: false, error: "文件里没有文字" };
      return { ok: true, text, kind: "text" };
    }
    if (kind === "docx") return await extractDocxText(buffer);
    if (kind === "pdf") return await extractPdfText(buffer);
    return {
      ok: false,
      error: "只支持文本类文件（.txt / .md / .csv / .json）与 .docx / .pdf"
    };
  } catch (e) {
    return { ok: false, error: `解析失败：${String(e?.message || e)}` };
  }
}
