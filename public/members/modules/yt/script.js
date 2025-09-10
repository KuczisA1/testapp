/* ====== ChemDisk YT Player – pełne okno, overlay click, dblclick/tap fullscreen ====== */
/* Wersja z config.json:
   - Plik ./config.json zawiera mapę kluczy -> ID filmu YouTube (11 znaków).
   - Użycie: index.html?id=id_film1 wybierze wpis "id_film1" z config.json.
*/

const qs = (s) => document.querySelector(s);
function fmtTime(s){ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; }
function maskId(id){ if(!id) return ""; return id.length<=4 ? "***" : id.slice(0,2)+"*".repeat(id.length-4)+id.slice(-2); }

window.addEventListener("contextmenu", e => e.preventDefault(), {capture:true});
window.addEventListener("keydown", e => {
  const blk = (e.ctrlKey || e.metaKey) && ["u","s","c"].includes(e.key.toLowerCase());
  if (blk) e.preventDefault();
}, {capture:true});

const state = {
  domReady:false, apiReady:false, confReady:false,
  player:null, ticker:null, dragging:false, loadedOnce:false,
  videoId:null, key:null, elements:{}, hideTimer:null, cfg:{}
};

document.addEventListener("DOMContentLoaded", () => {
  state.domReady = true;
  state.elements = {
    shell: qs("#playerShell"),
    overlay: qs("#clickOverlay"),
    controls: qs("#controls"),
    msg: qs("#msg"),
    playBtn: qs("#playPause"),
    seek: qs("#seek"),
    vol: qs("#volume"),
    muteBtn: qs("#muteToggle"),
    rateSel: qs("#rate"),
    fsBtn: qs("#fullscreen"),
    timeNow: qs("#timeNow"),
    timeDur: qs("#timeDur"),
  };
  bindUI();
  fetchConfig();
});

window.onYouTubeIframeAPIReady = () => { state.apiReady = true; maybeInit(); };

/* --- Konfiguracja z config.json --- */
async function fetchConfig(){
  try{
    const p = new URLSearchParams(location.search);
    // domyślny klucz, jeśli nie podano query param ?id=
    state.key = (p.get("id") || "id_film1").toLowerCase();

    const r = await fetch("./config.json", { cache:"no-store" });
    if (!r.ok) {
      setMsg(`Nie można odczytać config.json (${r.status}). Upewnij się, że plik istnieje obok index.html.`);
      return;
    }
    const data = await r.json();
    if (!data || typeof data !== "object") { setMsg("config.json ma nieprawidłowy format (oczekiwano obiektu)."); return; }

    state.cfg = data;
    const rawId = data[state.key];
    if (!rawId) {
      const keys = Object.keys(data);
      setMsg(keys.length
        ? `Brak klucza "${state.key}" w config.json. Dostępne: ${keys.join(", ")}`
        : `config.json nie zawiera żadnych wpisów z ID filmu.`);
      return;
    }

    state.videoId = String(rawId).trim();
    if (state.videoId.length !== 11) {
      setMsg(`Wpis "${state.key}" ma niepoprawne ID (musi mieć 11 znaków). Otrzymano długość: ${state.videoId.length}.`);
      return;
    }

    state.confReady = true;
    maybeInit();
  }catch(err){
    console.error("fetchConfig error:", err);
    setMsg("Nie udało się pobrać lub sparsować config.json.");
  }
}

const PLAYER_VARS = {
  controls:0, modestbranding:1, rel:0, fs:0, disablekb:1, playsinline:1, iv_load_policy:3, origin:location.origin
};

function maybeInit(){
  if (!state.domReady || !state.apiReady || !state.confReady || state.player) return;
  state.player = new YT.Player("player", {
    width:"100%", height:"100%", videoId:"",
    host:"https://www.youtube-nocookie.com", playerVars: PLAYER_VARS,
    events:{ onReady, onStateChange, onError }
  });
}

/* --- YT events --- */
function onReady(){
  try{
    state.player.setVolume(100);
    updateMuteIcon();
    setMsg("");
    showControls(); // pokaż na start
  }catch{}
}

function onStateChange(ev){
  const st = ev.data, YTS = YT.PlayerState;
  updatePlayIcon(st === YTS.PLAYING);

  if (st === YTS.PLAYING) {
    startTicker();
    scheduleAutoHide(); // schowaj po chwili
  } else {
    stopTicker();
    showControls(true); // przy pauzie/stopie pokaż pasek
    if (st === YTS.ENDED){ setSeek(0); setNow(0); }
  }
  const d = safeGetDuration(); if (d > 0) setDur(d);
}

