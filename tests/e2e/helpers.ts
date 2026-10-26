import { expect, type Page } from "@playwright/test";

export interface TestEditor {
  displayName: string;
  email: string;
}

export async function identify(page: Page, editor: TestEditor): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bienvenue" })).toBeVisible();
  await page.getByLabel("Nom affiché").fill(editor.displayName);
  await page.getByLabel("E-mail").fill(editor.email);
  await page.getByRole("button", { name: "Accéder à mes documents" }).click();
  await expect(page.getByRole("heading", { name: "Mes documents" })).toBeVisible();
}

export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByText("Enregistré", { exact: true })).toBeVisible();
}

export function documentIdFromUrl(page: Page): string {
  const match = page.url().match(/#\/documents\/([0-9a-f-]{36})$/i);
  if (!match) throw new Error(`Document URL not found: ${page.url()}`);
  return match[1];
}

export async function appendText(page: Page, text: string): Promise<void> {
  const editor = page.locator("textarea.editor-input");
  await editor.focus();
  await editor.press("End");
  await editor.pressSequentially(text);
  await waitForSaved(page);
}
