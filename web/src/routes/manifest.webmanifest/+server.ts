// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RequestHandler } from './$types';
import { chooseLang, manifestFor } from '#lib/manifest';

export const prerender = false;

export const GET: RequestHandler = async ({ url, request }) => {
  const lang = chooseLang(url.searchParams.get('lang'), request.headers.get('accept-language'));
  return new Response(JSON.stringify(await manifestFor(lang)), {
    headers: {
      'content-type': 'application/manifest+json',
      // short cache: a language change is picked up quickly; the answer also depends on Accept-Language when ?lang is missing
      'cache-control': 'public, max-age=300',
      vary: 'Accept-Language',
    },
  });
};