function onError(e){
  const code = e?.data;
  const map = {
    2:"Błąd parametrów (ID nieprawidłowe). Sprawdź config.json.",
    5:"Błąd odtwarzacza HTML5.",
    101:"Autor wyłączył osadzanie filmu (embed disabled).",
    150:"Autor wyłączył osadzanie filmu (embed disabled)."
  };
  const extra = state.videoId ? ` (ID: ${maskId(state.videoId)})` : "";
  setMsg(map[code] ? `${map[code]}${extra}` : `Nieznany błąd [${code}]${extra}`);
  console.warn("[YT-ERROR]", code);
}

/* --- Controls & overlay logic --- */
function bindUI(){
  const {
    playBtn, seek, vol, muteBtn, rateSel, fsBtn, shell, overlay: overlayEl
  } = state.elements;

  // Auto-hide wyzwalacze
  const nudge = () => { showControls(true); scheduleAutoHide(); };
  ["mousemove","touchstart","pointermove"].forEach(evt => {
    shell?.addEventListener(evt, nudge, {passive:true});
  });

  // === Overlay gestures: click = Play/Pause, dblclick = Fullscreen, double-tap (mobile) = Fullscreen ===
  let clickTimeout = null;
  let lastTapTs = 0;

  // Pojedynczy klik -> Play/Pause (opóźnienie, by ewentualny dblclick anulował)
  overlayEl?.addEventListener("click", () => {
    if (clickTimeout) return;
    clickTimeout = setTimeout(() => {
      clickTimeout = null;
      overlaySingleClick();
    }, 220);
  });

  // Podwójny klik -> Fullscreen (anuluje pojedynczy klik)
  overlayEl?.addEventListener("dblclick", (e) => {
    if (clickTimeout) { clearTimeout(clickTimeout); clickTimeout = null; }
    e.preventDefault();
    overlayToggleFullscreen();
  });

  // Double-tap na mobile -> Fullscreen
  overlayEl?.addEventListener("touchend", () => {
    const now = Date.now();
    if (now - lastTapTs < 280) {
      if (clickTimeout) { clearTimeout(clickTimeout); clickTimeout = null; }
      overlayToggleFullscreen();
      lastTapTs = 0;
    } else {
      lastTapTs = now;
      if (clickTimeout) clearTimeout(clickTimeout);
      clickTimeout = setTimeout(() => {
        clickTimeout = null;
        overlaySingleClick();
      }, 220);
    }
  }, { passive: true });

  // Przycisk play/pause – taki sam efekt jak overlay
  playBtn?.addEventListener("click", () => startOrToggle());

  // Seek
  seek?.addEventListener("input", () => {
    if (!state.dragging) return;
    const d = safeGetDuration(); const t = (seek.value/1000)*d; setNow(t);
  });
  const startDrag = () => { state.dragging = true; showControls(true); clearAutoHide(); };
  const commitSeek = () => {
    const d = safeGetDuration();
    if (d > 0) state.player.seekTo((seek.value/1000)*d, true);
    state.dragging = false;
    scheduleAutoHide();
  };
  seek?.addEventListener("mousedown", startDrag);
  seek?.addEventListener("touchstart", startDrag, { passive:true });
  seek?.addEventListener("mouseup", commitSeek);
  seek?.addEventListener("touchend", commitSeek);
  seek?.addEventListener("change", commitSeek);

  // Volume / mute
  vol?.addEventListener("input", () => {
    try {
      state.player.setVolume(parseInt(vol.value,10));
      if (state.player.isMuted() && vol.value > 0) state.player.unMute();
      updateMuteIcon();
    } catch {}
  });
  muteBtn?.addEventListener("click", () => {
    try {
      if (state.player.isMuted() || state.player.getVolume() === 0) {
        state.player.unMute();
        if (vol && vol.value === "0") { vol.value = "50"; state.player.setVolume(50); }
      } else state.player.mute();
      updateMuteIcon();
    } catch {}
  });

  // Rate
  rateSel?.addEventListener("change", () => {
    try { state.player.setPlaybackRate(parseFloat(rateSel.value)); } catch {}
  });

  // Fullscreen
  fsBtn?.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await shell.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  });

  // Klawiatura (poza polami formularzy)
  window.addEventListener("keydown", (e) => {
    if (["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); startOrToggle(); }
    if (e.key === "ArrowRight") state.player?.seekTo(safeGetTime()+5, true);
    if (e.key === "ArrowLeft")  state.player?.seekTo(Math.max(0, safeGetTime()-5), true);
    if (e.key.toLowerCase() === "m") muteBtn?.click();
    if (e.key.toLowerCase() === "f") fsBtn?.click();
  });
}

/* --- Overlay helpers --- */
function overlaySingleClick(){
  showControls(true);
  startOrToggle();
}

async function overlayToggleFullscreen(){
  try{
    const el = state.elements.shell;
    if (!document.fullscreenElement) {
      await el.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }catch{}
  showControls(true);
  scheduleAutoHide();
}

/* --- Start or toggle playback --- */
function startOrToggle(){
  if (!state.loadedOnce) {
    if (!state.videoId) { setMsg("Brak ID – sprawdź config.json lub parametr ?id="); return; }
    try {
      state.player.loadVideoById({ videoId: state.videoId, startSeconds: 0 });
      state.loadedOnce = true;
      scheduleAutoHide();
    } catch {}
    return;
  }
  togglePlay();
}

/* --- Auto-hide helpers --- */
function showControls(force){
  const { controls } = state.elements;
  if (!controls) return;
  controls.classList.add("visible");
  if (!force) scheduleAutoHide();
}
function hideControls(){
  const { controls } = state.elements;
  if (!controls) return;
  try{
    if (state.player?.getPlayerState() === YT.PlayerState.PLAYING && !state.dragging){
      controls.classList.remove("visible");
    }
  }catch{}
}
function scheduleAutoHide(){
  clearAutoHide();
  try{
    if (state.player?.getPlayerState() !== YT.PlayerState.PLAYING) return; // przy pauzie – nie chowamy
  }catch{}
  state.hideTimer = setTimeout(hideControls, 1100);
}
function clearAutoHide(){
  if (state.hideTimer){ clearTimeout(state.hideTimer); state.hideTimer = null; }
}

/* --- ticker --- */
function startTicker(){
  stopTicker();
  state.ticker = setInterval(() => {
    const d = safeGetDuration(), t = safeGetTime();
    if (d > 0 && !state.dragging) {
      const v = Math.max(0, Math.min(1000, Math.round((t/d)*1000)));
      setSeek(v); setNow(t); setDur(d);
    }
  }, 250);
}
function stopTicker(){ if (state.ticker) { clearInterval(state.ticker); state.ticker = null; } }

/* --- UI helpers --- */
function setMsg(t){ if (state.elements.msg) state.elements.msg.textContent = t || ""; }
function setSeek(v){ state.elements.seek && (state.elements.seek.value = String(v)); }
function setNow(t){ state.elements.timeNow && (state.elements.timeNow.textContent = fmtTime(t)); }
function setDur(t){ state.elements.timeDur && (state.elements.timeDur.textContent = fmtTime(t)); }

function updatePlayIcon(playing){
  if (!state.elements.playBtn) return;
  state.elements.playBtn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" class="i"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" class="i"><path d="M8 5v14l11-7z"/></svg>';
}
function updateMuteIcon(){
  if (!state.elements.muteBtn) return;
  let muted=false; try{ muted = state.player.isMuted() || state.player.getVolume() === 0; }catch{}
  state.elements.muteBtn.innerHTML = muted
    ? '<svg viewBox="0 0 24 24" class="i"><path d="M7 9v6h4l5 5V4l-5 5H7zM19 12l3 3-1.5 1.5L17.5 13.5 14 10l1.5-1.5L19 12z"/></svg>'
    : '<svg viewBox="0 0 24 24" class="i"><path d="M7 9v6h4l5 5V4l-5 5H7z"/></svg>';
}

function togglePlay(){
  try {
    const st = state.player.getPlayerState();
    if (st === YT.PlayerState.PLAYING) { state.player.pauseVideo(); showControls(true); }
    else { state.player.playVideo(); scheduleAutoHide(); }
  } catch {}
}

function safeGetTime(){ try { return state.player.getCurrentTime() || 0; } catch { return 0; } }
function safeGetDuration(){ try { return state.player.getDuration() || 0; } catch { return 0; } }

/* Diagnostyka */
window.__yt_diag = () => ({
  ytApiLoaded: !!window.YT, domReady: state.domReady, apiReady: state.apiReady, confReady: state.confReady,
  playerReady: !!state.player, key: state.key, idLen: state.videoId ? state.videoId.length : 0, idMasked: maskId(state.videoId),
  availableKeys: Object.keys(state.cfg||{})
});