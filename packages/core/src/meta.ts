/** Namespaced key under ACP's `_meta` for the facts evaluation needs and ACP does not carry. */
export const META_KEY = "chopin-ai";

export interface ChopinMeta {
  /** The model that produced a turn, so results can be compared per model. */
  model?: { provider: string; id: string };
  /** What the turn cost, in ACP's own cost shape. */
  cost?: { amount: number; currency: string };
  /** Why the turn ended without an answer. */
  error?: string;
  /** The harness's diagnostic codes on a tool result: `blocked` for a call a hook refused, `rejected` for one the user did. */
  diagnostics?: string[];
  /** A user-role message the harness added, such as a reminder or a command's output, rather than one the user wrote. */
  injected?: boolean;
}

type Meta = Record<string, unknown> | null | undefined;

export function withChopinMeta<T extends object>(value: T, meta: ChopinMeta): T {
  const existing = (value as { _meta?: Meta })._meta;
  return { ...value, _meta: { ...existing, [META_KEY]: meta } };
}

export function chopinMeta(value: object): ChopinMeta | undefined {
  return (value as { _meta?: Meta })._meta?.[META_KEY] as ChopinMeta | undefined;
}
