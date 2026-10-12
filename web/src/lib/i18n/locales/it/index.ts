/** Italian dictionary (lazy-loaded chunk). One file per area; missing keys fall back to German. */
import type de from '../de/index';
import type { Translation } from '../../types';
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

const dict: Translation<typeof de> = { common, shell, home, detail, player, account, social, admin, hubs, anime, together, kids };
export default dict;
