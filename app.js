const API_BASE = "https://always-yours-chat-api.myintmoehein0115024.workers.dev";
const API_TIMEOUT_MS = 9000;
const POLL_MS = 10000;
const TTL_MS = 48 * 60 * 60 * 1000;
const ROOM_SALT = "always-yours-room-v2";
const KEY_SALT = "always-yours-e2ee-v2";
const MAX_VISIBLE_MESSAGES = 80;
const CACHE_PREFIX = "alwaysYoursMessageCache:";
const STICKERS = ["🥰","😘","🫶","💞","🌙","💋","🩷","🤍","抱抱 ♡","想你了 ♡","晚安 🌙","永远是你 💞"];
const EMOJIS = ["😊","🥰","😘","😍","🫶","💕","💗","💖","💞","💋","🌹","🌙","✨","🥺","🤍","❤️‍🔥","🩷","😚","😌","💐"];

const $ = (id) => document.getElementById(id);
const gate = $("gate");
const chat = $("chat");
const secretInput = $("secret");
const statusEl = $("status");
const messagesEl = $("messages");
const emptyState = $("emptyState");
const input = $("messageInput");
const sendBtn = $("sendBtn");
const toastEl = $("toast");
const connectionState = $("connectionState");
const stickerPanel = $("stickerPanel");
const photoBtn = $("photoBtn");
const photoInput = $("photoInput");
const photoPreview = $("photoPreview");
const photoPreviewImg = $("photoPreviewImg");
const photoPreviewName = $("photoPreviewName");
const photoPreviewMeta = $("photoPreviewMeta");
const removePhotoBtn = $("removePhotoBtn");
const installBtn = $("installBtn");
const newMessageHint = $("newMessageHint");
const selectedPerson = $("selectedPerson");
const gateInstallBtn = $("gateInstallBtn");
const installModal = $("installModal");
const installSteps = $("installSteps");
const installLead = $("installLead");
const installAction = $("installAction");
const closeInstall = $("closeInstall");
const installButtons = [installBtn, gateInstallBtn].filter(Boolean);
const emojiPanel = $("emojiPanel");

const chatHeader = document.querySelector(".chat-header > div:first-child");
const roomLabelEl = $("roomLabel");
let presenceEl = null;
let editBar = null;

function ensurePresenceUi(){
  if(!chatHeader || presenceEl) return;
  presenceEl=document.createElement("div");
  presenceEl.id="partnerPresence";
  presenceEl.className="partner-presence is-away";
  presenceEl.innerHTML='<span class="presence-dot" aria-hidden="true"></span><span class="presence-text">Chit Chit · checking…</span>';
  (roomLabelEl || chatHeader).insertAdjacentElement("afterend",presenceEl);
}
function ensureEditBar(){
  if(editBar || !document.querySelector(".composer-wrap")) return;
  editBar=document.createElement("div");
  editBar.id="editBar";
  editBar.className="edit-bar hidden";
  editBar.innerHTML='<div class="edit-bar-copy"><span class="edit-bar-icon">✎</span><div><strong>Editing your message</strong><span id="editBarText"></span></div></div><button type="button" id="cancelEditBtn" class="edit-cancel">Cancel</button>';
  document.querySelector(".composer-wrap").insertBefore(editBar,document.querySelector(".composer-wrap").firstElementChild);
  editBar.querySelector("#cancelEditBtn").addEventListener("click",cancelEdit);
}
ensurePresenceUi();
ensureEditBar();

let selectedName = localStorage.getItem("alwaysYoursName") || "Ko Ko";
let roomId = null;
let cryptoKey = null;
let deferredInstallPrompt = null;
let pollTimer = null;
let syncing = false;
let lastMessageIds = "";
let lastRenderedCount = 0;
let firstSync = true;
let draftTimer = null;
let selectedPhotoFile = null;
let selectedPhotoPreviewUrl = null;
const mediaObjectUrls = new Set();
let editingMessageId = null;
let presenceTimer = null;
let presenceSyncBusy = false;
const readMarkedIds = new Set();

