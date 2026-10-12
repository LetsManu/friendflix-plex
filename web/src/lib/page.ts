import { page } from '$app/state';
import { toStore } from 'svelte/store';

// `$app/stores` is gone in SvelteKit 3; legacy (`$:`) components still need a store to react to navigation.
// Call during component init. Reads url/params/state so the store updates whenever any of them change.
export const pageStore = () => toStore(() => ({ url: page.url, params: page.params, state: page.state }));
