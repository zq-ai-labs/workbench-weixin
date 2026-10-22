import type * as React from "react";

/**
 * Copy of the workbench's channel slots (bkms-workbench `client/slots.tsx`). The workbench declares these DSH child
 * slots; this plugin registers its parts into them under the key `wechat`. Keep in step with the workbench: the slot
 * names and props change only together with `CHANNEL_API_VERSION` (src/contract.ts).
 */
export const SLOTS = {
  tags: "bkms-workbench.task.tags",
  counterpart: "bkms-workbench.task.counterpart",
  body: "bkms-workbench.task.body",
  source: "bkms-workbench.task.source",
  conversations: "bkms-workbench.items.conversations",
  settings: "bkms-workbench.channel.settings",
} as const;
export const SETTINGS_PAGE_SLOT = "bkms-workbench.settings.channel";

/** A workbench task, as far as channel parts read it. */
export type Task = {
  id: string; title: string; subject: string; from: string; status: string; receivedAt: string;
  source?: { kind?: string; folder: string }; channelData?: unknown; reply?: { text: string; revision: number };
  attention?: boolean; summary?: string; triage?: { nextStep?: string };
};
type Component<P> = React.ComponentType<P & { children?: React.ReactNode }>;
type Tone = "warn" | "good" | "danger" | "accent" | "muted";
/** The workbench's components and helpers, handed to every part as `kit`. */
export type PartKit = {
  Alert: Component<{ tone?: "danger" | "warn" | "success"; onClose?: () => void }>;
  Empty: Component<{ icon?: string; title: string; text?: string }>;
  Icon: Component<{ name: string; size?: number }>;
  Modal: Component<{ title: string; onClose: () => void }>;
  StatusTag: Component<{ task: Task }>;
  Switch: Component<{ label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }>;
  Tag: Component<{ tone?: Tone }>;
  api<T = unknown>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  systemMessage(message: string): string;
  statusLabel(task: Task): string;
  time(value?: string): string;
  when(value?: string): string;
  fullDate(value?: string): string;
};
type WithKit<P> = P & { kit: PartKit };
export type TaskPartProps = WithKit<{ task: Task }>;
export type SourcePartProps = WithKit<{ task: Task; tasks: Task[]; open(taskId: string): void }>;
export type ConversationsProps = WithKit<{ page: unknown; tasks: Task[]; revision: number; open(taskId: string): void; openSettings(): void; saveSettings(value: unknown, message: string): Promise<void> }>;
export type SettingsCardProps = WithKit<{ value: unknown; disabled: boolean; save(value: unknown, message?: string): Promise<void> }>;
