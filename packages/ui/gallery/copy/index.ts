import { en } from "./en.ts";
import { ptBR } from "./pt-BR.ts";
import type { Copy, Locale } from "./types.ts";

export type { Copy, Locale } from "./types.ts";

export const copy: Record<Locale, Copy> = { en, "pt-BR": ptBR };
