import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appendText, documentIdFromUrl, identify, waitForSaved, type TestEditor } from "./helpers";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner: TestEditor = {
  displayName: `E2E Propriétaire ${runId}`,
  email: `e2e.owner.${runId}@example.test`
};
const collaborator: TestEditor = {
  displayName: `E2E Collaborateur ${runId}`,
  email: `e2e.collaborator.${runId}@example.test`
};
const title = `E2E document ${runId}`;
const initialContent = `Persistance E2E ${runId}`;

let ownerContext: BrowserContext;
let collaboratorContext: BrowserContext;
let publicContext: BrowserContext;
let ownerPage: Page;
let collaboratorPage: Page;
let publicPage: Page;
let documentId = "";
let publicationToken = "";

test.describe.serial("Collab Editor public E2E", () => {
  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({ acceptDownloads: true });
    collaboratorContext = await browser.newContext({ acceptDownloads: true });
    publicContext = await browser.newContext({ acceptDownloads: true });
    ownerPage = await ownerContext.newPage();
    collaboratorPage = await collaboratorContext.newPage();
    publicPage = await publicContext.newPage();
  });

  test.afterAll(async () => {
    await Promise.all([ownerContext.close(), collaboratorContext.close(), publicContext.close()]);
  });

  test("E2E-01 accès public", async ({ baseURL }) => {
    await ownerPage.goto(baseURL!);
    await expect(ownerPage.getByRole("heading", { name: "Bienvenue" })).toBeVisible();
    await expect(ownerPage).toHaveTitle(/Collab Editor/i);
  });

  test("E2E-02 identification déclarative", async () => {
    await identify(ownerPage, owner);
    await identify(collaboratorPage, collaborator);
    await expect(ownerPage.getByText(owner.email, { exact: true })).toBeVisible();
    await expect(collaboratorPage.getByText(collaborator.email, { exact: true })).toBeVisible();
  });

  test("E2E-03 création d’un document", async () => {
    await ownerPage.getByRole("button", { name: "Nouveau document" }).click();
    const dialog = ownerPage.locator(".modal");
    await dialog.getByLabel("Titre").fill(title);
    await dialog.getByLabel("Description").fill(`Document isolé ${runId}`);
    await dialog.getByRole("button", { name: "Créer" }).click();
    await expect(ownerPage.getByRole("heading", { name: title })).toBeVisible();
    documentId = documentIdFromUrl(ownerPage);
    await expect(ownerPage.locator("textarea.editor-input")).toBeEnabled();
  });

  test("E2E-04 persistance après rechargement", async () => {
    const editor = ownerPage.locator("textarea.editor-input");
    await editor.fill(initialContent);
    await waitForSaved(ownerPage);
    await ownerPage.reload();
    await expect(editor).toHaveValue(initialContent);
    await waitForSaved(ownerPage);
  });

  test("E2E-05 partage avec un rédacteur existant", async () => {
    await ownerPage.getByRole("button", { name: "Partager" }).click();
    const dialog = ownerPage.locator(".modal");
    await dialog.getByLabel("E-mail du rédacteur existant").fill(collaborator.email);
    await dialog.getByRole("button", { name: "Ajouter" }).click();
    await expect(dialog).toBeHidden();
    await collaboratorPage.goto(`/#/documents/${documentId}`);
    await expect(collaboratorPage.getByRole("heading", { name: title })).toBeVisible();
    await expect(collaboratorPage.locator("textarea.editor-input")).toHaveValue(initialContent);
  });

  test("E2E-06 synchronisation temps réel", async () => {
    const synchronizedText = `\nSynchronisation A ${runId}`;
    await appendText(ownerPage, synchronizedText);
    await expect(collaboratorPage.locator("textarea.editor-input")).toHaveValue(`${initialContent}${synchronizedText}`);
  });

  test("E2E-07 modifications concurrentes convergentes", async () => {
    const ownerEditor = ownerPage.locator("textarea.editor-input");
    const collaboratorEditor = collaboratorPage.locator("textarea.editor-input");
    const ownerText = ` A-${runId}`;
    const collaboratorText = ` B-${runId}`;
    await Promise.all([
      appendText(ownerPage, ownerText),
      appendText(collaboratorPage, collaboratorText)
    ]);
    const ownerValue = await ownerEditor.inputValue();
    expect(ownerValue).toContain(ownerText);
    expect(ownerValue).toContain(collaboratorText);
    await expect(collaboratorEditor).toHaveValue(ownerValue);
  });

  test("E2E-09 historique et E2E-10 restauration", async () => {
    await ownerPage.getByRole("button", { name: "Historique" }).click();
    const dialog = ownerPage.locator(".modal");
    const firstRevision = dialog.getByRole("button", { name: /^Révision 1/ });
    await expect(firstRevision).toBeVisible();
    await firstRevision.click();
    await expect(dialog.locator(".revision-preview")).toContainText(initialContent);
    await dialog.getByRole("button", { name: "Restaurer" }).click();
    await expect(dialog).toBeHidden();
    await expect(ownerPage.locator("textarea.editor-input")).toHaveValue(initialContent);
    await expect(collaboratorPage.locator("textarea.editor-input")).toHaveValue(initialContent);
  });

  test("E2E-15 Unicode", async () => {
    const unicode = " — café, déjà vu, € et 漢字";
    await appendText(ownerPage, unicode);
    await expect(collaboratorPage.locator("textarea.editor-input")).toHaveValue(`${initialContent}${unicode}`);
  });

  test("E2E-13 publication PDF et E2E-14 quota", async () => {
    await ownerPage.getByRole("button", { name: "Publier l’article" }).click();
    const dialog = ownerPage.locator(".modal");
    await dialog.getByLabel("Quota de téléchargements").fill("2");
    await dialog.getByRole("button", { name: "Générer et publier" }).click();
    await expect(dialog.getByText(/Publication créée à la révision/)).toBeVisible({ timeout: 60_000 });
    const link = await dialog.getByLabel("Lien public").inputValue();
    publicationToken = link.split("/").at(-1)!;
    await dialog.getByRole("button", { name: "Fermer" }).click();

    await publicPage.goto(`/#/journal/${publicationToken}`);
    await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    const firstDownload = publicPage.waitForEvent("download", { timeout: 60_000 });
    await publicPage.getByRole("button", { name: "Télécharger PDF" }).click();
    expect((await firstDownload).suggestedFilename()).toMatch(/\.pdf$/i);

    const updated = " Version PDF actuelle";
    await appendText(ownerPage, updated);
    await publicPage.reload();
    await expect(publicPage.getByText("1/2 téléchargements consommés")).toBeVisible();
    const secondDownload = publicPage.waitForEvent("download", { timeout: 60_000 });
    await publicPage.getByRole("button", { name: "Télécharger PDF" }).click();
    expect((await secondDownload).suggestedFilename()).toMatch(/\.pdf$/i);
    await publicPage.reload();
    await expect(publicPage.getByRole("button", { name: "Quota atteint" })).toBeDisabled();
  });
});

