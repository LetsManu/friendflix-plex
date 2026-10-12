/** German source dictionary: bundled with the app, typed source of every key. One file per area (docs/i18n.md). */
import common from './common';
import shell from './shell';
import home from './home';
import detail from './detail';
import player from './player';
import account from './account';
import social from './social';
import admin from './admin';
import hubs from './hubs';
import anime from './anime';
import together from './together';
import kids from './kids';

export default { common, shell, home, detail, player, account, social, admin, hubs, anime, together, kids } as const;
