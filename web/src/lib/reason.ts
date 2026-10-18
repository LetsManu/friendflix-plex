// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recommendation engine v2: the reason that comes with an item ({ seed, traits }, see backend reco/explain.ts) as a short caption,
 * e.g. "Because you watched “Dune” · same director". A trait is "kind" or "kind:value"; kinds this app does not know are left out
 * (a newer server may add some). Nothing here is sent anywhere.
 */
import type { Item, Reason } from '#lib/api';
import type { TFn } from '#lib/i18n';

/** One trait as a phrase, or '' when the kind is unknown. */
export function traitText(trait: string, t: TFn): string {
  const at = trait.indexOf(':');
  const kind = at < 0 ? trait : trait.slice(0, at);
  const value = at < 0 ? '' : trait.slice(at + 1).trim();
  switch (kind) {
    case 'friends': return value ? t('reco.trait.friendsNamed', { names: value }) : t('reco.trait.friends');
    case 'next': return t('reco.trait.next');
    case 'together': return t('reco.trait.together');
    case 'universe': return t('reco.trait.universe');
    case 'director': return value ? t('reco.trait.directorNamed', { name: value }) : t('reco.trait.director');
    case 'actor': return value ? t('reco.trait.actorNamed', { name: value }) : t('reco.trait.actor');
    case 'studio': return value ? t('reco.trait.studioNamed', { name: value }) : '';
    case 'genre': return value ? t('reco.trait.genreNamed', { name: value }) : '';
    default: return '';
  }
}

/** "Because you watched X · same director"; without a seed "Picked for you · …"; '' when there is no reason at all. */
export function reasonText(reason: Reason | undefined | null, t: TFn): string {
  if (!reason) return '';
  const head = reason.seed?.name ? t('reco.because', { seed: reason.seed.name }) : t('reco.picked');
  const traits = (reason.traits ?? []).map((x) => traitText(x, t)).filter(Boolean);
  return [head, ...traits].join(' · ');
}

/** The captions of the first `limit` items that have a reason (for the "Why am I seeing this?" list). */
export function reasonLines(items: readonly Item[], t: TFn, limit = 5): Array<{ id: string; name: string; text: string }> {
  const out: Array<{ id: string; name: string; text: string }> = [];
  for (const i of items) {
    const text = reasonText(i.reason, t);
    if (text) out.push({ id: i.id, name: i.type === 'Episode' && i.seriesName ? i.seriesName : i.name, text });
    if (out.length >= limit) break;
  }
  return out;
}
