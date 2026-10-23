import english from "./en.json";

/** The page language comes from DSH; this plugin registers its own dictionary under the `workbench-weixin` namespace. */
export type LocaleService = {
  getSnapshot(): { active: string; revision: number };
  subscribe(listener: () => void): () => void;
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
};
const en: Record<string, string> = english;
const zh = Object.fromEntries(Object.keys(en).map(key => [key, key])) as Record<string, string>;
let translate: ReturnType<LocaleService["bind"]> | undefined;

export function connectLocale(service?: LocaleService): () => void {
  const unregister = service?.register("workbench-weixin", { zh, en });
  translate = service?.bind("workbench-weixin");
  return () => { unregister?.(); translate = undefined; };
}
/** Translate a Chinese UI text; `{0}`… are replaced by the values. */
export function t(key: string, ...values: unknown[]): string {
  const params = Object.fromEntries(values.map((value, index) => [String(index), value]));
  if (translate) return translate(key, params);
  return (zh[key] || key).replace(/\{(\d+)\}/g, (token, index) => String(params[index] ?? token));
}
