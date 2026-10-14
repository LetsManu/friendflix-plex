// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Spanish dictionary (lazy-loaded chunk). One file per area; missing keys fall back to German. */
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
import ui from './ui';
import adminPeople from './adminPeople';
import adminContent from './adminContent';
import scenes from './scenes';
import fresh from './fresh';
import mine from './mine';
import diagnose from './diagnose';
import version from './version';

const dict: Translation<typeof de> = { common, shell, home, detail, player, account, social, admin, hubs, anime, together, kids, scenes, fresh, mine, diagnose, version, ui, adminPeople, adminContent };
export default dict;
