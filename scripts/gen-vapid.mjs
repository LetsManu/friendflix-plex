#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Prints a fresh VAPID key pair for Web Push as .env lines. Needs no dependencies (also: `npx web-push generate-vapid-keys`).
import { Buffer } from 'node:buffer';
import { createECDH } from 'node:crypto';
import { console } from 'node:console';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const b64url = (b) => b.toString('base64url');
console.log(`VAPID_PUBLIC_KEY=${b64url(ecdh.getPublicKey())}`);
console.log(`VAPID_PRIVATE_KEY=${b64url(ecdh.getPrivateKey().length === 32 ? ecdh.getPrivateKey() : Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()]))}`);
console.log('VAPID_SUBJECT=mailto:admin@example.com   # optional, default PUBLIC_URL');