function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 2300);
}
function setStatus(msg){ statusEl.textContent = msg; }
function updateConnection(msg){ connectionState.textContent = msg; }
function bytesToBase64(bytes){
  let s="";
  const a=new Uint8Array(bytes);
  for(let i=0;i<a.length;i+=0x8000) s+=String.fromCharCode(...a.subarray(i,i+0x8000));
  return btoa(s);
}
function base64ToBytes(s){
  const bin=atob(s); const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function sha256Hex(text){
  const b=new TextEncoder().encode(text);
  const h=await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function deriveKey(secret){
  const raw=await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2", salt:new TextEncoder().encode(KEY_SALT), iterations:150000, hash:"SHA-256"},
    raw,
    {name:"AES-GCM", length:256},
    false,
    ["encrypt","decrypt"]
  );
}
async function encryptPayload(payload){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=new TextEncoder().encode(JSON.stringify(payload));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},cryptoKey,plaintext);
  return {iv:bytesToBase64(iv), ciphertext:bytesToBase64(cipher)};
}
async function decryptPayload(ivB64,cipherB64){
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(ivB64)},cryptoKey,base64ToBytes(cipherB64));
  return JSON.parse(new TextDecoder().decode(plain));
}
function sanitizeSecret(v){ return v.trim().replace(/\s+/g," "); }
function formatTime(value){
  const d=new Date(Number(value)||Date.now());
  return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(d);
}
function formatSeenTime(value){ return new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"}).format(new Date(Number(value)||Date.now())); }

function showChat(){ gate.classList.add("hidden"); chat.classList.remove("hidden"); ensurePresenceUi(); ensureEditBar(); }
function showGate(){
  chat.classList.add("hidden");
  gate.classList.remove("hidden");
  stopPolling();
  stopPresence();
  cancelEdit();
  input.value="";
}
function userIsMine(sender){ return sender===selectedName; }
function renderSticker(text){ const d=document.createElement("div"); d.className="sticker-message"; d.textContent=text; return d; }

function cacheKey(){ return `${CACHE_PREFIX}${roomId}`; }
function saveCache(items){
  try{ localStorage.setItem(cacheKey(), JSON.stringify(items.slice(-MAX_VISIBLE_MESSAGES))); }catch{}
}
function loadCache(){
  try{
    const parsed=JSON.parse(localStorage.getItem(cacheKey())||"[]");
    const now=Date.now();
    return Array.isArray(parsed) ? parsed.filter(x => Number(x.expires_at||0)>now) : [];
  }catch{return []}
}

function dayKey(value){ const d=new Date(Number(value)||Date.now()); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function dayLabel(value){ const d=new Date(Number(value)||Date.now()); const now=new Date(); if(dayKey(d.getTime())===dayKey(now.getTime())) return "Today"; const y=new Date(now); y.setDate(now.getDate()-1); if(dayKey(d.getTime())===dayKey(y.getTime())) return "Yesterday"; return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(d); }
function expiryLabel(ts){ const remain=Math.max(0,Number(ts||0)-Date.now()); const h=Math.floor(remain/3600000); const m=Math.floor((remain%3600000)/60000); return h>0?`vanishes in ${h}h ${m}m`:`vanishes in ${m}m`; }
function showNewHint(){ if(!newMessageHint) return; newMessageHint.classList.remove("hidden"); clearTimeout(showNewHint._t); showNewHint._t=setTimeout(()=>newMessageHint.classList.add("hidden"),2200); }
function renderMessages(items){
  for(const url of mediaObjectUrls){ try{URL.revokeObjectURL(url)}catch{} }
  mediaObjectUrls.clear();
  messagesEl.innerHTML="";
  if(!items.length){ emptyState.classList.remove("hidden"); return; }
  emptyState.classList.add("hidden");
  let previousDay="";
  for(const item of items){
    const currentDay=dayKey(item.created_at);
    if(currentDay!==previousDay){
      const divider=document.createElement("div"); divider.className="date-divider"; divider.textContent=dayLabel(item.created_at); messagesEl.appendChild(divider); previousDay=currentDay;
    }
    const mine=userIsMine(item.sender);
    const row=document.createElement("div");
    row.className=`message-row ${mine?"mine":"theirs"}`;
    if(item.kind==="image") row.classList.add("photo-row");
    if(item.kind==="sticker") row.classList.add("sticker-row");
    const bubble=document.createElement("div"); bubble.className="message-bubble";
    if(item.kind==="image") bubble.classList.add("photo-bubble");
    if(item.kind==="sticker") bubble.classList.add("sticker-bubble");
    const sender=document.createElement("div"); sender.className="sender"; sender.textContent=mine?"YOU":(item.sender||"CHIT CHIT");
    bubble.appendChild(sender);
    if(item.kind==="sticker") bubble.appendChild(renderSticker(item.text));
    else if(item.kind==="image"){
      const media=document.createElement("div"); media.className="image-message";
      hydrateImageMessage(media,item);
      bubble.appendChild(media);
    } else {
      const t=document.createElement("div"); t.className="message-text"; t.textContent=item.text; bubble.appendChild(t);
      if(mine){
        const actions=document.createElement("div"); actions.className="message-actions";
        const edit=document.createElement("button"); edit.type="button"; edit.className="message-edit-button"; edit.textContent="Edit"; edit.setAttribute("aria-label","Edit this message");
        edit.addEventListener("click",()=>beginEdit(item));
        actions.appendChild(edit);
        bubble.appendChild(actions);
      }
    }
    const meta=document.createElement("div"); meta.className="message-meta-row";
    const tm=document.createElement("div"); tm.className="message-time"; tm.textContent=formatTime(item.created_at); meta.appendChild(tm);
    if(item.edited_at){ const ed=document.createElement("span"); ed.className="message-edited"; ed.textContent="edited"; meta.appendChild(ed); }
    const age=document.createElement("span"); age.className="message-age"; age.textContent=expiryLabel(item.expires_at); meta.appendChild(age);
    bubble.appendChild(meta);
    if(mine){
      const read=document.createElement("div"); read.className=`message-read-status ${item.seen_at?"is-seen":"is-sent"}`;
      read.textContent=item.seen_at?`Seen ♡ · ${formatSeenTime(item.seen_at)}`:"Sent · waiting to be seen";
      bubble.appendChild(read);
    }
    row.appendChild(bubble); messagesEl.appendChild(row);
  }
  requestAnimationFrame(()=>{ messagesEl.scrollTop = messagesEl.scrollHeight; });
}

async function withTimeout(promise){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), API_TIMEOUT_MS);
  try{ return await promise(controller.signal); } finally { clearTimeout(timer); }
}

