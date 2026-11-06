#!/usr/bin/env node
// 在服务端本机生成账号链接，不需要登录控制台：
//   npm run account-link                 还没有账号时，打印创建店主账号的链接
//   npm run account-link -- 邮箱          给这个账号生成重置密码链接（店主忘记密码时用）
// 只有能访问数据目录的人才能运行，这就是它的权限边界。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = process.env.VERDICT_DATA_DIR ?? path.join(process.cwd(), '.data');
const dbFile = path.join(dir, 'verdict.db');
const base = (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
const LINK_TTL_MS = 72 * 3600_000;

if (!fs.existsSync(dbFile)) {
  console.error(`没有找到数据库 ${dbFile}。先运行 npm run dev 并打开一次控制台。`);
  process.exit(1);
}
const db = new DatabaseSync(dbFile);
const hasUsers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
const userCount = hasUsers ? db.prepare('SELECT COUNT(*) AS n FROM users').get().n : 0;
const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  if (userCount > 0) {
    console.log('已经有控制台账号了。店主忘记密码时运行：npm run account-link -- 店主邮箱');
    process.exit(0);
  }
  const file = path.join(dir, 'setup-token');
  let token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (token.length < 32) {
    token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(file, token, { mode: 0o600 });
  }
  console.log(`打开下面的链接创建店主账号：\n${base}/setup?token=${token}`);
  process.exit(0);
}

const user = hasUsers ? db.prepare('SELECT id, name, disabled_at FROM users WHERE email = ?').get(email) : undefined;
if (!user) {
  console.error(`没有邮箱为 ${email} 的账号。`);
  process.exit(1);
}
if (user.disabled_at) {
  console.error('这个账号已停用。请店主在设置页启用后再生成链接。');
  process.exit(1);
}
const token = crypto.randomBytes(32).toString('base64url');
const now = new Date();
db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE password_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now.toISOString(), user.id);
db.prepare("INSERT INTO password_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, 'reset', ?, ?)").run(
  crypto.createHash('sha256').update(token).digest('hex'),
  user.id,
  now.toISOString(),
  new Date(now.getTime() + LINK_TTL_MS).toISOString(),
);
db.exec('COMMIT');
console.log(`给 ${user.name} 的重置密码链接（72 小时内有效，只能用一次）：\n${base}/invite/${token}`);
