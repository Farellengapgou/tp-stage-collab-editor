import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { reconstructDocumentRevision } from "./documents.js";

const fontPath = fileURLToPath(new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url));

export interface GeneratedDocumentPdf {
  revision: number;
  content: string;
  buffer: Buffer;
}

export async function generateDocumentPdf(
  documentId: string,
  revision: number
): Promise<GeneratedDocumentPdf> {
  const documentRevision = await reconstructDocumentRevision(documentId, revision);
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({
      compress: false,
      info: { Title: `Document revision ${revision}` },
      margin: 54
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.font(fontPath).fontSize(18).text(`Revision ${revision}`);
    pdf.moveDown();
    pdf.fontSize(12).text(documentRevision.content);
    pdf.end();
  });

  return { revision, content: documentRevision.content, buffer };
}