async function apiGetMessages(){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/messages`,{method:"GET",headers:{"X-Room-Key":roomId},signal,cache:"no-store"});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not read messages");
    return data.messages||[];
  });
}

async function apiSendMessage(payload){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/messages`,{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Room-Key":roomId},
      body:JSON.stringify(payload),
      signal,
      cache:"no-store"
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not send message");
    return data;
  });
}

async function apiEditMessage(id,payload){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/messages/${encodeURIComponent(id)}`,{
      method:"PATCH",
      headers:{"Content-Type":"application/json","X-Room-Key":roomId,"X-User":selectedName},
      body:JSON.stringify(payload),
      signal,
      cache:"no-store"
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not edit message");
    return data;
  });
}

async function apiMarkRead(ids){
  const list=[...new Set(ids||[])].slice(0,MAX_VISIBLE_MESSAGES);
  if(!list.length || !roomId) return;
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/read`,{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Room-Key":roomId,"X-User":selectedName},
      body:JSON.stringify({ids:list}),
      signal,
      cache:"no-store"
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not mark messages as seen");
    return data;
  });
}

async function apiPresence(online=true){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/presence`,{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Room-Key":roomId,"X-User":selectedName},
      body:JSON.stringify({online}),
      signal,
      cache:"no-store",
      keepalive:!online
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not update presence");
    return data;
  });
}

async function apiGetPresence(){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/presence`,{method:"GET",headers:{"X-Room-Key":roomId},signal,cache:"no-store"});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not read presence");
    return data;
  });
}



