// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/version';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  egg: { hint: '{n} more…', dialog: 'Version codename', kicker: 'Codename', close: 'Close' },
  snack: {
    arancini: 'Fried rice balls with a cheesy heart: crunchy outside, plot twist inside.',
    brezel: 'Salty, twisted, and somehow never lost the plot.',
    churros: 'Cinnamon, sugar, oil: the holy trinity of the late show.',
    donut: 'Has a hole in the middle, but none in the plot.',
    eclair: 'Long, creamy and gone faster than the end credits.',
    fudge: 'As chewy as a second act, only much sweeter.',
    gummibaer: 'Tiny bears, big feelings: every colour gets its own character arc.',
    hotdog: 'Mustard on, lights off, roll film.',
    ingwerkeks: 'Spicy enough to keep you awake through the credits.',
    jellybean: 'Every bean a cliffhanger: strawberry, or is it popcorn?',
    karamell: 'Sticks to your teeth like a soundtrack earworm.',
    lakritz: 'You love it or you hate it, like every proper cult classic.',
    marshmallow: 'Soft, fluffy, and survives every campfire horror finale.',
    nachos: 'Crunching during quiet scenes is forbidden. Nobody listens.',
    onionring: 'The donut of savoury snacks: round, crunchy, no ending in sight.',
    popcorn: 'The original. Without us, this would just be a movie.',
    quarkbaellchen: 'Small, round and sugar-coated: the corner bakery\'s best-kept secret.',
    reiswaffel: 'Crunching quietly is an art. We\'re still practising.',
    softeis: 'Melts faster than your heart in a romcom.',
    toffee: 'Hard on the outside, soft at the core: a classic antihero.',
    ube: 'Purple yam from the Philippines: the plot-twist dessert.',
    vanilleeis: 'Underrated, like the supporting role that sweeps every award.',
    waffel: 'Checkered, warm and never too much. Unless there\'s cream.',
    xocolatl: 'The Aztecs\' cocoa drink: older than any silent film.',
    yuzu: 'Sour, fresh and unexpected, like a good script.',
    zimtschnecke: 'The last roll of the alphabet. Cue the credits.',
  },
};
export default dict;
