import { neon } from '@neondatabase/serverless';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const text = (value, status = 200, headers = {}) => new Response(String(value), { status, headers });
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Hub-Signature-256', 'Access-Control-Max-Age': '86400' };
  if (allowed.includes(origin) || allowed.includes('*')) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k,v] of Object.entries(corsHeaders(request, env))) headers.set(k,v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function b64url(bytes) {
  let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function unb64url(s) { s = s.replace(/-/g,'+').replace(/_/g,'/'); return Uint8Array.from(atob(s + '='.repeat((4-s.length%4)%4)), c=>c.charCodeAt(0)); }
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
async function signToken(agent, env) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({sub:agent.id,email:agent.email,name:agent.display_name,role:agent.role,exp:Math.floor(Date.now()/1000)+60*60*12})));
  const input = `${header}.${payload}`;
  return `${input}.${b64url(await hmac(env.APP_SECRET, input))}`;
}
async function verifyToken(token, env) {
  try {
    const [h,p,s] = token.split('.'); if (!h || !p || !s) return null;
    const expected = b64url(await hmac(env.APP_SECRET, `${h}.${p}`));
    if (expected !== s) return null;
    const claims = JSON.parse(new TextDecoder().decode(unb64url(p)));
    if (!claims.exp || claims.exp < Date.now()/1000) return null;
    return claims;
  } catch { return null; }
}
async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'}, key, 256);
  return `pbkdf2$210000$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(password, encoded) {
  const [kind, iter, salt, expected] = String(encoded).split('$');
  if (kind !== 'pbkdf2') return false;
  const actual = await hashPassword(password, unb64url(salt));
  return constantTimeEqual(actual.split('$')[3], expected) && Number(iter) === 210000;
}
function constantTimeEqual(a,b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d=0; for(let i=0;i<a.length;i++) d |= a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
function getSql(env) { if (!env.DATABASE_URL) throw new Error('DATABASE_URL secret is missing'); return neon(env.DATABASE_URL); }
async function dbQuery(sql, statement, params=[]) { return sql.query(statement, params); }

let schemaReady = false;
async function ensureSchema(sql) {
  if (schemaReady) return;
  // Neon HTTP driver executes one statement per request. Schema is intentionally idempotent.
  const statements = [
`CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT 'Administrator', role TEXT NOT NULL DEFAULT 'admin', is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), display_name TEXT, phone TEXT, email TEXT, crm_customer_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS channel_identities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel TEXT NOT NULL CHECK (channel IN ('messenger','whatsapp','webchat')), external_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(channel, external_id))`,
`CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL REFERENCES contacts(id), channel TEXT NOT NULL CHECK (channel IN ('messenger','whatsapp','webchat')), status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')), assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, subject TEXT, last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE INDEX IF NOT EXISTS conversations_last_message_idx ON conversations(last_message_at DESC)`,
`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','system')), channel TEXT NOT NULL, external_message_id TEXT, body TEXT, attachment_url TEXT, delivery_status TEXT NOT NULL DEFAULT 'received', sender_type TEXT NOT NULL DEFAULT 'customer', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at)`,
`CREATE TABLE IF NOT EXISTS webhook_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL, event_key TEXT UNIQUE, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS conversation_notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, note TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS crm_sync_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL, conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL, direction TEXT NOT NULL, status TEXT NOT NULL, detail JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  ];
  for (const statement of statements) await sql.query(statement);
  schemaReady = true;
}
async function ensureAdmin(sql, env) {
  const email = (env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = env.ADMIN_PASSWORD || '';
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD Worker secrets before first login.');
  const rows = await sql`SELECT id FROM agents LIMIT 1`;
  if (!rows.length) {
    const hash = await hashPassword(password);
    await sql`INSERT INTO agents(email,password_hash,display_name,role) VALUES(${email},${hash},'Administrator','admin') ON CONFLICT(email) DO NOTHING`;
  }
}
async function auth(request, env, sql) {
  const header = request.headers.get('Authorization') || '';
  const claims = header.startsWith('Bearer ') ? await verifyToken(header.slice(7), env) : null;
  if (!claims) return null;
  const rows = await sql`SELECT id,email,display_name,role FROM agents WHERE id=${claims.sub} AND is_active=TRUE LIMIT 1`;
  return rows[0] || null;
}
async function bodyJson(request) { try { return await request.json(); } catch { return {}; } }
async function getOrCreateContact(sql, channel, externalId, profile={}) {
  const found = await sql`SELECT c.* FROM contacts c JOIN channel_identities i ON i.contact_id=c.id WHERE i.channel=${channel} AND i.external_id=${externalId} LIMIT 1`;
  if (found[0]) {
    const updated = await sql`UPDATE contacts SET display_name=COALESCE(${profile.name || null},display_name), phone=COALESCE(${profile.phone || null},phone), email=COALESCE(${profile.email || null},email),updated_at=NOW() WHERE id=${found[0].id} RETURNING *`;
    return updated[0];
  }
  const c = await sql`INSERT INTO contacts(display_name,phone,email) VALUES(${profile.name || 'Customer'},${profile.phone || null},${profile.email || null}) RETURNING *`;
  await sql`INSERT INTO channel_identities(contact_id,channel,external_id) VALUES(${c[0].id},${channel},${externalId}) ON CONFLICT(channel,external_id) DO NOTHING`;
  return c[0];
}
async function saveInbound(sql, item) {
  if (item.messageId) {
    const dupe = await sql`SELECT id FROM messages WHERE external_message_id=${item.messageId} LIMIT 1`;
    if (dupe.length) return;
  }
  const contact = await getOrCreateContact(sql,item.channel,item.externalId,item.profile || {});
  let convs = await sql`SELECT * FROM conversations WHERE contact_id=${contact.id} AND channel=${item.channel} AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`;
  let conv = convs[0];
  if (!conv) {
    const created = await sql`INSERT INTO conversations(contact_id,channel,subject) VALUES(${contact.id},${item.channel},${(item.text || 'New conversation').slice(0,90)}) RETURNING *`;
    conv = created[0];
  }
  await sql`INSERT INTO messages(conversation_id,direction,channel,external_message_id,body,sender_type) VALUES(${conv.id},'inbound',${item.channel},${item.messageId || null},${item.text || '[Unsupported message]'},'customer')`;
  await sql`UPDATE conversations SET last_message_at=NOW(),updated_at=NOW() WHERE id=${conv.id}`;
}
async function verifyMetaSignature(raw, signature, secret) {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  // Meta uses a hexadecimal SHA-256 HMAC digest.
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw)));
  const hex = [...digest].map(x=>x.toString(16).padStart(2,'0')).join('');
  return constantTimeEqual(hex, signature.slice(7));
}
async function sendMeta(env, recipient, message) {
  if (!env.MESSENGER_PAGE_ACCESS_TOKEN) throw new Error('Messenger Page access token is not configured');
  const version = env.META_GRAPH_VERSION || 'v23.0';
  const r = await fetch(`https://graph.facebook.com/${version}/${env.MESSENGER_PAGE_ID || 'me'}/messages?access_token=${encodeURIComponent(env.MESSENGER_PAGE_ACCESS_TOKEN)}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({recipient:{id:recipient},message:{text:message}})
  });
  const data = await r.json(); if (!r.ok) throw new Error(data.error?.message || 'Messenger send failed'); return data;
}
async function sendWhatsApp(env, recipient, message) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WhatsApp Cloud API credentials are not configured');
  const r = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v23.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method:'POST',headers:{authorization:`Bearer ${env.WHATSAPP_TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'text',text:{preview_url:false,body:message}})
  });
  const data=await r.json(); if(!r.ok) throw new Error(data.error?.message || 'WhatsApp send failed'); return data;
}
async function handleMessengerWebhook(request, env, sql, url) {
  if (request.method === 'GET') {
    if (url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===env.META_VERIFY_TOKEN) return text(url.searchParams.get('hub.challenge') || '');
    return text('Forbidden',403);
  }
  const raw = await request.text();
  if (!(await verifyMetaSignature(raw,request.headers.get('x-hub-signature-256'),env.META_APP_SECRET))) return text('Invalid signature',401);
  const payload=JSON.parse(raw);
  for (const entry of payload.entry || []) for (const event of entry.messaging || []) {
    if (!event.message || event.message.is_echo) continue;
    await saveInbound(sql,{channel:'messenger',externalId:event.sender?.id,messageId:event.message.mid,text:event.message.text || `[${event.message.attachments?.[0]?.type || 'media'} message]`,profile:{name:'Facebook customer'}});
  }
  return text('EVENT_RECEIVED');
}
async function handleWhatsAppWebhook(request, env, sql, url) {
  if (request.method === 'GET') {
    if (url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===env.WHATSAPP_VERIFY_TOKEN) return text(url.searchParams.get('hub.challenge') || '');
    return text('Forbidden',403);
  }
  const raw=await request.text();
  if (!env.WHATSAPP_APP_SECRET || !(await verifyMetaSignature(raw,request.headers.get('x-hub-signature-256'),env.WHATSAPP_APP_SECRET))) return text('Invalid signature',401);
  const payload=JSON.parse(raw);
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value=change.value || {};
    for (const msg of value.messages || []) {
      const info=(value.contacts || []).find(c=>c.wa_id===msg.from);
      await saveInbound(sql,{channel:'whatsapp',externalId:msg.from,messageId:msg.id,text:msg.text?.body || `[${msg.type || 'media'} message]`,profile:{name:info?.profile?.name || 'WhatsApp customer',phone:msg.from}});
    }
  }
  return text('EVENT_RECEIVED');
}

async function route(request, env, ctx) {
  const url = new URL(request.url); const path=url.pathname; const method=request.method;
  if (method==='OPTIONS') return new Response(null,{status:204,headers:corsHeaders(request,env)});
  if (path==='/health' && method==='GET') return json({ok:true,app:'Mesina Farms Connect',runtime:'cloudflare-workers',database:'neon-postgresql'});
  if (path==='/webhooks/messenger') { const sql=getSql(env); await ensureSchema(sql); return handleMessengerWebhook(request,env,sql,url); }
  if (path==='/webhooks/whatsapp') { const sql=getSql(env); await ensureSchema(sql); return handleWhatsAppWebhook(request,env,sql,url); }
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  const sql=getSql(env); await ensureSchema(sql);

  if (path==='/api/auth/login' && method==='POST') {
    await ensureAdmin(sql,env);
    const b=await bodyJson(request); const email=String(b.email||'').trim().toLowerCase();
    const rows=await sql`SELECT * FROM agents WHERE email=${email} AND is_active=TRUE LIMIT 1`;
    if (!rows[0] || !(await verifyPassword(String(b.password||''),rows[0].password_hash))) return json({error:'Invalid email or password'},401);
    const agent={id:rows[0].id,email:rows[0].email,name:rows[0].display_name,role:rows[0].role};
    return json({token:await signToken(agent,env),agent});
  }
  const agent=await auth(request,env,sql);
  if (path==='/api/me' && method==='GET') return agent ? json({agent:{id:agent.id,email:agent.email,name:agent.display_name,role:agent.role}}) : json({error:'Unauthorized'},401);
  const protectedPath = path.startsWith('/api/conversations') || path==='/api/integrations/status';
  if (protectedPath && !agent) return json({error:'Unauthorized'},401);

  if (path==='/api/conversations' && method==='GET') {
    const status=url.searchParams.get('status');
    const rows=status ? await sql`SELECT cv.*,c.display_name,c.phone,c.email,(SELECT body FROM messages m WHERE m.conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) AS last_message FROM conversations cv JOIN contacts c ON c.id=cv.contact_id WHERE cv.status=${status} ORDER BY cv.last_message_at DESC LIMIT 200`
      : await sql`SELECT cv.*,c.display_name,c.phone,c.email,(SELECT body FROM messages m WHERE m.conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) AS last_message FROM conversations cv JOIN contacts c ON c.id=cv.contact_id ORDER BY cv.last_message_at DESC LIMIT 200`;
    return json(rows);
  }
  let m=path.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
  if (m && method==='GET') return json(await sql`SELECT * FROM messages WHERE conversation_id=${m[1]} ORDER BY created_at ASC LIMIT 500`);
  m=path.match(/^\/api\/conversations\/([0-9a-f-]+)\/reply$/i);
  if (m && method==='POST') {
    const b=await bodyJson(request); const message=String(b.text||'').trim(); if(!message || message.length>4000) return json({error:'Message must be 1–4000 characters'},400);
    const rows=await sql`SELECT cv.*,i.external_id FROM conversations cv JOIN channel_identities i ON i.contact_id=cv.contact_id AND i.channel=cv.channel WHERE cv.id=${m[1]} LIMIT 1`;
    if(!rows[0]) return json({error:'Conversation not found'},404);
    const conv=rows[0]; let provider={};
    try {
      if(conv.channel==='messenger') provider=await sendMeta(env,conv.external_id,message);
      else if(conv.channel==='whatsapp') provider=await sendWhatsApp(env,conv.external_id,message);
      const inserted=await sql`INSERT INTO messages(conversation_id,direction,channel,body,sender_type,delivery_status) VALUES(${conv.id},'outbound',${conv.channel},${message},'agent','sent') RETURNING *`;
      await sql`UPDATE conversations SET last_message_at=NOW(),updated_at=NOW() WHERE id=${conv.id}`;
      return json({message:inserted[0],provider});
    } catch(e) { return json({error:e.message},502); }
  }
  m=path.match(/^\/api\/conversations\/([0-9a-f-]+)\/status$/i);
  if(m && method==='POST') { const b=await bodyJson(request); if(!['open','pending','closed'].includes(b.status)) return json({error:'Invalid status'},400); const r=await sql`UPDATE conversations SET status=${b.status},updated_at=NOW() WHERE id=${m[1]} RETURNING *`; return json(r[0]||null); }
  m=path.match(/^\/api\/conversations\/([0-9a-f-]+)\/assign$/i);
  if(m && method==='POST') { const b=await bodyJson(request); const id=b.agent_id||agent.id; const r=await sql`UPDATE conversations SET assigned_agent_id=${id},updated_at=NOW() WHERE id=${m[1]} RETURNING *`; return json(r[0]||null); }
  m=path.match(/^\/api\/conversations\/([0-9a-f-]+)\/notes$/i);
  if(m && method==='POST') { const b=await bodyJson(request); const note=String(b.note||'').trim(); if(!note)return json({error:'Note is required'},400); const r=await sql`INSERT INTO conversation_notes(conversation_id,agent_id,note) VALUES(${m[1]},${agent.id},${note}) RETURNING *`; return json(r[0]); }
  if(path==='/api/integrations/status' && method==='GET') return json({messenger:Boolean(env.MESSENGER_PAGE_ACCESS_TOKEN&&env.META_APP_SECRET),whatsapp:Boolean(env.WHATSAPP_TOKEN&&env.WHATSAPP_PHONE_NUMBER_ID),webchat:true,crm:env.CRM_SYNC_ENABLED==='true'});

  if(path==='/api/widget/start' && method==='POST') {
    const b=await bodyJson(request); const visitor=String(b.visitor_id||'').slice(0,160); const message=String(b.message||'').trim();
    if(!visitor||!message||message.length>4000)return json({error:'visitor_id and message are required'},400);
    const contact=await getOrCreateContact(sql,'webchat',visitor,{name:b.name,email:b.email});
    let found=await sql`SELECT * FROM conversations WHERE contact_id=${contact.id} AND channel='webchat' AND status<>'closed' ORDER BY created_at DESC LIMIT 1`;
    let conv=found[0]; if(!conv){const created=await sql`INSERT INTO conversations(contact_id,channel,subject) VALUES(${contact.id},'webchat',${message.slice(0,90)}) RETURNING *`;conv=created[0];}
    const inserted=await sql`INSERT INTO messages(conversation_id,direction,channel,body,sender_type) VALUES(${conv.id},'inbound','webchat',${message},'customer') RETURNING *`;
    await sql`UPDATE conversations SET last_message_at=NOW(),updated_at=NOW() WHERE id=${conv.id}`;
    return json({conversation_id:conv.id,message:inserted[0]});
  }
  m=path.match(/^\/api\/widget\/([0-9a-f-]+)\/messages$/i);
  if(m&&method==='GET') { const r=await sql`SELECT direction,body,created_at FROM messages WHERE conversation_id=${m[1]} AND channel='webchat' ORDER BY created_at ASC LIMIT 100`; return json(r); }
  m=path.match(/^\/api\/widget\/([0-9a-f-]+)\/reply$/i);
  if(m&&method==='POST') { const b=await bodyJson(request); const message=String(b.text||'').trim(); if(!message||message.length>4000)return json({error:'Message is required'},400); const conv=await sql`SELECT id FROM conversations WHERE id=${m[1]} AND channel='webchat'`; if(!conv.length)return json({error:'Not found'},404); const r=await sql`INSERT INTO messages(conversation_id,direction,channel,body,sender_type) VALUES(${m[1]},'inbound','webchat',${message},'customer') RETURNING *`; await sql`UPDATE conversations SET last_message_at=NOW(),updated_at=NOW() WHERE id=${m[1]}`; return json(r[0]); }
  return json({error:'Not found'},404);
}

export default {
  async fetch(request, env, ctx) {
    try { return withCors(await route(request,env,ctx),request,env); }
    catch (error) { console.error('Worker request failed',error); return withCors(json({error:'Internal server error',detail:env.ENVIRONMENT==='development'?error.message:undefined},500),request,env); }
  }
};
