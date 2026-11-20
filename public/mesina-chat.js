(function () {
  const script = document.currentScript;
  const apiBase = (script && script.dataset.endpoint) || new URL(script.src).origin;
  const accent = (script && script.dataset.color) || '#176b45';
  const visitorKey = 'mfc_visitor_id';
  let visitorId = localStorage.getItem(visitorKey);
  if (!visitorId) { visitorId = 'web_' + crypto.randomUUID(); localStorage.setItem(visitorKey, visitorId); }
  const style = document.createElement('style');
  style.textContent = `
    #mfc-launch{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:0;border-radius:28px;background:${accent};color:white;padding:14px 18px;font:600 14px system-ui;box-shadow:0 4px 20px #0002;cursor:pointer}
    #mfc-box{position:fixed;right:22px;bottom:82px;width:330px;height:440px;max-height:70vh;z-index:2147483000;background:white;border:1px solid #ddd;border-radius:14px;box-shadow:0 8px 35px #0003;display:none;overflow:hidden;font:14px system-ui}
    #mfc-head{background:${accent};color:white;padding:15px;font-weight:700}#mfc-log{height:310px;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
    .mfc-msg{padding:9px 11px;border-radius:12px;background:#eef2ef;max-width:85%;overflow-wrap:anywhere}.mfc-msg.mine{align-self:flex-end;background:#e0f1e5}
    #mfc-form{display:flex;padding:10px;border-top:1px solid #eee;gap:6px}#mfc-form input{min-width:0;flex:1;border:1px solid #ddd;border-radius:8px;padding:9px}#mfc-form button{border:0;background:${accent};color:white;border-radius:8px;padding:0 12px}
  `;
  document.head.appendChild(style);
  const launch = document.createElement('button'); launch.id='mfc-launch'; launch.textContent='Chat with us';
  const box = document.createElement('div'); box.id='mfc-box';
  box.innerHTML='<div id="mfc-head">Mesina Farms Support</div><div id="mfc-log"></div><form id="mfc-form"><input id="mfc-input" placeholder="Type your message..." required><button>Send</button></form>';
  document.body.append(launch,box);
  let conversationId = null;
  launch.onclick=()=>{box.style.display=box.style.display==='block'?'none':'block';};
  const log=box.querySelector('#mfc-log');
  function add(text,mine){const el=document.createElement('div');el.className='mfc-msg'+(mine?' mine':'');el.textContent=text;log.appendChild(el);log.scrollTop=log.scrollHeight;}
  async function refresh(){if(!conversationId)return;try{const rows=await fetch(`${apiBase}/api/widget/${conversationId}/messages`).then(r=>r.json());log.innerHTML='';rows.forEach(m=>add(m.body,m.direction==='inbound'));}catch(e){}}
  box.querySelector('#mfc-form').onsubmit=async e=>{
    e.preventDefault();const input=box.querySelector('#mfc-input');const message=input.value.trim();if(!message)return;input.value='';
    try{
      if(!conversationId){
        const r=await fetch(`${apiBase}/api/widget/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitor_id:visitorId,message})});
        const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to start chat');conversationId=d.conversation_id;add(message,true);
      }else{
        const r=await fetch(`${apiBase}/api/widget/${conversationId}/reply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:message})});
        if(!r.ok)throw new Error('Unable to send message');add(message,true);
      }
    }catch(err){add('Message could not be sent. Please try again.',false);}
  };
  setInterval(refresh,5000);
})();
