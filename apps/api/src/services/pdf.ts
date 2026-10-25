import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import PDFDocument from "pdfkit";
import { pool } from "../db.js";
import { ensureDocumentVersionInTransaction } from "./documents.js";
import { reconstructDocumentRevision } from "./documents.js";

const fontPath = fileURLToPath(new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url));
const s3Client = new S3Client({});

export interface GeneratedDocumentPdf {
  revision: number;
  content: string;
  buffer: Buffer;
}

type PdfArtifactState = "pending" | "generating" | "ready" | "failed";

interface PdfArtifactRow {
  id: string;
  s3_object_key: string;
  status: PdfArtifactState;
}

export interface PdfStorageClient {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export interface PreparedDocumentPdf {
  revision: number;
  objectKey: string;
  status: "preparing" | "ready" | "failed";
}

interface PrepareDocumentPdfOptions {
  bucket?: string;
  storage?: PdfStorageClient;
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

function objectKey(documentId: string, revision: number): string {
  return `documents/${documentId}/revisions/${revision}.pdf`;
}

function pdfBucket(bucket: string | undefined): string {
  if (!bucket?.trim()) {
    throw new Error("PDF_S3_BUCKET must be defined.");
  }
  return bucket;
}

async function claimPdfArtifact(
  documentId: string,
  revision: number
): Promise<{ artifact: PdfArtifactRow; claimed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureDocumentVersionInTransaction(client, documentId, revision);
    const key = objectKey(documentId, revision);
    await client.query(
      `INSERT INTO pdf_artifacts (id, document_id, revision, s3_object_key, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (document_id, revision) DO NOTHING`,
      [randomUUID(), documentId, revision, key]
    );
    const result = await client.query<PdfArtifactRow>(
      `SELECT id, s3_object_key, status
       FROM pdf_artifacts
       WHERE document_id = $1 AND revision = $2
       FOR UPDATE`,
      [documentId, revision]
    );
    const artifact = result.rows[0];
    if (artifact.status === "ready" || artifact.status === "generating") {
      await client.query("COMMIT");
      return { artifact, claimed: false };
    }

    await client.query(
      `UPDATE pdf_artifacts
       SET status = 'generating', generated_at = NULL
       WHERE id = $1 AND status IN ('pending', 'failed')`,
      [artifact.id]
    );
    await client.query("COMMIT");
    return { artifact: { ...artifact, status: "generating" }, claimed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setPdfArtifactStatus(
  artifactId: string,
  status: "ready" | "failed"
): Promise<void> {
  await pool.query(
    `UPDATE pdf_artifacts
     SET status = $2::varchar,
         generated_at = CASE WHEN $2::varchar = 'ready' THEN clock_timestamp() ELSE NULL END
     WHERE id = $1 AND status = 'generating'`,
    [artifactId, status]
  );
}

export async function prepareDocumentPdf(
  documentId: string,
  revision: number,
  options: PrepareDocumentPdfOptions = {}
): Promise<PreparedDocumentPdf> {
  const bucket = pdfBucket(options.bucket ?? process.env.PDF_S3_BUCKET);
  const { artifact, claimed } = await claimPdfArtifact(documentId, revision);
  if (!claimed) {
    return {
      revision,
      objectKey: artifact.s3_object_key,
      status: artifact.status === "ready" ? "ready" : "preparing"
    };
  }

  try {
    const pdf = await generateDocumentPdf(documentId, revision);
    await (options.storage ?? s3Client).send(new PutObjectCommand({
      Bucket: bucket,
      Key: artifact.s3_object_key,
      Body: pdf.buffer,
      ContentType: "application/pdf"
    }));
    await setPdfArtifactStatus(artifact.id, "ready");
    return { revision, objectKey: artifact.s3_object_key, status: "ready" };
  } catch {
    await setPdfArtifactStatus(artifact.id, "failed");
    return { revision, objectKey: artifact.s3_object_key, status: "failed" };
  }
}

export async function getPreparedDocumentPdf(
  objectKey: string,
  options: PrepareDocumentPdfOptions = {}
): Promise<Readable> {
  const result = await (options.storage ?? s3Client).send(new GetObjectCommand({
    Bucket: pdfBucket(options.bucket ?? process.env.PDF_S3_BUCKET),
    Key: objectKey
  })) as { Body?: unknown };
  if (!(result.Body instanceof Readable)) {
    throw new Error("PDF object body is unavailable.");
  }
  return result.Body;
}
