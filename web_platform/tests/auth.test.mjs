import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,TEST_LOGIN,orderInput} from './helpers.mjs';

const signin=f=>f.request('/api/v1/auth/login',TEST_LOGIN,{auth:false});
const cookie=r=>r.response.headers.get('set-cookie').split(';')[0];
const authed=c=>({auth:false,headers:{cookie:c}});

test('password login works without OpenAI identity; hashed sessions persist and permit trading controls',async t=>{
  const f=setup(t),r=await signin(f);assert.equal(r.status,200);
  const header=r.response.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=28800'])assert.ok(header.includes(flag));
  assert.ok(header.startsWith('__Host-quant_session='));assert.ok(!r.data.token);
  const c=cookie(r),session=await f.request('/api/v1/session',undefined,authed(c));
  assert.equal(session.data.username,TEST_LOGIN.username);assert.equal(session.data.operator,true);assert.equal(session.data.auth_mode,'password');
  const rows=f.db.rows('SELECT * FROM auth_sessions');assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(c.split('=')[1]));
  assert.equal((await f.request('/api/v1/control',{halted:false,confirm:'恢复模拟盘'},authed(c))).status,200);
  assert.equal((await f.request('/api/v1/orders',orderInput(),authed(c))).data.ok,true);
  assert.equal(f.broker.posts().length,1);
  assert.ok(!JSON.stringify(f.db.rows('SELECT * FROM events')).includes(TEST_LOGIN.password));
});

test('wrong credentials, forged cookies, old OpenAI identity and cross-origin login cannot authorize',async t=>{
  const f=setup(t);
  for(const input of [{...TEST_LOGIN,password:'wrong-password'},{...TEST_LOGIN,username:'another'}]){const r=await f.request('/api/v1/auth/login',input,{auth:false});assert.equal(r.status,401);assert.equal(r.data.code,'INVALID_CREDENTIALS');assert.equal(r.response.headers.get('set-cookie'),null);}
  const bad=await f.request('/api/v1/auth/login',TEST_LOGIN,{auth:false,headers:{origin:'https://evil.test'}});assert.equal(bad.status,403);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM auth_sessions').n,0);
  assert.equal((await f.request('/api/v1/control',{halted:true},authed('__Host-quant_session='+'a'.repeat(43)))).status,401);
  assert.equal((await f.request('/api/v1/control',{halted:true},{auth:false,headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'}})).status,401);
  assert.equal(f.broker.calls.length,0);
});

test('logout revokes only the current session and expired sessions cannot operate',async t=>{
  const f=setup(t),one=cookie(await signin(f)),two=cookie(await signin(f));assert.notEqual(one,two);
  const out=await f.request('/api/v1/auth/logout',{},authed(one));assert.equal(out.status,200);assert.match(out.response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await f.request('/api/v1/control',{halted:true},authed(one))).status,401);
  assert.equal((await f.request('/api/v1/session',undefined,authed(two))).data.operator,true);
  f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()-1);
  assert.equal((await f.request('/api/v1/control',{halted:true},authed(two))).status,401);
});

test('credential rotation invalidates old sessions and successful re-login rotates the cookie',async t=>{
  const f=setup(t),one=cookie(await signin(f));
  const next=await f.request('/api/v1/auth/login',TEST_LOGIN,authed(one)),two=cookie(next);assert.notEqual(one,two);
  assert.equal((await f.request('/api/v1/session',undefined,authed(one))).data.operator,false);
  f.env.AUTH_PASSWORD_RECORD=JSON.stringify({...JSON.parse(f.env.AUTH_PASSWORD_RECORD),hash:'a'.repeat(43)});
  assert.equal((await f.request('/api/v1/control',{halted:true},authed(two))).status,401);
});

test('login attempts are rate limited in the database and storage failure cannot issue a session',async t=>{
  const f=setup(t);
  f.db.sqlite.prepare('INSERT INTO auth_limits (bucket,attempts,expires_at) VALUES (?,?,?)').run('global',100,Date.now()+60000);
  const limited=await signin(f);assert.equal(limited.status,429);assert.equal(limited.response.headers.get('set-cookie'),null);
  f.db.sqlite.prepare('DELETE FROM auth_limits').run();f.db.fail=sql=>sql.startsWith('INSERT INTO events');
  const failed=await signin(f);assert.equal(failed.status,503);assert.equal(failed.response.headers.get('set-cookie'),null);
  assert.equal(f.db.get('SELECT COUNT(*) n FROM auth_sessions').n,0);
});
