import { connectLocale, type LocaleService } from "./i18n";
import { registerWechatParts } from "./parts";
// @ts-ignore CSS is bundled as a text module by scripts/build-client.mjs.
import stylesheet from "./styles.css";

interface ClientContext {
  locale?: LocaleService;
  get?(name: string): unknown;
  effect(fn: () => void | (() => void), name?: string): unknown;
  slots: { inject(name: string, callback: () => unknown): unknown; register(meta: Record<string, unknown>, component: unknown): () => void };
}
export const inject = ["slots", "locale"];
/** The WeChat parts of the task workbench page. They appear once the workbench has declared its channel slots. */
export function apply(ctx: ClientContext) {
  ctx.effect(() => connectLocale((ctx.get?.("locale") || ctx.locale) as LocaleService | undefined), "workbench-weixin: locale");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "workbench-weixin";
    style.textContent = stylesheet;
    document.head.appendChild(style);
    return () => style.remove();
  }, "workbench-weixin: styles");
  registerWechatParts(ctx);
}
