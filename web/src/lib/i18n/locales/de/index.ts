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
import ui from './ui';
import adminPeople from './adminPeople';
import adminContent from './adminContent';
import scenes from './scenes';
import fresh from './fresh';
import mine from './mine';
import diagnose from './diagnose';

export default { common, shell, home, detail, player, account, social, admin, hubs, anime, together, kids, scenes, fresh, mine, diagnose, ui, adminPeople, adminContent } as const;
