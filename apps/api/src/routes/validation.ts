import { HttpError } from "../services/errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function bodyRecord(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new HttpError(400, "Invalid request body.");
  }

  return value as Record<string, unknown>;
}

export function requiredText(
  body: Record<string, unknown>,
  key: string,
  maxLength: number
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new HttpError(400, `${key} is required.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpError(400, `${key} is invalid.`);
  }

  return normalized;
}

export function optionalText(
  body: Record<string, unknown>,
  key: string,
  maxLength: number
): string {
  const value = body[key];
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, `${key} is invalid.`);
  }

  return value.trim();
}

export function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new HttpError(400, `${name} is invalid.`);
  }

  return value;
}
