/**
 * Types of the translation dictionaries (see docs/i18n.md).
 * German (locales/de) is the typed source; every other language is a `Translation<…>` of it, so it may leave keys out
 * (they fall back to German) but can never invent keys or turn a plural into a plain string by accident.
 */

/** Plural forms of one message, selected with Intl.PluralRules via the `n` parameter. `other` is required; `zero` is used for n === 0 in every language. */
export interface PluralForms {
  readonly other: string;
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
}

/** A value of a dictionary: a message, plural forms or a nested group. */
export type Message = string | PluralForms;

/** Partial translation of the German source dictionary `T` (keys and plural shape are checked, texts are free). */
export type Translation<T> = {
  readonly [K in keyof T]?: T[K] extends string ? string : T[K] extends { readonly other: string } ? PluralForms : Translation<T[K]>;
};

/** All dotted message keys of a dictionary ('shell.nav.home', 'account.profiles.count' …). */
export type KeysOf<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends { readonly other: string } ? `${P}${K}` : KeysOf<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Interpolation values: `{name}` placeholders; numbers are formatted for the locale; `n` also picks the plural form. */
export type TParams = Record<string, string | number | null | undefined>;