test("E2E-08 présence et curseur distant", async ({ browser }) => {
  test.setTimeout(45_000);
  const ownerPresenceContext = await browser.newContext();
  const collaboratorPresenceContext = await browser.newContext();
  const ownerPresencePage = await ownerPresenceContext.newPage();
  const collaboratorPresencePage = await collaboratorPresenceContext.newPage();
  await identify(ownerPresencePage, owner);
  await identify(collaboratorPresencePage, collaborator);
  await ownerPresencePage.goto(`/#/documents/${documentId}`);
  await collaboratorPresencePage.goto(`/#/documents/${documentId}`);
  const collaboratorEditor = collaboratorPresencePage.locator("textarea.editor-input");
  const marker = "¤";
  await collaboratorEditor.focus();
  await collaboratorEditor.press("End");
  await collaboratorEditor.pressSequentially(marker);
  await expect.poll(() => ownerPresencePage.locator("textarea.editor-input").inputValue()).toContain(marker);
  await expect(ownerPresencePage.getByLabel(collaborator.displayName)).toBeVisible();
  await expect(ownerPresencePage.locator(`.remote-cursor[data-editor="${collaborator.displayName}"]`)).toBeVisible();
  await Promise.all([ownerPresenceContext.close(), collaboratorPresenceContext.close()]);
});

test("E2E-11 crédit quotidien", async () => {
  test.skip(true, "Le solde de crédit n’est pas exposé dans l’interface ; le test de limite 10 000 est irréversible.");
});

test("E2E-12 crédit partagé entre sessions", async () => {
  test.skip(true, "Le solde de crédit n’est pas exposé dans l’interface.");
});
