let token = localStorage.getItem('mfc_token');
let activeConversation = null;
let inboxPoll = null; let messagePoll = null;
const $ = id => document.getElementById(id);
const headers = () => ({'Content-Type':'application/json','Authorization':`Bearer ${token}`});
async function api(path, options={}) {
  const r = await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});
  if (r.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function showApp(agent) {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  $('agent-name').textContent = agent?.name || 'Agent';
  loadConversations();
  if (inboxPoll) clearInterval(inboxPoll);
  inboxPoll = setInterval(loadConversations, 5000);
}
function logout(){localStorage.removeItem('mfc_token');token=null;if(inboxPoll)clearInterval(inboxPoll);if(messagePoll)clearInterval(messagePoll);$('app').classList.add('hidden');$('login').classList.remove('hidden');}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';
  try{const data=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,password:$('password').value})}).then(r=>r.json());if(!data.token)throw new Error(data.error||'Login failed');token=data.token;localStorage.setItem('mfc_token',token);showApp(data.agent);}
  catch(err){$('login-error').textContent=err.message;}
});
$('logout').onclick=logout;$('refresh').onclick=loadConversations;$('filter').onchange=loadConversations;
async function loadConversations(){
  try{
    const items=await api('/api/conversations'+($('filter').value?'?status='+$('filter').value:''));
    $('open-count').textContent=items.filter(x=>x.status==='open').length;
    $('conversations').innerHTML=items.map(c=>`<div class="conv ${activeConversation===c.id?'selected':''}" data-id="${c.id}">
      <div class="conv-top"><b>${escapeHtml(c.display_name||'Customer')}</b><span class="pill">${c.channel}</span></div>
      <p>${escapeHtml(c.last_message||'No messages yet')}</p></div>`).join('')||'<p style="padding:16px">No conversations yet.</p>';
    document.querySelectorAll('.conv').forEach(el=>el.onclick=()=>openConversation(el.dataset.id,items.find(x=>x.id===el.dataset.id)));
  }catch(e){console.error(e);}
}
async function openConversation(id,c){
  activeConversation=id;$('empty').classList.add('hidden');$('chat').classList.remove('hidden');
  $('customer-name').textContent=c.display_name||'Customer';$('customer-meta').textContent=`${c.channel} · ${c.phone||c.email||'No contact details'}`;$('status').value=c.status;
  await loadMessages();
  if(messagePoll)clearInterval(messagePoll);
  messagePoll=setInterval(loadMessages,5000);
  loadConversations();
}
async function loadMessages(){
  if(!activeConversation)return;
  const msgs=await api(`/api/conversations/${activeConversation}/messages`);
  $('messages').innerHTML=msgs.map(m=>`<div class="bubble ${m.direction==='outbound'?'outbound':''}">${escapeHtml(m.body||'')}<time>${new Date(m.created_at).toLocaleString()}</time></div>`).join('');
  $('messages').scrollTop=$('messages').scrollHeight;
}
$('reply-form').onsubmit=async e=>{e.preventDefault();const text=$('reply-text').value.trim();if(!text||!activeConversation)return;try{await api(`/api/conversations/${activeConversation}/reply`,{method:'POST',body:JSON.stringify({text})});$('reply-text').value='';await loadMessages();}catch(err){alert(err.message);}};
$('status').onchange=async()=>{if(activeConversation)await api(`/api/conversations/${activeConversation}/status`,{method:'POST',body:JSON.stringify({status:$('status').value})});loadConversations();};
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
if(token){fetch('/api/me',{headers:headers()}).then(r=>r.ok?r.json():Promise.reject()).then(d=>showApp(d.agent)).catch(logout);}
