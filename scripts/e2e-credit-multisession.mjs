import { chromium } from "@playwright/test";

const baseUrl = (process.env.E2E_BASE_URL ?? "https://dlnopdrpomzao.cloudfront.net").replace(/\/$/, "");
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const identity = {
  displayName: `E2E-CONCURRENCY credit ${runId}`,
  email: `e2e.concurrency.credit.${runId}@example.test`
};

function documentId(page) {
  const match = page.url().match(/#\/documents\/([0-9a-f-]{36})$/i);
  if (!match) throw new Error(`Document URL not found: ${page.url()}`);
  return match[1];
}

async function identify(page) {
  await page.goto(baseUrl);
  await page.getByLabel("Nom affiché").fill(identity.displayName);
  await page.getByLabel("E-mail").fill(identity.email);
  await page.getByRole("button", { name: "Accéder à mes documents" }).click();
  await page.getByRole("heading", { name: "Mes documents" }).waitFor();
}

async function waitForValue(page, expected) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await page.locator("textarea.editor-input").inputValue() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Shared-session text did not converge.");
}

const browser = await chromium.launch();
const firstContext = await browser.newContext();
const secondContext = await browser.newContext();
try {
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await identify(first);
  await identify(second);
  const title = `E2E-CONCURRENCY credit ${runId}`;
  await first.getByRole("button", { name: "Nouveau document" }).click();
  const dialog = first.locator(".modal");
  await dialog.getByLabel("Titre").fill(title);
  await dialog.getByRole("button", { name: "Créer" }).click();
  await first.waitForURL(/#\/documents\/[0-9a-f-]{36}$/i);
  const id = documentId(first);
  await first.locator("textarea.editor-input").fill(`E2E-CONCURRENCY credit base ${runId}`);
  await first.getByText("Enregistré", { exact: true }).waitFor();
  await second.goto(`${baseUrl}/#/documents/${id}`);
  await second.locator("textarea.editor-input").waitFor({ state: "visible" });

  const firstEntry = " [SESSION-A]";
  const secondEntry = " [SESSION-B]";
  await first.locator("textarea.editor-input").press("End");
  await first.locator("textarea.editor-input").pressSequentially(firstEntry);
  const afterFirst = await first.locator("textarea.editor-input").inputValue();
  await waitForValue(second, afterFirst);
  await second.locator("textarea.editor-input").press("End");
  await second.locator("textarea.editor-input").pressSequentially(secondEntry);
  const finalText = await second.locator("textarea.editor-input").inputValue();
  await waitForValue(first, finalText);
  await Promise.all([first.reload(), second.reload()]);
  await Promise.all([waitForValue(first, finalText), waitForValue(second, finalText)]);
  process.stdout.write(`${JSON.stringify({ runId, documentId: id, finalLength: finalText.length, outcome: "pass" }, null, 2)}\n`);
} finally {
  await Promise.all([firstContext.close(), secondContext.close()]);
  await browser.close();
}
