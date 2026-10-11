'use strict';
const $=s=>document.querySelector(s), app=$('#app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEFAULT_ADDONS=['https://v3-cinemeta.strem.io'];

/* ---------- stockage (profils) ---------- */
let db;
try{db=JSON.parse(localStorage.getItem('lumen'))}catch(e){}
if(!db||!db.profiles){db={cur:'p1',profiles:[{id:'p1',name:'Moi',addons:[],list:[],progress:{}}]}}
const P=()=>db.profiles.find(p=>p.id===db.cur)||db.profiles[0];
const save=(noSync)=>{try{localStorage.setItem('lumen',JSON.stringify(db))}catch(e){} if(!noSync){db.dirty=true;schedulePush()}};

/* ---------- addons (protocole Stremio) ---------- */
const norm=u=>u.trim().replace(/^stremio:\/\//,'https://').replace(/\/manifest\.json.*$/,'').replace(/\/+$/,'');
async function getJSON(url){const r=await fetch(url);if(!r.ok)throw new Error(r.status);return r.json()}
async function addAddon(url){
  const base=norm(url), manifest=await getJSON(base+'/manifest.json');
  if(!manifest.id||!manifest.name)throw new Error('Manifeste invalide');
  const p=P(); p.addons=p.addons.filter(a=>a.base!==base); p.addons.push({base,manifest}); save();
}
async function ensureDefaults(){
  const p=P();
  if(!p.addons.length&&!p.seeded){p.seeded=true;for(const u of DEFAULT_ADDONS){try{await addAddon(u)}catch(e){}}save()}
}
function supports(a,res,type,id){
  const m=a.manifest;
  for(const r of m.resources||[]){
    const name=typeof r==='string'?r:r.name; if(name!==res)continue;
    const types=(typeof r==='object'&&r.types)||m.types||[];
    const pre=(typeof r==='object'&&r.idPrefixes)||m.idPrefixes;
    if(types.length&&!types.includes(type))continue;
    if(pre&&id&&!pre.some(x=>id.startsWith(x)))continue;
    return true;
  }
  return false;
}
const enc=encodeURIComponent;
const catUrl=(a,c,extra)=>`${a.base}/catalog/${enc(c.type)}/${enc(c.id)}${extra?'/'+extra:''}.json`;


/* ---------- comptes + synchro (Supabase) ---------- */
const SB={url:'https://fthkdkmlmykdrfzpwaod.supabase.co',key:'sb_publishable_caYDvzp__LeRK9NHojka6w_HruWKBoC'};
let auth=null; try{auth=JSON.parse(localStorage.getItem('lumen_auth'))}catch(e){}
let syncMsg='';
const saveAuth=()=>{try{auth?localStorage.setItem('lumen_auth',JSON.stringify(auth)):localStorage.removeItem('lumen_auth')}catch(e){}};
async function sb(path,opts={},tok){
  const h=Object.assign({apikey:SB.key,'Content-Type':'application/json'},opts.headers||{});
  if(tok)h.Authorization='Bearer '+tok;
  const r=await fetch(SB.url+path,Object.assign({},opts,{headers:h}));
  const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null}catch(e){}
  if(!r.ok)throw new Error((j&&(j.msg||j.error_description||j.message||j.error))||('Erreur '+r.status));
  return j;
}
function setAuth(j){auth={access_token:j.access_token,refresh_token:j.refresh_token,expires_at:Math.floor(Date.now()/1000)+(j.expires_in||3600),email:(j.user||{}).email,id:(j.user||{}).id};saveAuth()}
async function token(){
  if(!auth)return null;
  if(auth.expires_at-60<Date.now()/1000){
    try{const j=await sb('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:auth.refresh_token})});setAuth(j)}
    catch(e){auth=null;saveAuth();return null}
  }
  return auth.access_token;
}
async function signIn(email,pw,create){
  const j=await sb(create?'/auth/v1/signup':'/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password:pw})});
  if(!j.access_token)throw new Error('Compte créé : confirme ton e-mail puis connecte-toi.');
  setAuth(j); await syncPull();
}
const payload=()=>({v:1,cur:db.cur,profiles:db.profiles.map(p=>({id:p.id,name:p.name,addons:p.addons.map(a=>a.base),list:p.list,progress:p.progress}))});
async function hydrate(bases,old){
  return Promise.all(bases.map(async b=>{
    const k=(old||[]).find(a=>a.base===b); if(k&&k.manifest&&k.manifest.resources&&k.manifest.resources.length)return k;
    try{return{base:b,manifest:await getJSON(b+'/manifest.json')}}catch(e){return k||{base:b,manifest:{id:b,name:b,resources:[],catalogs:[]}}}
  }));
}
let pushT=null;
function schedulePush(){ if(!auth)return; clearTimeout(pushT); pushT=setTimeout(syncPush,1500) }
async function syncPush(){
  const t=await token(); if(!t)return;
  try{
    await sb('/rest/v1/lumen_data?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:auth.id,data:payload(),updated_at:new Date().toISOString()})},t);
    db.dirty=false;db.syncedAt=Date.now();save(true);syncMsg='Synchronisé à '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
  }catch(e){syncMsg='Échec de synchro : '+e.message}
  const m=document.getElementById('sm'); if(m)m.textContent=syncMsg;
}
async function syncPull(){
  const t=await token(); if(!t)return;
  try{
    const rows=await sb('/rest/v1/lumen_data?select=data,updated_at&user_id=eq.'+auth.id,{},t);
    if(!rows||!rows.length||!rows[0].data||!rows[0].data.profiles){await syncPush();return}
    const cloud=rows[0].data, ct=Date.parse(rows[0].updated_at)||0;
    if(db.dirty&&ct<=(db.syncedAt||0)){await syncPush();return}
    const merged=[];
    for(const cp of cloud.profiles){
      const lp=db.profiles.find(p=>p.id===cp.id);
      const progress=Object.assign({},lp?lp.progress:{},cp.progress||{});
      for(const k in (lp?lp.progress:{})){ if(cp.progress&&cp.progress[k]&&lp.progress[k].at>cp.progress[k].at)progress[k]=lp.progress[k] }
      merged.push({id:cp.id,name:cp.name,list:cp.list||[],progress,addons:await hydrate(cp.addons||[],lp&&lp.addons)});
    }
    db.profiles=merged.length?merged:db.profiles;
    db.cur=db.profiles.some(p=>p.id===db.cur)?db.cur:(cloud.cur&&db.profiles.some(p=>p.id===cloud.cur)?cloud.cur:db.profiles[0].id);
    db.dirty=false;db.syncedAt=Date.now();save(true);syncMsg='Synchronisé';
  }catch(e){syncMsg='Échec de synchro : '+e.message}
}

/* ---------- UI helpers ---------- */
function card(m,land){
  const bg=m.poster?`style="background-image:url('${esc(m.poster)}')"`:'';
  return `<a class="c ${land?'land':''}" href="#/d/${enc(m.type)}/${enc(m.id)}"><div class="p" ${bg}>${m.poster?'':esc(m.name)}</div><span>${esc(m.name)}</span></a>`;
}
const stash={}; // meta mis en cache pour la fiche
function remember(ms){ms.forEach(m=>{stash[m.type+'/'+m.id]=m})}
const setNav=n=>document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('on',a.dataset.n===n));
const loading=()=>app.innerHTML='<p class="pad mut">Chargement…</p>';

/* ---------- vues ---------- */
async function home(){
  setNav('home'); app.innerHTML=''; await ensureDefaults();
  const p=P(); if(!p.addons.length){app.innerHTML='<p class="pad mut">Aucun addon. Va dans l’onglet Addons.</p>';return}
  const cont=Object.entries(p.progress).filter(([k,v])=>v.t>20&&v.t<v.d*0.95&&v.meta).sort((a,b)=>b[1].at-a[1].at).slice(0,10);
  if(cont.length){remember(cont.map(c=>c[1].meta));app.insertAdjacentHTML('beforeend',`<h2>Reprendre</h2><div class="row">${cont.map(c=>card(c[1].meta)).join('')}</div>`)}
  for(const a of p.addons){
    if(!(a.manifest.resources||[]).some(r=>(r.name||r)==='catalog'))continue;
    for(const c of (a.manifest.catalogs||[])){
      if((c.extra||[]).some(e=>e.isRequired))continue;
      const sec=document.createElement('section');sec.innerHTML=`<h2>${esc(c.name||c.id)} <span class="mut" style="font-size:12px">· ${esc(a.manifest.name)}</span></h2><div class="row"><span class="mut">…</span></div>`;
      app.appendChild(sec);
      getJSON(catUrl(a,c)).then(d=>{const ms=(d.metas||[]).slice(0,30);remember(ms);
        const land=c.type==='tv';
        sec.querySelector('.row').innerHTML=ms.map(m=>card(m,land)).join('')||'<span class="mut">Vide</span>'}).catch(()=>sec.remove());
    }
  }
}
async function search(q){
  setNav('home'); loading(); const p=P(); let html='';
  const jobs=[];
  for(const a of p.addons)for(const c of a.manifest.catalogs||[]){
    if((c.extra||[]).some(e=>e.name==='search'))jobs.push(getJSON(catUrl(a,c,'search='+enc(q))).then(d=>({a,c,ms:d.metas||[]})).catch(()=>null));
  }
  const res=(await Promise.all(jobs)).filter(r=>r&&r.ms.length);
  for(const r of res){remember(r.ms);html+=`<h2>${esc(r.c.name||r.c.id)} <span class="mut" style="font-size:12px">· ${esc(r.a.manifest.name)}</span></h2><div class="grid">${r.ms.slice(0,30).map(m=>card(m)).join('')}</div>`}
  app.innerHTML=`<h2>Résultats pour « ${esc(q)} »</h2>`+(html||'<p class="pad mut">Aucun résultat.</p>');
}
async function detail(type,id){
  setNav(''); loading(); const p=P(); let m=stash[type+'/'+id];
  for(const a of p.addons){
    if(!supports(a,'meta',type,id))continue;
    try{const d=await getJSON(`${a.base}/meta/${enc(type)}/${enc(id)}.json`);if(d.meta){m=Object.assign({},m,d.meta);break}}catch(e){}
  }
  if(!m){app.innerHTML='<p class="pad">Fiche introuvable.</p>';return}
  m.type=m.type||type; m.id=m.id||id; stash[type+'/'+id]=m;
  const inList=p.list.some(x=>x.id===id&&x.type===type);
  const vids=(m.videos||[]).filter(v=>v.season!=null||v.episode!=null);
  const seasons=[...new Set(vids.map(v=>v.season??0))].sort((a,b)=>a-b);
  let html=`<button class="back" onclick="history.back()">‹</button><div class="hero" style="background-image:url('${esc(m.background||m.poster||'')}')"></div><div class="pad" style="margin-top:-50px;position:relative">
  <h1 style="margin:0 0 4px">${esc(m.name)}</h1><div class="mut">${esc([m.year||m.releaseInfo,m.runtime,(m.genres||[]).slice(0,3).join(', ')].filter(Boolean).join(' · '))}</div>
  <p style="line-height:1.45">${esc(m.description||'')}</p>
  <div style="display:flex;gap:8px;margin-bottom:12px">${vids.length?'':`<button class="btn" id="watch">▶ Regarder</button>`}<button class="btn g" id="fav">${inList?'✓ Dans ma liste':'+ Ma liste'}</button></div><div id="eps"></div><div id="streams"></div></div>`;
  app.innerHTML=html; window.scrollTo(0,0);
  $('#fav').onclick=()=>{const i=p.list.findIndex(x=>x.id===id&&x.type===type);
    if(i>=0)p.list.splice(i,1);else p.list.push({type,id,name:m.name,poster:m.poster});save();$('#fav').textContent=i>=0?'+ Ma liste':'✓ Dans ma liste'};
  if(vids.length){
    let cur=seasons.find(s=>s>0)??seasons[0];
    const draw=()=>{$('#eps').innerHTML=`<div class="sel">${seasons.map(s=>`<button class="${s===cur?'on':''}" data-s="${s}">${s===0?'Spéciaux':'Saison '+s}</button>`).join('')}</div>`+
      vids.filter(v=>(v.season??0)===cur).sort((a,b)=>(a.episode||0)-(b.episode||0)).map(v=>`<div class="ep" data-v="${esc(v.id)}" data-t="${esc(v.title||v.name||'')}"><b>${v.episode??''}</b><span>${esc(v.title||v.name||'Épisode '+v.episode)}</span></div>`).join('');
      $('#eps').querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>{cur=+b.dataset.s;draw()});
      $('#eps').querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>streams(m,b.dataset.v,m.name+' · '+b.dataset.t));};
    draw();
  } else $('#watch').onclick=()=>streams(m,id,m.name);
}
async function streams(m,vid,title){
  const box=$('#streams'); box.innerHTML='<h2 style="margin:16px 0 8px">Sources</h2><p class="mut">Recherche…</p>'; box.scrollIntoView({behavior:'smooth'});
  const p=P(); const list=[];
  await Promise.all(p.addons.filter(a=>supports(a,'stream',m.type,vid)).map(async a=>{
    try{const d=await getJSON(`${a.base}/stream/${enc(m.type)}/${enc(vid)}.json`);(d.streams||[]).forEach(s=>list.push({a,s}))}catch(e){}
  }));
  const ok=list.filter(x=>x.s.url||x.s.externalUrl||x.s.ytId);
  const is4k=x=>/2160p|\b4k\b|uhd/i.test((x.s.name||'')+' '+(x.s.title||'')+' '+(x.s.description||''));
  ok.sort((p,q)=>is4k(p)-is4k(q));
  box.innerHTML='<h2 style="margin:16px 0 8px">Sources</h2>'+(ok.length?ok.map((x,i)=>`<div class="box" data-i="${i}"><b>${is4k(x)?'⚠ 4K · ':''}${esc((x.s.name||x.a.manifest.name).replace(/\n/g,' '))}</b><small>${esc((x.s.title||x.s.description||'').replace(/\n/g,' · '))}</small></div>`).join(''):'<p class="mut">Aucune source lisible trouvée.'+(list.length?' (Les sources de type torrent ne sont pas prises en charge.)':'')+'</p>');
  box.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>{const x=ok[+el.dataset.i];
    if(x.s.url)play(x.s,m,vid,title);
    else window.open(x.s.externalUrl||('https://www.youtube.com/watch?v='+x.s.ytId),'_blank');});
}


/* diagnostic de lecture */
let diagT=null;
function diagStart(){
  clearInterval(diagT);
  let box=document.getElementById('pinfo');
  if(!box){box=document.createElement('div');box.id='pinfo';box.style.cssText='position:absolute;left:12px;right:12px;bottom:70px;z-index:3;background:rgba(0,0,0,.72);color:#fff;border-radius:10px;padding:10px 12px;font:13px/1.4 system-ui;display:none;pointer-events:none';document.getElementById('pl').appendChild(box)}
  let n=0;
  diagT=setInterval(()=>{
    if($('#pl').style.display!=='block'){clearInterval(diagT);return}
    if(vid.paused||vid.readyState<2)return;
    n++; if(n<3)return;
    const q=vid.getVideoPlaybackQuality?vid.getVideoPlaybackQuality():{};
    const aud=vid.webkitAudioDecodedByteCount!==undefined?vid.webkitAudioDecodedByteCount:(vid.mozHasAudio===undefined?undefined:(vid.mozHasAudio?1:0)), hasAud=(aud===undefined)?null:aud>0;
    let ahead=0;try{const b=vid.buffered;for(let i=0;i<b.length;i++){if(vid.currentTime>=b.start(i)&&vid.currentTime<=b.end(i))ahead=b.end(i)-vid.currentTime}}catch(e){}
    const ext=((vid.currentSrc||'').split('?')[0].match(/\.(\w{2,5})$/)||[,'?'])[1];
    const lines=[`${vid.videoWidth}×${vid.videoHeight} · images perdues ${q.droppedVideoFrames||0}/${q.totalVideoFrames||0}`,`son décodé: ${aud===undefined?'?':aud} octets · tampon: ${ahead.toFixed(1)} s · attentes: ${vid._w||0} · .${ext}${vid._h?' · hls.js':''}`];
    if(hasAud===false&&!vid.muted&&vid.volume>0)lines.push('Aucun son décodé : la piste audio (AC3, E-AC3, DTS…) n’est probablement pas lisible par ce navigateur.');
    if(q.totalVideoFrames>60&&q.droppedVideoFrames/q.totalVideoFrames>0.15)lines.push('Beaucoup d’images perdues : le format vidéo (HEVC/H.265, 10 bits, 4K) est trop lourd pour ce navigateur.');
    if(vid.videoWidth===0)lines.push('Aucune image décodée : codec vidéo non pris en charge.');
    box.innerHTML=lines.map(esc).join('<br>');
    box.style.display='block';
    if(n>25)box.style.display='none';
  },1000);
}


/* ---------- lecteur ---------- */
const vid=$('#vid'); let pkey=null, last=0;
function play(s,m,id,title){
  const p=P(); pkey=m.type+'/'+id; $('#pl').style.display='block'; document.body.classList.add('playing');
  vid.querySelectorAll('track').forEach(t=>t.remove());
  (s.subtitles||[]).forEach((t,i)=>{if(!t.url)return;const e=document.createElement('track');e.kind='subtitles';e.src=t.url;e.label=t.lang||('Sous-titres '+(i+1));vid.appendChild(e)});
  const start=(p.progress[pkey]||{}).t||0;
  const go=()=>{vid.src=s.url;vid.onloadedmetadata=()=>{if(start>20&&start<vid.duration*0.95)vid.currentTime=start};vid.play().catch(()=>{})};
  if(/\.m3u8(\?|$)/i.test(s.url)&&!vid.canPlayType('application/vnd.apple.mpegurl')&&window.Hls){
    const h=new Hls({maxBufferLength:60,maxMaxBufferLength:120,backBufferLength:30,enableWorker:true});h.loadSource(s.url);h.attachMedia(vid);vid.onloadedmetadata=()=>{if(start>20)vid.currentTime=start};vid.play().catch(()=>{});vid._h=h;
  } else go();
  vid._w=0;vid.onwaiting=()=>{vid._w=(vid._w||0)+1};
  diagStart();
  vid.dataset.meta=JSON.stringify({type:m.type,id:m.id,name:title||m.name,poster:m.poster});
}
vid.ontimeupdate=()=>{
  if(!pkey||Date.now()-last<4000||!isFinite(vid.duration))return; last=Date.now();
  const meta=JSON.parse(vid.dataset.meta||'null'); P().progress[pkey]={t:vid.currentTime,d:vid.duration,at:Date.now(),meta}; save();
};
$('#plf').onclick=()=>{try{if(vid.webkitEnterFullscreen)vid.webkitEnterFullscreen();else if(vid.requestFullscreen)vid.requestFullscreen()}catch(e){}};
$('#plx').onclick=()=>{document.body.classList.remove('playing');vid.pause();if(vid._h){vid._h.destroy();vid._h=null}vid.removeAttribute('src');vid.load();$('#pl').style.display='none';pkey=null};

/* ---------- pages ---------- */
function myList(){
  setNav('list'); const l=P().list; remember(l);
  app.innerHTML='<h2>Ma liste</h2>'+(l.length?`<div class="grid">${l.map(m=>card(m)).join('')}</div>`:'<p class="pad mut">Ajoute des titres avec le bouton « + Ma liste ».</p>');
}
function addonsPage(){
  setNav('addons'); const p=P();
  app.innerHTML=`<div class="pad"><h2 style="margin:0 0 10px">Addons de ${esc(p.name)}</h2>
  <textarea class="f" id="au" rows="3" placeholder="URL(s) d’addon, une par ligne (…/manifest.json ou stremio://…)" autocapitalize="off" autocorrect="off"></textarea>
  <button class="btn" id="aa">Ajouter</button> <span id="am" class="mut"></span><div style="margin-top:16px">
  ${p.addons.map((a,i)=>`<div class="box"><b>${esc(a.manifest.name)}</b> <span class="mut">v${esc(a.manifest.version||'')}</span><small>${esc(a.manifest.description||'')}</small><small>${esc(a.base)}</small><button class="btn g" style="margin-top:8px" data-r="${i}">Retirer</button></div>`).join('')||'<p class="mut">Aucun addon.</p>'}</div></div>`;
  $('#aa').onclick=async()=>{const us=$('#au').value.split(/\s+/).filter(Boolean);if(!us.length)return;
    let ok=0,ko=[];for(let i=0;i<us.length;i++){$('#am').textContent='Ajout '+(i+1)+'/'+us.length+'…';try{await addAddon(us[i]);ok++}catch(e){ko.push(us[i])}}
    addonsPage(); if(ko.length)$('#am').textContent=ok+' ajouté(s). Échec : '+ko.join(' , ')+' (URL invalide, injoignable, http ou CORS)'; else $('#am').textContent=ok+' ajouté(s)'};
  app.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>{p.addons.splice(+b.dataset.r,1);save();addonsPage()});
}
function profilesPage(){
  setNav('profiles');
  app.innerHTML=`<div class="pad"><h2 style="margin:0 0 8px">Compte</h2>
  ${auth?`<div class="box"><b>Connecté</b><small>${esc(auth.email||'')}</small><small id="sm">${esc(syncMsg)}</small><div style="display:flex;gap:8px;margin-top:10px"><button class="btn g" id="sy">Synchroniser</button><button class="btn g" id="lo">Déconnexion</button></div></div>`:
  `<div class="box"><small style="margin:0 0 8px">Connecte-toi pour retrouver tes addons, ta liste et ta progression sur tous tes appareils.</small>
  <input class="f" id="ae" type="email" placeholder="E-mail" autocapitalize="off" autocorrect="off"><input class="f" id="ap" type="password" placeholder="Mot de passe (6 caractères min.)">
  <div style="display:flex;gap:8px"><button class="btn" id="ali">Connexion</button><button class="btn g" id="acr">Créer un compte</button></div><small id="am2" style="margin-top:8px"></small></div>`}
  <h2 style="margin:20px 0 10px">Profils</h2>${db.profiles.map(p=>`<div class="box" style="display:flex;align-items:center;gap:10px"><b style="flex:1">${esc(p.name)}${p.id===db.cur?' ✓':''}</b>${p.id===db.cur?'':`<button class="btn g" data-u="${p.id}">Choisir</button>`}${db.profiles.length>1?`<button class="btn g" data-d="${p.id}">✕</button>`:''}</div>`).join('')}
  <input class="f" id="pn" placeholder="Nouveau profil (prénom)"><button class="btn" id="pa">Créer</button>
  <h2 style="margin:24px 0 8px">Sauvegarde / migration</h2>
  <p class="mut" style="font-size:13px;margin:0 0 8px">Copie le texte ci-dessous pour déplacer ce profil vers un autre appareil, ou colle ici celui d’un autre Lumen puis appuie sur Importer.</p>
  <textarea class="f" id="ex" rows="4" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(JSON.stringify({lumen:1,name:P().name,addons:P().addons.map(a=>a.base),list:P().list,progress:P().progress}))}</textarea>
  <button class="btn g" id="imp">Importer</button> <span id="im" class="mut"></span>
  <p class="mut" style="margin-top:20px;font-size:13px">Les profils (addons, liste, progression) sont enregistrés sur cet appareil. Chaque ami a sa propre installation.</p></div>`;

  if($('#sy'))$('#sy').onclick=async()=>{$('#sm').textContent='Synchro…';await syncPull();await syncPush();profilesPage()};
  if($('#lo'))$('#lo').onclick=()=>{auth=null;saveAuth();syncMsg='';profilesPage()};
  const doAuth=async create=>{const e=$('#ae').value.trim(),p=$('#ap').value;if(!e||!p){$('#am2').textContent='Entre ton e-mail et ton mot de passe.';return}
    $('#am2').textContent='Un instant…';try{await signIn(e,p,create);profilesPage()}catch(x){$('#am2').textContent=x.message}};
  if($('#ali'))$('#ali').onclick=()=>doAuth(false);
  if($('#acr'))$('#acr').onclick=()=>doAuth(true);
  $('#imp').onclick=async()=>{let d;try{d=JSON.parse($('#ex').value);if(!d.lumen)throw 0}catch(e){$('#im').textContent='Texte invalide.';return}
    const p=P();$('#im').textContent='Import…';
    for(const u of d.addons||[]){if(!p.addons.some(a=>a.base===u)){try{await addAddon(u)}catch(e){}}}
    for(const m of d.list||[]){if(!p.list.some(x=>x.id===m.id&&x.type===m.type))p.list.push(m)}
    for(const [k,v] of Object.entries(d.progress||{})){if(!p.progress[k]||p.progress[k].at<v.at)p.progress[k]=v}
    save();profilesPage()};
  $('#pa').onclick=()=>{const n=$('#pn').value.trim();if(!n)return;const id='p'+Date.now();db.profiles.push({id,name:n,addons:[],list:[],progress:{}});db.cur=id;save();profilesPage()};
  app.querySelectorAll('[data-u]').forEach(b=>b.onclick=()=>{db.cur=b.dataset.u;save();profilesPage()});
  app.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{if(!confirm('Supprimer ce profil ?'))return;db.profiles=db.profiles.filter(p=>p.id!==b.dataset.d);if(db.cur===b.dataset.d)db.cur=db.profiles[0].id;save();profilesPage()});
}

/* ---------- routeur ---------- */
function route(){
  const h=decodeURIComponent(location.hash.slice(1)||'/'); const parts=location.hash.slice(1).split('/').map(decodeURIComponent);
  if(h.startsWith('/s/'))return search(h.slice(3));
  if(parts[1]==='d')return detail(parts[2],parts.slice(3).join('/'));
  if(h==='/list')return myList();
  if(h==='/addons')return addonsPage();
  if(h==='/profiles')return profilesPage();
  return home();
}
addEventListener('hashchange',route);
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.value.trim()){location.hash='#/s/'+enc(e.target.value.trim());e.target.blur()}});
route();
if(auth)syncPull().then(()=>{if(!document.getElementById('pl')||document.getElementById('pl').style.display!=='block')route()});
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
