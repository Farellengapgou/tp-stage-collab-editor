import { chromium } from "@playwright/test";

const baseUrl = (process.env.E2E_BASE_URL ?? "https://dlnopdrpomzao.cloudfront.net").replace(/\/$/, "");
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const results = { runId, baseUrl, scenarios: [] };

function editor(index) {
  return {
    displayName: `E2E-CONCURRENCY editor ${index} ${runId}`,
    email: `e2e.concurrency.editor${index}.${runId}@example.test`
  };
}

function documentId(page) {
  const match = page.url().match(/#\/documents\/([0-9a-f-]{36})$/i);
  if (!match) throw new Error(`Document URL not found: ${page.url()}`);
  return match[1];
}

async function identify(page, account) {
  await page.goto(baseUrl);
  await page.getByLabel("Nom affiché").fill(account.displayName);
  await page.getByLabel("E-mail").fill(account.email);
  await page.getByRole("button", { name: "Accéder à mes documents" }).click();
  await page.getByRole("heading", { name: "Mes documents" }).waitFor();
}

async function waitUntil(predicate, message, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function values(pages) {
  return Promise.all(pages.map((page) => page.locator("textarea.editor-input").inputValue()));
}

async function revisions(pages) {
  return Promise.all(pages.map(async (page) => {
    const text = await page.locator(".connection").textContent();
    const match = text?.match(/Révision (\d+)/);
    return match ? Number(match[1]) : -1;
  }));
}

async function assertConverged(pages, required) {
  await waitUntil(async () => {
    const current = await values(pages);
    return new Set(current).size === 1 && required.every((entry) => current[0].includes(entry));
  }, `Expected converged content containing: ${required.join(", ")}`);
  return values(pages);
}

async function appendConcurrently(pages, entries) {
  await Promise.all(pages.map((page) => page.locator("textarea.editor-input").press("End")));
  await Promise.all(pages.map((page, index) => page.locator("textarea.editor-input").pressSequentially(entries[index])));
}

async function createSharedDocument(browser, participantCount, label) {
  const accounts = Array.from({ length: participantCount }, (_, index) => editor(index + 1));
  const contexts = await Promise.all(accounts.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  await Promise.all(pages.map((page, index) => identify(page, accounts[index])));

  const ownerPage = pages[0];
  const title = `E2E-CONCURRENCY ${label} ${runId}`;
  await ownerPage.getByRole("button", { name: "Nouveau document" }).click();
  const dialog = ownerPage.locator(".modal");
  await dialog.getByLabel("Titre").fill(title);
  await dialog.getByLabel("Description").fill(`Concurrence ShareDB ${label}`);
  await dialog.getByRole("button", { name: "Créer" }).click();
  await ownerPage.waitForURL(/#\/documents\/[0-9a-f-]{36}$/i);
  const id = documentId(ownerPage);
  await ownerPage.locator("textarea.editor-input").fill(`BASE ${label} DELETE-ME`);
  await ownerPage.getByText("Enregistré", { exact: true }).waitFor();

  for (let index = 1; index < accounts.length; index++) {
    await ownerPage.getByRole("button", { name: "Partager" }).click();
    const share = ownerPage.locator(".modal");
    await share.getByLabel("E-mail du rédacteur existant").fill(accounts[index].email);
    await share.getByRole("button", { name: "Ajouter" }).click();
    await share.waitFor({ state: "hidden" });
  }

  await Promise.all(pages.slice(1).map((page) => page.goto(`${baseUrl}/#/documents/${id}`)));
  await Promise.all(pages.map((page) => page.locator("textarea.editor-input").waitFor({ state: "visible" })));
  await waitUntil(async () => (await values(pages)).every((value) => value === `BASE ${label} DELETE-ME`), "Shared initial state did not converge.");
  return { contexts, pages, title, id };
}

async function runTwoEditorScenario(browser) {
  const shared = await createSharedDocument(browser, 2, "two-editors");
  try {
    const initialRevision = await revisions(shared.pages);
    const distinct = [` [A-DIFF-${runId}]`, ` [B-DIFF-${runId}]`];
    await appendConcurrently(shared.pages, distinct);
    const afterDistinct = await assertConverged(shared.pages, distinct);

    const same = [`[A-SAME-${runId}]`, `[B-SAME-${runId}]`];
    await Promise.all(shared.pages.map((page) => page.locator("textarea.editor-input").press("Control+Home")));
    await Promise.all(shared.pages.map((page, index) => page.locator("textarea.editor-input").pressSequentially(same[index])));
    const afterSame = await assertConverged(shared.pages, [...distinct, ...same]);

    const owner = shared.pages[0].locator("textarea.editor-input");
    const collaborator = shared.pages[1].locator("textarea.editor-input");
    const deletionStart = (await collaborator.inputValue()).indexOf("DELETE-ME");
    if (deletionStart < 0) throw new Error("Deletion marker not found.");
    await Promise.all([
      owner.press("Control+Home").then(() => owner.pressSequentially(`[INSERT-${runId}]`)),
      collaborator.evaluate((element, range) => {
        element.focus();
        element.setSelectionRange(range.start, range.end);
      }, { start: deletionStart, end: deletionStart + "DELETE-ME".length }).then(() => collaborator.press("Backspace"))
    ]);
    const afterInsertDelete = await assertConverged(shared.pages, [...distinct, ...same, `[INSERT-${runId}]`]);
    if (afterInsertDelete[0].includes("DELETE-ME")) throw new Error("Concurrent deletion was lost.");

    const rapid = [` [RAPID-A1-${runId}] [RAPID-A2-${runId}]`, ` [RAPID-B1-${runId}] [RAPID-B2-${runId}]`];
    await appendConcurrently(shared.pages, rapid);
    const finalValues = await assertConverged(shared.pages, [...distinct, ...same, `[INSERT-${runId}]`, ...rapid]);
    const finalRevision = await revisions(shared.pages);
    await Promise.all(shared.pages.map((page) => page.reload()));
    const reloadedValues = await assertConverged(shared.pages, [...distinct, ...same, `[INSERT-${runId}]`, ...rapid]);
    results.scenarios.push({
      name: "two_editors",
      documentId: shared.id,
      initialRevision,
      finalRevision,
      distinct,
      same,
      finalLength: finalValues[0].length,
      persistedLength: reloadedValues[0].length,
      outcome: "pass"
    });
  } finally {
    await Promise.all(shared.contexts.map((context) => context.close()));
  }
}

async function runFiveEditorScenario(browser) {
  const shared = await createSharedDocument(browser, 5, "five-editors");
  try {
    const initialRevision = await revisions(shared.pages);
    const entries = shared.pages.map((_, index) => ` [FIVE-${index + 1}-${runId}]`);
    await appendConcurrently(shared.pages, entries);
    const finalValues = await assertConverged(shared.pages, entries, 30_000);
    const finalRevision = await revisions(shared.pages);
    await Promise.all(shared.pages.map((page) => page.reload()));
    const reloadedValues = await assertConverged(shared.pages, entries, 30_000);
    results.scenarios.push({
      name: "five_editors",
      documentId: shared.id,
      initialRevision,
      finalRevision,
      entries,
      finalLength: finalValues[0].length,
      persistedLength: reloadedValues[0].length,
      outcome: "pass"
    });
  } finally {
    await Promise.all(shared.contexts.map((context) => context.close()));
  }
}

const browser = await chromium.launch();
try {
  await runTwoEditorScenario(browser);
  await runFiveEditorScenario(browser);
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