async function apiUploadMedia(encryptedBuffer, mediaKey){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/media`,{
      method:"POST",
      headers:{"Content-Type":"application/octet-stream","X-Room-Key":roomId,"X-Media-Key":mediaKey},
      body:encryptedBuffer,
      signal,
      cache:"no-store"
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Could not upload photo");
    return data;
  });
}

async function apiGetMedia(mediaKey){
  return withTimeout(async(signal)=>{
    const res=await fetch(`${API_BASE}/api/media?key=${encodeURIComponent(mediaKey)}`,{
      method:"GET",
      headers:{"X-Room-Key":roomId},
      signal,
      cache:"no-store"
    });
    if(!res.ok) throw new Error("Photo is no longer available.");
    return await res.arrayBuffer();
  });
}

async function encryptBinary(buffer){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},cryptoKey,buffer);
  return {iv:bytesToBase64(iv),ciphertext:cipher};
}

async function compressImage(file){
  const MAX_ORIGINAL=15*1024*1024;
  const MAX_OUTPUT=3.5*1024*1024;
  if(file.size>MAX_ORIGINAL) throw new Error("Please choose a photo smaller than 15 MB.");
  const bitmap=await createImageBitmap(file);
  const maxSide=1800;
  const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const width=Math.max(1,Math.round(bitmap.width*scale));
  const height=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement("canvas");
  canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext("2d",{alpha:false});
  if(!ctx){bitmap.close(); throw new Error("Photo processing is unavailable on this device.");}
  ctx.drawImage(bitmap,0,0,width,height);
  bitmap.close();
  let quality=.84;
  let blob=await new Promise(r=>canvas.toBlob(r,"image/webp",quality));
  if(!blob) blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",quality));
  while(blob && blob.size>MAX_OUTPUT && quality>.55){
    quality-=.06;
    blob=await new Promise(r=>canvas.toBlob(r,"image/webp",quality));
  }
  if(!blob) throw new Error("Could not prepare this photo.");
  return new File([blob],"always-yours-photo.webp",{type:blob.type||"image/webp"});
}

function clearSelectedPhoto(){
  if(selectedPhotoPreviewUrl){ URL.revokeObjectURL(selectedPhotoPreviewUrl); selectedPhotoPreviewUrl=null; }
  selectedPhotoFile=null;
  if(photoPreviewImg) photoPreviewImg.removeAttribute("src");
  photoPreview?.classList.add("hidden");
  if(photoInput) photoInput.value="";
  if(input) input.placeholder="Write something only we need to see…";
  updateSendButton();
}

function updateSendButton(){
  if(!sendBtn) return;
  const hasText=Boolean(input?.value.trim());
  const hasPhoto=Boolean(selectedPhotoFile);
  sendBtn.textContent=hasPhoto ? (hasText?"Send photo + note ♡":"Send photo ♡") : "Send ♡";
  sendBtn.disabled=!hasText && !hasPhoto;
}

async function choosePhoto(file){
  if(editingMessageId) cancelEdit();
  if(!file || !file.type.startsWith("image/")) return;
  try{
    const prepared=await compressImage(file);
    if(selectedPhotoPreviewUrl) URL.revokeObjectURL(selectedPhotoPreviewUrl);
    selectedPhotoFile=prepared;
    selectedPhotoPreviewUrl=URL.createObjectURL(prepared);
    photoPreviewImg.src=selectedPhotoPreviewUrl;
    photoPreviewName.textContent=file.name;
    photoPreviewMeta.textContent=`Ready to send · ${Math.max(1,Math.round(prepared.size/1024))} KB after compression · encrypted before upload`;
    photoPreview.classList.remove("hidden");
    input.placeholder="Add a little note with this photo…";
    input.focus();
    updateSendButton();
  }catch(error){
    console.error(error);
    toast(error.message||"Could not prepare this photo.");
    clearSelectedPhoto();
  }
}

async function savePhotoBlob(blob,mime,name){
  const ext=mime.includes("png")?"png":mime.includes("jpeg")||mime.includes("jpg")?"jpg":"webp";
  const safeName=(name||`always-yours-${Date.now()}.${ext}`).replace(/[^a-zA-Z0-9._-]+/g,"-");
  const file=new File([blob],safeName,{type:mime||blob.type||"image/webp"});
  try{
    if(navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({title:"Always Yours ♡",text:"A little memory for us.",files:[file]});
      toast("Choose Save Image / Save to Photos ♡");
      return;
    }
  }catch(error){
    if(error?.name==="AbortError") return;
  }
  const url=URL.createObjectURL(blob);
  mediaObjectUrls.add(url);
  const a=document.createElement("a");
  a.href=url; a.download=safeName; a.rel="noopener";
  document.body.appendChild(a); a.click(); a.remove();
  toast("Photo saved to your downloads ♡");
  setTimeout(()=>{URL.revokeObjectURL(url);mediaObjectUrls.delete(url)},1500);
}

async function hydrateImageMessage(container,item){
  const loading=document.createElement("div"); loading.className="image-loading"; loading.textContent="Opening our little memory…";
  container.appendChild(loading);
  try{
    const encrypted=await apiGetMedia(item.media_key);
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(item.image_iv)},cryptoKey,encrypted);
    const blob=new Blob([plain],{type:item.mime||"image/webp"});
    const url=URL.createObjectURL(blob); mediaObjectUrls.add(url);
    loading.remove();
    const frame=document.createElement("div"); frame.className="image-frame";
    const img=document.createElement("img"); img.className="message-image"; img.alt=item.name||"Shared photo"; img.loading="lazy"; img.src=url;
    img.addEventListener("click",()=>openPhotoViewer({url,blob,name:item.name||"always-yours-photo.webp",mime:item.mime||"image/webp"}));
    frame.appendChild(img); container.appendChild(frame);
    if(item.text){ const cap=document.createElement("div"); cap.className="image-caption"; cap.textContent=item.text; container.appendChild(cap); }
    const actions=document.createElement("div"); actions.className="image-actions";
    const save=document.createElement("button"); save.type="button"; save.className="image-action-button"; save.textContent="Save to Photos / Gallery ♡";
    save.addEventListener("click",()=>savePhotoBlob(blob,item.mime||"image/webp",item.name)); actions.appendChild(save);
    container.appendChild(actions);
  }catch(error){
    loading.className="image-error"; loading.textContent="This photo has expired or is no longer available. ♡";
  }
}

async function decodeItems(raw){
  const out=[];
  for(const item of raw){
    if(Number(item.expires_at||0)<=Date.now()) continue;
    try{
      const payload=await decryptPayload(item.iv,item.ciphertext);
      out.push({
        id:item.id,
        sender:item.sender,
        created_at:item.created_at,
        expires_at:item.expires_at,
        edited_at:Number(item.edited_at||0) || 0,
        seen_at:Number(item.seen_at||0) || 0,
        kind:payload.kind,
        text:payload.text || "",
        media_key:payload.mediaKey || item.media_key || "",
        image_iv:payload.imageIv || "",
        mime:payload.mime || "image/webp",
        name:payload.name || "always-yours-photo.webp"
      });
    }catch{}
  }
  return out.slice(-MAX_VISIBLE_MESSAGES);
}


async function markVisibleMessagesRead(items){
  if(!roomId || !items?.length) return;
  const unreadIds=items.filter(item=>!userIsMine(item.sender) && !readMarkedIds.has(item.id)).map(item=>item.id);
  if(!unreadIds.length) return;
  try{
    await apiMarkRead(unreadIds);
    unreadIds.forEach(id=>readMarkedIds.add(id));
  }catch{}
}

function renderPresenceStatus(data){
  ensurePresenceUi();
  if(!presenceEl) return;
  const partner=otherUser(selectedName);
  const record=data?.presence?.[partner];
  const online=Boolean(record?.online);
  const text=online ? `${partner} · Online now` : (record?.last_seen ? `${partner} · ${lastSeenLabel(record.last_seen)}` : `${partner} · not online yet`);
  presenceEl.classList.toggle("is-online",online);
  presenceEl.classList.toggle("is-away",!online);
  const textEl=presenceEl.querySelector(".presence-text");
  if(textEl) textEl.textContent=text;
}
function lastSeenLabel(value){
  const diff=Math.max(0,Date.now()-Number(value||0));
  if(diff<60000) return "just now";
  const mins=Math.floor(diff/60000);
  if(mins<60) return `last seen ${mins}m ago`;
  const hours=Math.floor(mins/60);
  if(hours<24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours/24)}d ago`;
}
async function syncPresence(){
  if(!roomId || presenceSyncBusy || document.visibilityState==="hidden") return;
  presenceSyncBusy=true;
  try{ renderPresenceStatus(await apiGetPresence()); }catch{} finally{ presenceSyncBusy=false; }
}
function startPresence(){
  stopPresence();
  apiPresence(true).catch(()=>{});
  syncPresence();
  presenceTimer=setInterval(()=>{
    if(document.visibilityState==="hidden") return;
    apiPresence(true).catch(()=>{});
    syncPresence();
  },30000);
}
function stopPresence(){ if(presenceTimer){clearInterval(presenceTimer);presenceTimer=null;} }

