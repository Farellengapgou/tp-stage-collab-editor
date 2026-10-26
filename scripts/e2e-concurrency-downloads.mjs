import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

const baseUrl = (process.env.E2E_BASE_URL ?? "https://dlnopdrpomzao.cloudfront.net").replace(/\/$/, "");
const quota = 10;
const concurrency = 20;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const title = `E2E-CONCURRENCY downloads ${runId}`;
const email = `e2e.concurrency.${runId}@example.test`;

function isPdf(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
}

async function createPublication() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.getByLabel("Nom affiché").fill(`E2E-CONCURRENCY ${runId}`);
    await page.getByLabel("E-mail").fill(email);
    await page.getByRole("button", { name: "Accéder à mes documents" }).click();
    await page.getByRole("button", { name: "Nouveau document" }).click();
    const dialog = page.locator(".modal");
    await dialog.getByLabel("Titre").fill(title);
    await dialog.getByLabel("Description").fill(`Contrôle de quota AWS ${runId}`);
    await dialog.getByRole("button", { name: "Créer" }).click();
    const editor = page.locator("textarea.editor-input");
    await editor.fill(`E2E-CONCURRENCY contenu ${runId}`);
    await page.getByText("Enregistré", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Publier l’article" }).click();
    await dialog.getByLabel("Quota de téléchargements").fill(String(quota));
    await dialog.getByRole("button", { name: "Générer et publier" }).click();
    await dialog.getByText(/Publication créée à la révision/).waitFor({ timeout: 60_000 });
    const publicUrl = await dialog.getByLabel("Lien public").inputValue();
    const token = publicUrl.split("/").at(-1);
    if (!token) throw new Error("Publication token not found.");
    return { token, publicUrl };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function download(token, index, gate) {
  await gate;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/downloads/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() })
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const validPdf = response.status === 200 && contentType.includes("application/pdf") && isPdf(bytes);
    let body;
    if (!validPdf && bytes.length) {
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    const outcome = validPdf
      ? "pdf"
      : response.status === 410 && body?.status === "exhausted"
        ? "quota_exhausted"
        : response.status === 409 && body?.status === "temporarily_unavailable"
          ? "temporarily_unavailable"
          : response.status === 202 && body?.status === "preparing"
            ? "preparing"
            : "technical_error";
    return {
      index: index + 1,
      startedAt,
      status: response.status,
      contentType,
      bytes: bytes.length,
      durationMs: Math.round(performance.now() - started),
      validPdf,
      outcome,
      responseStatus: typeof body?.status === "string" ? body.status : undefined
    };
  } catch (error) {
    return {
      index: index + 1,
      startedAt,
      status: 0,
      contentType: "",
      bytes: 0,
      durationMs: Math.round(performance.now() - started),
      validPdf: false,
      outcome: "timeout_or_network_error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const publication = await createPublication();
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const requests = Array.from({ length: concurrency }, (_, index) => download(publication.token, index, gate));
release();
const results = await Promise.all(requests);
const summary = results.reduce((counts, result) => {
  counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return counts;
}, {});

process.stdout.write(`${JSON.stringify({
  runId,
  title,
  quota,
  concurrency,
  publicUrl: publication.publicUrl,
  results,
  summary
}, null, 2)}\n`);
