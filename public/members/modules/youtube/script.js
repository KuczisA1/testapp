/* ChemDisk – YouTube (nowy odtwarzacz) */
(function(){
  'use strict';

  const qs = (s, r=document) => r.querySelector(s);
  const fmt = (s)=>{ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,'0')}`; };
  const decodeObf = (arr)=> String.fromCharCode(...arr.map(n=> (n ^ 73)));

  const state = {
    dom:false, api:false, conf:false,
    videoId:null, key:null,
    host: 'https://www.youtube.com', // stabilniejszy host na start
    player:null,
    loaded:false,
    stallTimer:null
  };

  const el = {};

  document.addEventListener('DOMContentLoaded', () => {
    state.dom = true;
    el.shell = qs('#playerShell');
    el.player = qs('#player');
    el.overlay = qs('#overlayBtn');
    el.controls = qs('#controls');
    el.play = qs('#playPause');
    el.seek = qs('#seek');
    el.now = qs('#timeNow');
    el.dur = qs('#timeDur');
    el.mute = qs('#mute');
    el.rate = qs('#rate');
    el.fs = qs('#fs');
    el.msg = qs('#msg');

    wireUI();
    fetchConfig();
  });

  window.onYouTubeIframeAPIReady = () => { state.api = true; maybeInit(); };

  function setMsg(t){ if (el.msg) el.msg.textContent = t || ''; }

  async function fetchConfig(){
    try{
      const p = new URLSearchParams(location.search);
      const defKey = 'YT_FILM1';
      state.key = (p.get('id') || defKey).trim().toUpperCase();
      const r = await fetch(`/.netlify/functions/yt-key?id=${encodeURIComponent(state.key)}`, { credentials:'same-origin', cache:'no-store' });
      if(!r.ok){ setMsg('Błąd pobierania ID (ENV).'); return; }
      const data = await r.json();
      if(!data?.ok || !Array.isArray(data.obf)){ setMsg('Zła odpowiedź funkcji z kluczem.'); return; }
      state.videoId = decodeObf(data.obf);
      if(state.videoId.length!==11){ setMsg('ID ma nieprawidłową długość.'); return; }
      state.conf = true; maybeInit();
    }catch{ setMsg('Nie udało się pobrać konfiguracji.'); }
  }

  function maybeInit(){
    if (!state.dom || !state.api || !state.conf || state.player) return;
    state.player = new YT.Player('player', {
      width:'100%', height:'100%', videoId:'', host: state.host,
      playerVars: { controls:0, modestbranding:1, rel:0, disablekb:1, playsinline:1, iv_load_policy:3, origin: location.origin },
      events: { onReady, onStateChange, onError }
    });
  }

  function onReady(){
    try{
      state.player.setVolume(100);
      // atrybuty dla iframe
      const iframe = state.player.getIframe();
      if (iframe){
        iframe.setAttribute('allow','autoplay; fullscreen; encrypted-media; picture-in-picture');
        iframe.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
      }
      // przygotuj film
      if (state.videoId) state.player.cueVideoById({ videoId: state.videoId, startSeconds: 0, suggestedQuality: 'large' });
      setMsg('');
    }catch{}
  }

  function onStateChange(ev){
    const st = ev.data, YTS = YT.PlayerState;
    updatePlayIcon(st === YTS.PLAYING);
    if (st === YTS.PLAYING) { startTicker(); el.overlay.style.display='none'; }
    if (st === YTS.ENDED)   { setSeek(0); setNow(0); }
  }

  function onError(e){
    const code = e?.data;
    const map = { 2:'Nieprawidłowe parametry (ID).', 5:'Błąd HTML5.', 101:'Osadzanie zablokowane.', 150:'Osadzanie zablokowane.' };
    setMsg(map[code] || `Błąd odtwarzacza [${code}]`);
    // Ostatni ratunek: przełącz host i spróbuj ponownie raz
    if (!state.loaded && !state.triedFallback) tryHostFallback();
  }

  function tryHostFallback(){
    state.triedFallback = true;
    state.host = (state.host.includes('nocookie') ? 'https://www.youtube.com' : 'https://www.youtube-nocookie.com');
    if (state.player && state.player.destroy) { try{ state.player.destroy(); }catch{} }
    state.player = null; state.loaded = false;
    setMsg('Przełączam tryb…');
    maybeInit();
    const until = Date.now()+6000;
    const id = setInterval(()=>{
      if (state.player && state.player.getIframe){ clearInterval(id); safeStart(); }
      else if (Date.now()>until) clearInterval(id);
    }, 150);
  }

  function wireUI(){
    el.overlay?.addEventListener('click', safeStart);
    el.play?.addEventListener('click', toggle);
    el.seek?.addEventListener('input', ()=>{ const d=dur(); if(d>0) setNow((el.seek.value/1000)*d); });
    el.seek?.addEventListener('change', ()=>{ const d=dur(); if(d>0) state.player.seekTo((el.seek.value/1000)*d, true); });
    el.mute?.addEventListener('click', ()=>{ try{ if(state.player.isMuted()) state.player.unMute(); else state.player.mute(); }catch{} });
    el.rate?.addEventListener('change', ()=>{ try{ state.player.setPlaybackRate(parseFloat(el.rate.value)); }catch{} });
    el.fs?.addEventListener('click', async ()=>{ try{ if(!document.fullscreenElement) await el.shell.requestFullscreen(); else await document.exitFullscreen(); }catch{} });
    window.addEventListener('keydown', (e)=>{
      if (["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.code==='Space'){ e.preventDefault(); toggle(); }
      if (e.key==='ArrowRight') try{ state.player.seekTo(cur()+5,true); }catch{}
      if (e.key==='ArrowLeft')  try{ state.player.seekTo(Math.max(0,cur()-5),true); }catch{}
      if (e.key.toLowerCase()==='m') el.mute?.click();
      if (e.key.toLowerCase()==='f') el.fs?.click();
    });
  }

  function safeStart(){
    if (!state.player || !state.videoId) return;
    try{
      state.player.loadVideoById({ videoId: state.videoId, startSeconds: 0, suggestedQuality: 'large' });
      try{ state.player.mute(); state.player.playVideo(); }catch{}
      if (state.stallTimer) clearTimeout(state.stallTimer);
      state.stallTimer = setTimeout(()=>{
        try{
          if (state.player.getPlayerState() === YT.PlayerState.UNSTARTED && !state.triedFallback) {
            tryHostFallback();
          }
        }catch{}
      }, 3500);
      state.loaded = true;
      setMsg('');
    }catch{}
  }

  function toggle(){ try{ const st=state.player.getPlayerState(); (st===YT.PlayerState.PLAYING)?state.player.pauseVideo():state.player.playVideo(); }catch{} }
  function cur(){ try{ return state.player.getCurrentTime()||0; }catch{ return 0; } }
  function dur(){ try{ return state.player.getDuration()||0; }catch{ return 0; } }
  function setSeek(v){ if(el.seek) el.seek.value=String(v); }
  function setNow(t){ if(el.now) el.now.textContent = fmt(t); }
  function setDur(t){ if(el.dur) el.dur.textContent = fmt(t); }
  function updatePlayIcon(p){ if (el.play) el.play.textContent = p? '⏸' : '▶︎'; }

  function startTicker(){
    stopTicker();
    state.tick = setInterval(()=>{
      const d = dur(), t = cur();
      if(d>0){ setSeek(Math.round((t/d)*1000)); setNow(t); setDur(d); }
    }, 250);
  }
  function stopTicker(){ if (state.tick) { clearInterval(state.tick); state.tick = null; } }

  // Diagnostyka dla Ciebie
  window.__yt2_diag = () => ({ api:state.api, conf:state.conf, host:state.host, loaded:state.loaded, id:state.videoId });
})();