async function syncMessages({silent=false}={}){
  if(!roomId || !cryptoKey || syncing) return;
  syncing=true;
  try{
    const raw=await apiGetMessages();
    const items=await decodeItems(raw);
    const ids=items.map(x=>`${x.id}:${x.edited_at||0}:${x.seen_at||0}`).join("|");
    const changed=ids!==lastMessageIds;
    lastMessageIds=ids;
    saveCache(items);
    if(changed || !messagesEl.children.length) renderMessages(items);
    markVisibleMessagesRead(items);
    syncPresence();
    updateConnection("Live · synced");
    if(!firstSync && changed && items.length>lastRenderedCount){ showNewHint(); }
    firstSync=false;
    lastRenderedCount=items.length;
  }catch(error){
    const cached=loadCache();
    if(cached.length && !messagesEl.children.length) renderMessages(cached);
    updateConnection(navigator.onLine?"Waiting for sync…":"Offline · saved here");
    if(!silent && navigator.onLine) toast("Couldn't sync right now.");
  }finally{
    syncing=false;
  }
}

function startPolling(){
  stopPolling();
  syncMessages({silent:true});
  pollTimer=setInterval(()=>{ if(document.visibilityState!=="hidden") syncMessages({silent:true}); }, POLL_MS);
}
function stopPolling(){ if(pollTimer){clearInterval(pollTimer);pollTimer=null;} }

async function connectRoom(secret){
  secret=sanitizeSecret(secret);
  if(secret.length<10){ setStatus("Please use a secret of at least 10 characters."); return; }
  setStatus("Opening your little room…");
  try{
    roomId=(await sha256Hex(`${ROOM_SALT}:${secret}`)).slice(0,40);
    cryptoKey=await deriveKey(secret);
    const cached=loadCache();
    lastMessageIds=cached.map(x=>x.id).join("|");
    showChat();
    $("roomLabel").textContent=`Private room · ${selectedName}`;
    ensurePresenceUi();
    if(cached.length) renderMessages(cached);
    updateConnection("Connecting…");
    startPolling();
    startPresence();
  }catch(error){
    console.error(error);
    setStatus("Could not open your private room.");
    toast("Please try again.");
  }
}


function beginEdit(item){
  if(!item || item.kind!=="text" || !userIsMine(item.sender)) return;
  editingMessageId=item.id;
  ensureEditBar();
  input.value=item.text||"";
  input.style.height="auto";
  input.style.height=Math.min(input.scrollHeight,130)+"px";
  if(editBar){
    editBar.classList.remove("hidden");
    const label=editBar.querySelector("#editBarText");
    if(label) label.textContent=(item.text||"").slice(0,80);
  }
  sendBtn.textContent="Save edit ♡";
  sendBtn.disabled=!String(input.value||"").trim();
  input.placeholder="Edit your message…";
  input.focus();
  requestAnimationFrame(()=>{ document.querySelector(".composer-wrap")?.scrollIntoView({behavior:"smooth",block:"end"}); });
}
function cancelEdit(){
  editingMessageId=null;
  if(editBar) editBar.classList.add("hidden");
  if(input) input.placeholder="Write something only we need to see…";
  updateSendButton();
}
async function editMessage(){
  const id=editingMessageId;
  const text=String(input.value||"").trim();
  if(!id) return sendMessage();
  if(!text){ toast("An edited message cannot be empty."); return; }
  if(text.length>2000){ toast("Message is too long."); return; }
  sendBtn.disabled=true;
  try{
    const encrypted=await encryptPayload({kind:"text",text});
    await apiEditMessage(id,encrypted);
    cancelEdit();
    input.value="";
    input.style.height="auto";
    try{localStorage.removeItem("alwaysYoursDraft")}catch{}
    await syncMessages({silent:true});
    toast("Message updated ♡");
  }catch(error){
    console.error(error);
    toast(error.message||"Could not edit message.");
  }finally{
    updateSendButton();
    input.focus();
  }
}

async function sendMessage(kind="text", value=input.value){
  const textValue=String(value||"").trim();
  const hasPhoto=Boolean(selectedPhotoFile);
  if(!roomId || !cryptoKey || (!textValue && !hasPhoto)) return;
  if(textValue.length>2000){ toast("Message is too long."); return; }
  sendBtn.disabled=true;
  try{
    if(hasPhoto){
      const arrayBuffer=await selectedPhotoFile.arrayBuffer();
      const encryptedImage=await encryptBinary(arrayBuffer);
      const mediaKey=`${roomId}/${crypto.randomUUID()}.bin`;
      setStatus("Sending our little photo…");
      await apiUploadMedia(encryptedImage.ciphertext,mediaKey);
      const encryptedMessage=await encryptPayload({
        kind:"image",
        text:textValue,
        mediaKey,
        imageIv:encryptedImage.iv,
        mime:selectedPhotoFile.type||"image/webp",
        name:selectedPhotoFile.name||"always-yours-photo.webp"
      });
      await apiSendMessage({id:crypto.randomUUID(),sender:selectedName,media_key:mediaKey,...encryptedMessage});
      clearSelectedPhoto();
    }else{
      const encrypted=await encryptPayload({kind,text:textValue});
      await apiSendMessage({id:crypto.randomUUID(),sender:selectedName,...encrypted});
      input.value="";
      input.style.height="auto";
      try{localStorage.removeItem("alwaysYoursDraft")}catch{}
    }
    stickerPanel.classList.add("hidden");
    if(emojiPanel) emojiPanel.classList.add("hidden");
    setStatus("");
    await syncMessages({silent:true});
  }catch(error){
    console.error(error);
    toast(navigator.onLine?(error.message||"Could not send right now."):"You're offline · try again when connected.");
    updateConnection("Offline · saved here");
  }finally{
    updateSendButton();
    input.focus();
  }
}

