/** Product name of this fork (keep in sync with web/src/lib/brand.ts). */
export const BRAND_NAME = 'FriendFlix for Plex';

/** Title of an outgoing message (ntfy / Discord / push) with the product name in front. */
export const brandTitle = (title: string): string => (!title || title.startsWith(BRAND_NAME) ? title || BRAND_NAME : `${BRAND_NAME} – ${title}`);
