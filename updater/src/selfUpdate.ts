// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one-shot helper of a self-update (`docker compose run --rm updater node updater/dist/selfUpdate.js`): a sibling
 * container of the updater service, already on the new (pulled and cosign-verified) image, recreates the updater service and
 * exits. It takes no input but FF_TAG, which must be a valid tag.
 */
import { loadConfig } from './config.js';
import { Docker, execRunner } from './docker.js';
import { SELF_SERVICE, isTag } from './policy.js';

export async function selfUpdate(env: NodeJS.ProcessEnv, docker?: Pick<Docker, 'up'>): Promise<number> {
  const tag = env.FF_TAG;
  if (!isTag(tag)) return 2;
  const d = docker ?? (() => {
    const c = loadConfig(env);
    return new Docker({ projectDir: c.projectDir, files: c.composeFiles, projectName: c.projectName, repo: c.repo, dockerHost: c.dockerHost }, execRunner);
  })();
  try {
    await d.up(tag, [SELF_SERVICE]);
    return 0;
  } catch {
    return 1;
  }
}

if (process.argv[1]?.endsWith('selfUpdate.js')) {
  void selfUpdate(process.env).then((code) => {
    console.log(`${new Date().toISOString()} updater self-update helper: ${code === 0 ? 'done' : `failed (${code})`}`);
    process.exit(code);
  });
}