function syncNameChoice(){
  document.querySelectorAll(".name-option").forEach(b=>{
    const active=b.dataset.name===selectedName;
    b.classList.toggle("active",active);
    b.setAttribute("aria-pressed",String(active));
  });
  if(selectedPerson) selectedPerson.textContent=`Selected: ${selectedName} ♡`;
}
for(const btn of document.querySelectorAll(".name-option")){
  btn.addEventListener("click",()=>{
    selectedName=btn.dataset.name;
    localStorage.setItem("alwaysYoursName",selectedName);
    syncNameChoice();
    if(roomId){ $("roomLabel").textContent=`Private room · ${selectedName}`; renderPresenceStatus({presence:{}}); apiPresence(true).catch(()=>{}); syncPresence(); }
  });
}
syncNameChoice();

$("toggleSecret").addEventListener("click",()=>{
  const show = secretInput.type === "password";
  secretInput.type = show ? "text" : "password";
  $("toggleSecret").textContent = show ? "Hide" : "Show";
  $("toggleSecret").setAttribute("aria-label", show ? "Hide secret" : "Show secret");
  $("toggleSecret").setAttribute("aria-pressed", String(show));
  secretInput.focus();
});
$("enterBtn").addEventListener("click",()=>connectRoom(secretInput.value));
secretInput.addEventListener("keydown",e=>{if(e.key==="Enter") connectRoom(secretInput.value);});
$("changeSecretBtn").addEventListener("click",()=>{ showGate(); cryptoKey=null; roomId=null; setStatus("Enter a secret to open another room."); secretInput.value=""; });
sendBtn.addEventListener("click",()=>editingMessageId?editMessage():sendMessage());
photoBtn?.addEventListener("click",()=>photoInput?.click());
photoInput?.addEventListener("change",()=>{ const file=photoInput.files?.[0]; if(file) choosePhoto(file); });
removePhotoBtn?.addEventListener("click",clearSelectedPhoto);
updateSendButton();
input.addEventListener("input",()=>{ input.style.height="auto"; input.style.height=Math.min(input.scrollHeight,130)+"px"; clearTimeout(draftTimer); draftTimer=setTimeout(()=>{ try{ localStorage.setItem("alwaysYoursDraft", input.value); }catch{} },220); updateSendButton(); });
input.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); editingMessageId?editMessage():sendMessage(); } });
try{ const savedDraft=localStorage.getItem("alwaysYoursDraft"); if(savedDraft) input.value=savedDraft; }catch{}

function buildStickerPanel(){
  stickerPanel.innerHTML="";
  const head=document.createElement("div");
  head.className="sticker-panel-head";
  head.innerHTML='<div><strong>Little feelings</strong><span>Pick one for us ♡</span></div><span class="sticker-panel-spark">✦</span>';
  stickerPanel.appendChild(head);
  const grid=document.createElement("div");
  grid.className="sticker-grid";
  for(const s of STICKERS){
    const b=document.createElement("button");
    b.type="button";
    b.className=s.length>3?"sticker text-sticker":"sticker";
    const parts=s.split(" ");
    const face=parts.shift() || "♡";
    const label=parts.join(" ");
    const faceEl=document.createElement("span");
    faceEl.className="sticker-face";
    faceEl.textContent=face;
    b.appendChild(faceEl);
    if(label){
      const labelEl=document.createElement("span");
      labelEl.className="sticker-label";
      labelEl.textContent=label;
      b.appendChild(labelEl);
    }
    b.title=`Send ${s}`;
    b.addEventListener("click",()=>sendMessage("sticker",s));
    grid.appendChild(b);
  }
  stickerPanel.appendChild(grid);
}
buildStickerPanel();

function buildEmojiPanel(){
  if(!emojiPanel) return;
  const groups={
    "All": EMOJIS,
    "Faces": ["😊","🥰","😘","😍","🫶","🥺","😚","😌","🤭","☺️","😇","🤗","😋","😉"],
    "Love": ["🫶","💕","💗","💖","💞","💋","🌹","💘","🩷","🤍","❤️‍🔥","💐","💓","💝"],
    "Soft": ["🌙","✨","🥺","🤍","🩷","💗","💞","🌷","🌸","🪽","☁️","⭐","💫","🫧"]
  };
  let current="All";
  const render=()=>{
    emojiPanel.innerHTML="";
    const head=document.createElement("div");
    head.className="emoji-panel-head";
    head.innerHTML='<div><strong>Little feelings</strong><span>Pick a feeling for us ♡</span></div><span class="emoji-panel-spark">✦</span>';
    emojiPanel.appendChild(head);
    const tabs=document.createElement("div");
    tabs.className="emoji-tabs";
    Object.keys(groups).forEach(name=>{
      const tab=document.createElement("button");
      tab.type="button"; tab.className="emoji-tab"; tab.textContent=name;
      tab.setAttribute("aria-selected",String(name===current));
      tab.addEventListener("click",()=>{current=name; render();});
      tabs.appendChild(tab);
    });
    emojiPanel.appendChild(tabs);
    const grid=document.createElement("div"); grid.className="emoji-grid";
    groups[current].forEach(e=>{
      const b=document.createElement("button");
      b.type="button"; b.className="emoji-choice"; b.textContent=e; b.title=`Use ${e}`;
      b.addEventListener("click",()=>{ input.value += e; input.focus(); updateSendButton(); });
      grid.appendChild(b);
    });
    emojiPanel.appendChild(grid);
    const foot=document.createElement("div");
    foot.className="emoji-panel-foot"; foot.textContent="Tap an emoji to add it to your message ♡";
    emojiPanel.appendChild(foot);
  };
  render();
}
buildEmojiPanel();

