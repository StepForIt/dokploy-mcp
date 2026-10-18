// Normed comments written above a variable, read and written by the secret tools:
//   # STRIPE_KEY exp : 10/12/2026                       expiry (DD/MM/YYYY)
//   # PAY_SECRET src : projet/environnement/ressource/STRIPE_KEY   where the value was copied from
// The comment names its variable, so it still works if it drifts away from it.

export type AnnotationTag = "exp" | "src";

export interface Annotation {
  key: string;
  tag: AnnotationTag;
  value: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ANNOTATION_LINE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_.-]*)\s+(exp|src)\s*:\s*(.*?)\s*$/i;
const MS_PER_DAY = 86_400_000;

export function parseAnnotation(line: string): Annotation | null {
  const m = line.match(ANNOTATION_LINE);
  if (!m) return null;
  return {
    key: m[1] as string,
    tag: (m[2] as string).toLowerCase() as AnnotationTag,
    value: m[3] as string,
  };
}

export function formatAnnotation(key: string, tag: AnnotationTag, value: string): string {
  return `# ${key} ${tag} : ${value}`;
}

/** DD/MM/YYYY to UTC midnight; null when malformed or not a real calendar date. */
export function parseExpiry(text: string): Date | null {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

export function formatExpiry(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/** Whole days from `now` (UTC day) to the expiry day: 0 on the day itself, negative once past. */
export function daysUntil(expiry: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((expiry.getTime() - today) / MS_PER_DAY);
}

export interface VarRef {
  project: string;
  environment: string;
  resource: string;
  key: string;
}

const escapeName = (name: string) => name.replace(/%/g, "%25").replace(/\//g, "%2F");
const unescapeName = (name: string) => name.replace(/%2F/g, "/").replace(/%25/g, "%");

export function refToString(ref: VarRef): string {
  return [ref.project, ref.environment, ref.resource].map(escapeName).concat(ref.key).join("/");
}

export function parseRef(text: string): VarRef | null {
  const parts = text.trim().split("/");
  if (parts.length !== 4) return null;
  const [project, environment, resource, key] = parts as [string, string, string, string];
  if (!KEY_PATTERN.test(key) || !project || !environment || !resource) return null;
  return {
    project: unescapeName(project),
    environment: unescapeName(environment),
    resource: unescapeName(resource),
    key,
  };
}
