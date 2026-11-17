// Makes the tiny documents the extractor tests read (node make.mjs, from this folder).
// Hand-built so nothing third-party is checked in: a two-page PDF with an Info
// title, and minimal but valid Word, PowerPoint, Excel and OpenDocument files
// (each opens in its app). doc.docm carries a stand-in vbaProject.bin the
// extractor must never touch.

import { writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const here = new URL(".", import.meta.url);

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, typeof text === "string" ? "utf8" : undefined);
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (...r) => `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join("")}</Relationships>`;
const core = (title, keywords) =>
  `${xml}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><cp:keywords>${keywords}</cp:keywords></cp:coreProperties>`;
const coreRel = '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>';
const types = (...o) =>
  `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${o.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("")}</Types>`;

// ---------- Word ----------
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = {
  "[Content_Types].xml": types(["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"], ["/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"]),
  "_rels/.rels": rels(rel("rId1", "officeDocument", "word/document.xml")).replace("</Relationships>", `${coreRel}</Relationships>`),
  "docProps/core.xml": core("Zephyrine bracket", "assembly, brackets"),
  "word/_rels/document.xml.rels": rels(rel("rId1", "footer", "footer1.xml")),
  "word/document.xml": `${xml}<w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>` +
    `<w:p><w:r><w:t>Zephyrine bracket assembly</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Torque the M6 bolts to </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>9 Nm</w:t></w:r><w:r><w:tab/><w:t>then check &amp; sign.</w:t></w:r></w:p>` +
    `<w:sectPr><w:footerReference w:type="default" r:id="rId1"/></w:sectPr></w:body></w:document>`,
  "word/footer1.xml": `${xml}<w:ftr ${W}><w:p><w:r><w:t>Form Industries internal</w:t></w:r></w:p></w:ftr>`,
};
writeFileSync(new URL("doc.docx", here), zip(docx));
writeFileSync(new URL("doc.docm", here), zip({ ...docx, "word/vbaProject.bin": Buffer.from("Attribute VB_Name = \"AutoOpen\"\nShell \"calc.exe\"\n") }));

// ---------- PowerPoint ----------
const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (...lines) => `${xml}<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
writeFileSync(
  new URL("deck.pptx", here),
  zip({
    "[Content_Types].xml": types(
      ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
      ["/ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
      ["/ppt/slides/slide2.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
      ["/ppt/slides/slide10.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
    ),
    "_rels/.rels": rels(rel("rId1", "officeDocument", "ppt/presentation.xml")).replace("</Relationships>", `${coreRel}</Relationships>`),
    "docProps/core.xml": core("Halvorsen roadmap", "roadmap"),
    "ppt/presentation.xml": `${xml}<p:presentation ${P}/>`,
    "ppt/slides/slide1.xml": slide("Halvorsen roadmap", "Q1: intake redesign"),
    "ppt/slides/slide2.xml": slide("Q2: pilot line &lt;Kapaa&gt;"),
    "ppt/slides/slide10.xml": slide("Q4: ship"),
  }),
);

// ---------- Excel ----------
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
writeFileSync(
  new URL("parts.xlsx", here),
  zip({
    "[Content_Types].xml": types(
      ["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
      ["/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],
      ["/xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"],
    ),
    "_rels/.rels": rels(rel("rId1", "officeDocument", "xl/workbook.xml")).replace("</Relationships>", `${coreRel}</Relationships>`),
    "docProps/core.xml": core("Parts list", ""),
    "xl/_rels/workbook.xml.rels": rels(rel("rId1", "worksheet", "worksheets/sheet1.xml"), rel("rId2", "sharedStrings", "sharedStrings.xml")),
    "xl/workbook.xml": `${xml}<workbook ${S} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BOM" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `${xml}<sst ${S} count="3" uniqueCount="3"><si><t>Part</t></si><si><t>Qty</t></si><si><r><t>Ventura </t></r><r><t>gasket</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `${xml}<worksheet ${S}><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
      `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c><c r="C2" t="inlineStr"><is><t>03304-10027</t></is></c></row>` +
      `</sheetData></worksheet>`,
  }),
);

// ---------- OpenDocument text ----------
writeFileSync(
  new URL("notes.odt", here),
  zip({
    mimetype: "application/vnd.oasis.opendocument.text",
    "META-INF/manifest.xml": `${xml}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    "content.xml": `${xml}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:h>Marrowind test log</text:h><text:p>Fan ran<text:s/>at 2400 rpm.</text:p></office:text></office:body></office:document-content>`,
  }),
);

// ---------- PDF: two pages, Helvetica, an Info title ----------
function pdf(pages, title) {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const lines of pages) {
    const stream = `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${title}) /Producer (Foundation test fixture) >>`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
writeFileSync(
  new URL("spec.pdf", here),
  pdf(
    [
      ["Kestrelmount intake duct", "Torque spec: 42 Nm on the clamp bands."],
      ["Page two: the Osterlund fan shroud", "is printed in PETG."],
    ],
    "Kestrelmount spec sheet",
  ),
);
// not a PDF at all, named like one
writeFileSync(new URL("broken.pdf", here), Buffer.from("%PDF-1.4\nthis is not really a pdf\n"));
console.log("fixtures written");