function ensurePhotoViewer(){
  if(document.getElementById("photoViewer")) return document.getElementById("photoViewer");
  const modal=document.createElement("div");
  modal.id="photoViewer"; modal.className="photo-viewer hidden"; modal.setAttribute("aria-hidden","true");
  modal.innerHTML=`
    <div class="photo-viewer-backdrop" data-photo-close="1"></div>
    <div class="photo-viewer-sheet" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div class="photo-viewer-topbar">
        <div class="photo-viewer-title"><span class="photo-viewer-heart">♡</span><span id="photoViewerName">Our little memory</span></div>
        <button type="button" class="photo-viewer-close" id="photoViewerClose" aria-label="Back to chat">Back to chat</button>
      </div>
      <div class="photo-viewer-stage" id="photoViewerStage">
        <img id="photoViewerImg" alt="Shared photo">
      </div>
      <div class="photo-viewer-controls">
        <button type="button" class="viewer-tool" id="photoZoomOut" aria-label="Zoom out">−</button>
        <button type="button" class="viewer-zoom" id="photoZoomReset" aria-label="Reset zoom">100%</button>
        <button type="button" class="viewer-tool" id="photoZoomIn" aria-label="Zoom in">+</button>
        <button type="button" class="viewer-tool viewer-save" id="photoViewerSave">Save ♡</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  let scale=1, state=null;
  const img=modal.querySelector("#photoViewerImg");
  const stage=modal.querySelector("#photoViewerStage");
  const label=modal.querySelector("#photoViewerName");
  const zoomLabel=modal.querySelector("#photoZoomReset");
  const applyScale=()=>{scale=Math.min(3.5,Math.max(.5,scale)); img.style.transform=`scale(${scale})`; zoomLabel.textContent=`${Math.round(scale*100)}%`;};
  const close=()=>{modal.classList.add("hidden");modal.setAttribute("aria-hidden","true");document.body.classList.remove("photo-viewer-open");img.style.transform="scale(1)";scale=1;state=null;};
  window.__alwaysYoursPhotoViewer={open(next){
    state=next; scale=1; applyScale(); img.src=next.url; img.alt=next.name||"Shared photo"; label.textContent=next.name||"Our little memory";
    modal.classList.remove("hidden"); modal.setAttribute("aria-hidden","false"); document.body.classList.add("photo-viewer-open");
  },close};
  modal.querySelector("#photoViewerClose").addEventListener("click",close);
  modal.querySelector("[data-photo-close]").addEventListener("click",close);
  modal.querySelector("#photoZoomOut").addEventListener("click",()=>{scale-=.25;applyScale();});
  modal.querySelector("#photoZoomIn").addEventListener("click",()=>{scale+=.25;applyScale();});
  modal.querySelector("#photoZoomReset").addEventListener("click",()=>{scale=1;applyScale();});
  modal.querySelector("#photoViewerSave").addEventListener("click",()=>{if(state) savePhotoBlob(state.blob,state.mime,state.name);});
  stage.addEventListener("wheel",e=>{if(modal.classList.contains("hidden"))return;e.preventDefault();scale += e.deltaY<0?.15:-.15;applyScale();},{passive:false});
  img.addEventListener("dblclick",()=>{scale=scale>1?1:2;applyScale();});
  document.addEventListener("keydown",e=>{
    if(modal.classList.contains("hidden")) return;
    if(e.key==="Escape" || e.key==="Backspace"){e.preventDefault();close();}
    if(e.key==="+"){scale+=.25;applyScale();}
    if(e.key==="-"){scale-=.25;applyScale();}
    if(e.key==="0"){scale=1;applyScale();}
  });
  return modal;
}
function openPhotoViewer(data){ ensurePhotoViewer(); window.__alwaysYoursPhotoViewer?.open(data); }

$("emojiBtn").addEventListener("click",()=>{ const open=emojiPanel.classList.toggle("hidden"); stickerPanel.classList.add("hidden"); $("emojiBtn").setAttribute("aria-expanded",String(!open)); $("stickerBtn").setAttribute("aria-expanded","false"); });
$("stickerBtn").addEventListener("click",()=>{ const open=stickerPanel.classList.toggle("hidden"); emojiPanel.classList.add("hidden"); $("stickerBtn").setAttribute("aria-expanded",String(!open)); $("emojiBtn").setAttribute("aria-expanded","false"); });

document.addEventListener("click",e=>{
  const target=e.target;
  if(emojiPanel && !emojiPanel.classList.contains("hidden") && !emojiPanel.contains(target) && target!==$("emojiBtn")){emojiPanel.classList.add("hidden");$("emojiBtn").setAttribute("aria-expanded","false");}
  if(stickerPanel && !stickerPanel.classList.contains("hidden") && !stickerPanel.contains(target) && target!==$("stickerBtn")){stickerPanel.classList.add("hidden");$("stickerBtn").setAttribute("aria-expanded","false");}
});

function isStandalone(){
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function deviceType(){
  const ua=navigator.userAgent||"";
  const iPad = /iPad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const iPhone = /iPhone|iPod/i.test(ua);
  const android = /Android/i.test(ua);
  if(iPad) return "ipad";
  if(iPhone) return "ios";
  if(android) return "android";
  return /Macintosh/i.test(ua) ? "mac" : "desktop";
}
function openInstallModal(){
  if(!installModal) return;
  const type=deviceType();
  let title="Add Always Yours ♡";
  let lead="Keep our little room one tap away.";
  let steps=[];
  let actionText="Install Always Yours ♡";
  let actionVisible=true;
  if(type==="android"){
    title="Add to your home screen ♡";
    lead="On Android, Always Yours can live beside your other apps.";
    steps=[
      ["1","Chrome","Tap the ⋮ menu in the top-right."],
      ["2","Install","Choose “Install app” or “Add to Home screen”."],
      ["3","Keep us close","Confirm the install, then open Always Yours from your home screen."]
    ];
  }else if(type==="ios" || type==="ipad"){
    title="Add Always Yours to Home ♡";
    lead="Safari saves us to your home screen like a little app.";
    steps=[
      ["1","Safari","Open this page in Safari if you are using another browser."],
      ["2","Share","Tap the Share button ⎋ at the bottom or top of Safari."],
      ["3","Add to Home Screen","Choose “Add to Home Screen”, then tap “Add”."]
    ];
    actionVisible=false;
  }else if(type==="mac"){
    title="Keep Always Yours on your Mac ♡";
    lead="You can install the private room as an app-style shortcut.";
    steps=[
      ["1","Chrome / Edge","Use the install icon near the address bar, or open the browser menu."],
      ["2","Install","Choose “Install Always Yours” or “Install app”."],
      ["3","Done","Open it later from your Applications / app launcher."]
    ];
  }else{
    title="Keep Always Yours on your computer ♡";
    lead="Install the page as an app so the private room has its own window.";
    steps=[
      ["1","Chrome / Edge","Look for the install icon in the address bar, or open the browser menu."],
      ["2","Install","Choose “Install Always Yours” or “Install app”."],
      ["3","Done","Open it later from your app list or desktop shortcut."]
    ];
  }
  installLead.textContent=lead;
  installSteps.innerHTML=steps.map(x=>`<div class="install-step"><span class="install-step-num">${x[0]}</span><div class="install-step-text"><strong>${x[1]}</strong><span>${x[2]}</span></div></div>`).join("");
  installAction.textContent=deferredInstallPrompt && actionVisible ? actionText : "Got it ♡";
  installAction.classList.toggle("hidden", !actionVisible && !(type==="ios"||type==="ipad"));
  installModal.querySelector("h3").textContent=title;
  installModal.classList.remove("hidden");
  document.body.classList.add("install-open");
}
function closeInstallModal(){
  installModal?.classList.add("hidden");
  document.body.classList.remove("install-open");
}
function refreshInstallButtons(){
  const installed=isStandalone();
  for(const b of installButtons) b?.classList.toggle("hidden", installed);
}
window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  deferredInstallPrompt=e;
  refreshInstallButtons();
});
window.addEventListener("appinstalled",()=>{ deferredInstallPrompt=null; refreshInstallButtons(); closeInstallModal(); toast("Always Yours is on your home screen ♡"); });
for(const b of installButtons) b?.addEventListener("click",async()=>{
  if(deferredInstallPrompt){
    try{
      deferredInstallPrompt.prompt();
      const choice=await deferredInstallPrompt.userChoice;
      if(choice.outcome!=="accepted") openInstallModal();
    }catch{ openInstallModal(); }
    deferredInstallPrompt=null;
    refreshInstallButtons();
  }else openInstallModal();
});
closeInstall?.addEventListener("click",closeInstallModal);
installModal?.addEventListener("click",e=>{ if(e.target.dataset.closeInstall!==undefined) closeInstallModal(); });
installAction?.addEventListener("click",async()=>{
  if(deferredInstallPrompt){
    try{ deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; }catch{}
    deferredInstallPrompt=null; refreshInstallButtons(); closeInstallModal();
  }else closeInstallModal();
});
window.addEventListener("load",refreshInstallButtons);

window.addEventListener("online",()=>{ updateConnection("Back online · syncing…"); syncMessages({silent:true}); });
window.addEventListener("offline",()=>updateConnection("Offline · last messages kept here"));
document.addEventListener("visibilitychange",()=>{ if(!roomId) return; if(document.visibilityState!=="hidden"){ apiPresence(true).catch(()=>{}); syncMessages({silent:true}); syncPresence(); } else { apiPresence(false).catch(()=>{}); } });
window.addEventListener("beforeunload",()=>{ apiPresence(false).catch(()=>{}); stopPolling(); stopPresence(); window.__alwaysYoursPhotoViewer?.close(); if(selectedPhotoPreviewUrl){try{URL.revokeObjectURL(selectedPhotoPreviewUrl)}catch{}} for(const url of mediaObjectUrls){try{URL.revokeObjectURL(url)}catch{}} });
