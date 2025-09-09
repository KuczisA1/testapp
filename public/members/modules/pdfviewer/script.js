// script.js — robust print/save with annotations + URL params
// Requires pdf.js 2.6.347 (cdn). Matches DOM from index.html used earlier.
(function(){
  // ===== STATE =====
  const state = {
    pdf: null, url: null, total: 0, page: 1,
    rotation: 0, scale: 1, fit: 'page', dpr: Math.max(1, devicePixelRatio||1),
    pages: new Map(), pageDims: new Map(),
    matches: [], matchIndex: -1, thumbsRendered: new Set(),
    isSidebarVisible: true, tool: 'select',
    strokeColor: '#ff5252', strokeWidth: 3, fontSize: 14, noteBgEnabled: false,
    drawing: null, version: 2, docId: null
  };
  const DEFAULT_NOTE = { w: 240, h: 120 };

  // ===== DOM =====
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const el = {
    app: $('.app') || document.documentElement,
    wrap: $('#viewerWrap'), viewer: $('#viewer'), sidebar: $('#sidebar'),
    paneThumbs: $('#paneThumbs'), paneOutline: $('#paneOutline'),
    file: $('#fileInput'), btnSidebar: $('#btnSidebar'),
    prev: $('#prevPage'), next: $('#nextPage'),
    pageNum: $('#pageNum'), pageCount: $('#pageCount'),
    zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), zoomInBig: $('#zoomInBig'), zoomOutBig: $('#zoomOutBig'), zoomLabel: $('#zoomLabel'), zoomReset: $('#zoomReset'),
    fitWidth: $('#fitWidth'), fitPage: $('#fitPage'),
    rotateL: $('#rotateL'), rotateR: $('#rotateR'),
    search: $('#searchInput'), findPrev: $('#findPrev'), findNext: $('#findNext'), findCount: $('#findCount'),
    title: $('#docTitle'),
    download: $('#download'), print: $('#print'), fullscreen: $('#fullscreen'),
    tabThumbs: $('#tabThumbs'), tabOutline: $('#tabOutline'),
    toolboxToggle: $('#toolboxToggle'), toolbox: $('#toolbox'), tbHead: $('#tbHead'), tbClose: $('#tbClose'),
    colorPicker: $('#colorPicker'), widthRange: $('#widthRange')
  };

  // ===== MOBILE DETECTION =====
  function isMobilePhone(){
    const ua = (navigator.userAgent||navigator.vendor||window.opera||'');
    const phoneUA = /Android|iPhone|iPod|Windows Phone/i.test(ua);
    const coarse = (window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches);
    const narrow = (window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
    return phoneUA || (coarse && narrow);
  }
  function applyMobileLayoutIfNeeded(){
    try{
      if(isMobilePhone()){
        document.documentElement.classList.add('is-mobile');
      } else {
        document.documentElement.classList.remove('is-mobile');
      }
    }catch(_){ }
  }
  applyMobileLayoutIfNeeded();
  window.addEventListener('resize', applyMobileLayoutIfNeeded);

  // ===== HELPERS =====
  function clamp(n,min,max){ return Math.min(max, Math.max(min, n)); }
  function fmtPct(n){ return Math.round(n*100)+'%'; }
  function setTitle(name){ document.title = name ? name + ' — Podgląd PDF' : 'Podgląd PDF'; if(el.title){ el.title.textContent = name || '—'; el.title.title = name || ''; } }
  function offsetWithin(parent, node){ let y=0, cur=node; while(cur && cur!==parent){ y+=cur.offsetTop; cur=cur.offsetParent; } return y; }
  function scrollIntoCenter(node){ const parent=el.wrap; const y=offsetWithin(parent,node); parent.scrollTo({ top: y-(parent.clientHeight/2-node.offsetHeight/2), behavior:'smooth' }); }
  function svgNS(tag){ return document.createElementNS('http://www.w3.org/2000/svg', tag); }
  function svgPoint(svg, clientX, clientY){ const pt=svg.createSVGPoint(); pt.x=clientX; pt.y=clientY; const m=svg.getScreenCTM(); if(!m) return {x:0,y:0}; const inv=m.inverse(); const p=pt.matrixTransform(inv); return {x:p.x,y:p.y}; }
  function parseTransform(t){ if(!t) return {x:0,y:0}; const m=/translate\(([-0-9.]+)[ ,]([-0-9.]+)\)/.exec(t); return m?{x:parseFloat(m[1]||'0'),y:parseFloat(m[2]||'0')}:{x:0,y:0}; }
  function overlayBaseSize(n){ const base=state.pageDims.get(n); if(!base) return {w:1,h:1}; return (state.rotation%180)===0?{w:base.w,h:base.h}:{w:base.h,h:base.w}; }

  // cursors
  const PEN_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='M3 21l3-1 11-11-2-2-11 11-1 3zM14 6l2 2' stroke='%23000' stroke-width='2' fill='none'/></svg>") 2 22, crosshair`;
  const ERASER_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><path d='M4 15l6-6 6 6-4 4H8z' fill='%23000'/></svg>") 12 20, default`;
  function applyOverlayCursor(){
    let cur='default';
    if(state.tool==='pencil'||state.tool==='brush') cur=PEN_CURSOR;
    else if(state.tool==='eraser') cur=ERASER_CURSOR;
    else if(state.tool==='laser') cur='none';
    for(const {svg} of state.pages.values()) svg.style.cursor=cur;
  }

  // ===== PAGES =====
  function ensurePageContainers(){
    if(!el.viewer) return;
    el.viewer.innerHTML=''; state.pages.clear();
    for(let i=1;i<=state.total;i++){
      const container=document.createElement('section'); container.className='page'; container.dataset.page=String(i);
      const canvas=document.createElement('canvas'); canvas.className='canvas';
      const textLayer=document.createElement('div'); textLayer.className='textLayer';
      const svg=svgNS('svg'); svg.classList.add('overlay'); svg.dataset.page=String(i); svg.setAttribute('preserveAspectRatio','none');
      container.append(canvas, textLayer, svg); el.viewer.appendChild(container);
      const ctx=canvas.getContext('2d',{alpha:false});
      bindOverlayEvents(svg, i);
      state.pages.set(i, { container, canvas, ctx, textLayer, svg, highlights: [] });
    }
    applyOverlayCursor();
  }
  async function collectPageDims(){ state.pageDims.clear(); for(let i=1;i<=state.total;i++){ const page=await state.pdf.getPage(i); const v=page.getViewport({scale:1,rotation:0}); state.pageDims.set(i,{w:v.width,h:v.height}); } }
  function layoutPages(){
    for(const [n,obj] of state.pages){
      const base=state.pageDims.get(n); if(!base) continue;
      let w=base.w,h=base.h; if((state.rotation%180)!==0){ const t=w; w=h; h=t; }
      const cssW=Math.max(1,Math.floor(w*state.scale)), cssH=Math.max(1,Math.floor(h*state.scale));
      obj.container.style.width=cssW+'px'; obj.container.style.height=cssH+'px';
      obj.canvas.style.width=cssW+'px'; obj.canvas.style.height=cssH+'px';
      obj.textLayer.style.width=cssW+'px'; obj.textLayer.style.height=cssH+'px';
      obj.svg.style.width=cssW+'px'; obj.svg.style.height=cssH+'px';
      const ov=overlayBaseSize(n); obj.svg.setAttribute('viewBox','0 0 '+ov.w+' '+ov.h);
    }
  }
  function currentViewport(page, extra){ return page.getViewport({scale:state.scale*(extra||1), rotation:state.rotation}); }
  async function renderPage(n){
    if(!state.pdf) return;
    const page=await state.pdf.getPage(n); const obj=state.pages.get(n); if(!obj) return;
    if(!state.pageDims.has(n)){ const v0=page.getViewport({scale:1,rotation:0}); state.pageDims.set(n,{w:v0.width,h:v0.height}); }
    const dpr=state.dpr; const cssV=currentViewport(page,1); const devV=currentViewport(page,dpr);
    obj.canvas.width=Math.floor(devV.width); obj.canvas.height=Math.floor(devV.height);
    obj.canvas.style.width=Math.floor(cssV.width)+'px'; obj.canvas.style.height=Math.floor(cssV.height)+'px';
    await page.render({canvasContext:obj.ctx, viewport:devV}).promise;
    await renderTextLayer(page, cssV, obj.textLayer);
    obj.container.style.width=obj.canvas.style.width; obj.container.style.height=obj.canvas.style.height;
    obj.svg.style.width=obj.canvas.style.width; obj.svg.style.height=obj.canvas.style.height;
    const ov=overlayBaseSize(n); obj.svg.setAttribute('viewBox','0 0 '+ov.w+' '+ov.h);
  }
  async function renderAllVisible(){
    if(!state.pdf) return;
    const parent=el.wrap; const parentTop=parent.scrollTop; const parentBottom=parentTop+parent.clientHeight; const margin=parent.clientHeight;
    for(const [n,{container}] of state.pages){
      const top=offsetWithin(parent,container), bottom=top+container.offsetHeight;
      if(bottom>=parentTop-margin && top<=parentBottom+margin){ await renderPage(n); }
    }
  }
  async function renderTextLayer(page, viewport, layer){
    layer.innerHTML=''; const text=await page.getTextContent(); const frag=document.createDocumentFragment(); const Util=pdfjsLib.Util;
    for(const item of text.items){
      const span=document.createElement('span'); span.textContent=item.str;
      const tx=Util.transform(viewport.transform,item.transform); const a=tx[0],b=tx[1],c=tx[2],d=tx[3],e=tx[4],f=tx[5];
      span.style.transform=`matrix(${a},${b},${c},${d},${e},${f})`; span.style.fontSize='1px'; frag.appendChild(span);
    }
    layer.appendChild(frag);
  }

  // ===== ZOOM / NAV =====
  function updateZoomLabel(){ el.zoomLabel && (el.zoomLabel.textContent=fmtPct(state.scale)); }
  async function fitWidth(){ if(!state.pdf) return; const page=await state.pdf.getPage(state.page); const v=page.getViewport({scale:1,rotation:state.rotation}); const wrapW=el.wrap.clientWidth-48; state.scale=clamp(wrapW/v.width,0.25,6); state.fit='width'; updateZoomLabel(); layoutPages(); await renderAllVisible(); }
  async function fitPage(){ if(!state.pdf) return; const page=await state.pdf.getPage(state.page); const v=page.getViewport({scale:1,rotation:state.rotation}); const wrapW=el.wrap.clientWidth-48, wrapH=el.wrap.clientHeight-48; state.scale=clamp(Math.min(wrapW/v.width,wrapH/v.height),0.25,6); state.fit='page'; updateZoomLabel(); layoutPages(); await renderAllVisible(); }
  async function setZoom(mult){ if(!state.pdf) return; state.scale=clamp(mult,0.25,6); state.fit='none'; updateZoomLabel(); layoutPages(); await renderAllVisible(); }
  async function zoom(delta){ await setZoom(state.scale*(1+delta)); }
  async function goToPage(n){ if(!state.pdf) return; const page=clamp(n,1,state.total); state.page=page; el.pageNum && (el.pageNum.value=String(page)); await renderPage(page); const container=state.pages.get(page).container; scrollIntoCenter(container); selectThumb(page); centerThumbInSidebar(page); }

  // ===== THUMBS =====
  async function buildThumbnails(){
    if(document.documentElement.classList.contains('is-mobile')) return; // skip on phones
    state.thumbsRendered.clear(); if(!el.paneThumbs) return; el.paneThumbs.innerHTML='';
    for(let i=1;i<=state.total;i++){
      const holder=document.createElement('div'); holder.className='thumb'; holder.dataset.page=String(i);
      const c=document.createElement('canvas'); const label=document.createElement('div'); label.className='label'; label.textContent=String(i);
      holder.append(c,label); el.paneThumbs.appendChild(holder); holder.addEventListener('click',()=>goToPage(i));
    }
    const obs=new IntersectionObserver(entries=>{ for(const e of entries){ if(e.isIntersecting){ const holder=e.target; obs.unobserve(holder); const p=parseInt(holder.dataset.page,10); const canv=holder.querySelector('canvas'); renderThumb(p,canv); } } },{root:el.sidebar, rootMargin:'200px'});
    $$('#paneThumbs .thumb').forEach(n=>obs.observe(n)); selectThumb(1);
  }
  async function renderThumb(i, canvas){
    if(state.thumbsRendered.has(i)||!state.pdf) return;
    const page=await state.pdf.getPage(i); const v=page.getViewport({scale:0.2,rotation:state.rotation}); const dpr=Math.max(1,window.devicePixelRatio||1);
    canvas.width=Math.floor(v.width*dpr); canvas.height=Math.floor(v.height*dpr); canvas.style.width='100%'; canvas.style.height='auto';
    const ctx=canvas.getContext('2d',{alpha:false}); await page.render({canvasContext:ctx, viewport:v, transform:[dpr,0,0,dpr,0,0]}).promise;
    state.thumbsRendered.add(i);
  }
  function selectThumb(n){ $$('#paneThumbs .thumb').forEach(t=>t.classList.toggle('selected', parseInt(t.dataset.page,10)===n)); }
  function centerThumbInSidebar(n){
    if(!el.sidebar) return; const item=el.paneThumbs?.querySelector(`.thumb[data-page="${n}"]`); if(!item) return;
    const sb=el.sidebar; const itemTop=item.offsetTop; const itemBottom=itemTop+item.offsetHeight; const sbTop=sb.scrollTop; const sbBottom=sbTop+sb.clientHeight;
    if(itemTop<sbTop+16) sb.scrollTo({top:Math.max(0,itemTop-16),behavior:'smooth'});
    else if(itemBottom>sbBottom-16) sb.scrollTo({top:itemBottom-sb.clientHeight+16,behavior:'smooth'});
  }

  // ===== OUTLINE =====
  async function buildOutline(){
    if(!el.paneOutline) return; el.paneOutline.innerHTML='';
    if(!state.pdf){ el.paneOutline.innerHTML='<div style="opacity:.7">Brak spisu treści.</div>'; return; }
    const outline=await state.pdf.getOutline();
    if(!outline||!outline.length){ el.paneOutline.innerHTML='<div style="opacity:.7">Brak spisu treści.</div>'; return; }
    const ul=document.createElement('ul'); ul.className='outline';
    async function openDest(dest){ try{ const res=await state.pdf.getDestination(dest); const idx=res?res[0]:0; await goToPage((idx|0)+1);}catch(_){ } }
    function add(items,parent){ for(const it of items){ const li=document.createElement('li'); const a=document.createElement('a'); a.href='#'; a.textContent=it.title||'(bez tytułu)'; a.addEventListener('click',(e)=>{e.preventDefault(); if(it.dest) openDest(it.dest); else if(typeof it.pageIndex==='number') goToPage(it.pageIndex+1);}); li.appendChild(a); parent.appendChild(li); if(it.items&&it.items.length){ const ul2=document.createElement('ul'); ul2.className='outline'; add(it.items,ul2); li.appendChild(ul2);} } }
    add(outline, ul); el.paneOutline.appendChild(ul);
  }

  // ===== SEARCH =====
  function clearHighlights(){ for(const {highlights} of state.pages.values()){ highlights.forEach(h=>h.remove()); highlights.length=0; } state.matches=[]; state.matchIndex=-1; updateFindLabel(); }
  function updateFindLabel(){ if(!el.findCount) return; const total=state.matches.length; const idx=state.matchIndex>=0?(state.matchIndex+1):0; el.findCount.textContent=idx+'/'+total; }
  async function search(term){
    if(!state.pdf) return; clearHighlights(); if(!term) return; const q=term.toLowerCase();
    for(let i=1;i<=state.total;i++){
      const page=await state.pdf.getPage(i); const text=await page.getTextContent(); const viewport=currentViewport(page,1); const Util=pdfjsLib.Util;
      for(const item of text.items){
        const s=item.str, lower=s.toLowerCase(); let from=0,found;
        while((found=lower.indexOf(q,from))!==-1){
          const tx=Util.transform(viewport.transform,item.transform); const a=tx[0],b=tx[1],c=tx[2],d=tx[3],e=tx[4],f=tx[5];
          const widthPx=Math.hypot(a,b); const itemWidth=(item.width||(s.length*widthPx))*widthPx; const charW=itemWidth/Math.max(1,s.length);
          const x=e + charW*found; const h=Math.hypot(c,d)||Math.abs(d)||8; const w=charW*q.length;
          const hl=document.createElement('div'); hl.className='hl'; hl.style.left=x+'px'; hl.style.top=(f-h)+'px'; hl.style.width=Math.max(2,w)+'px'; hl.style.height=Math.max(8,h)+'px';
          state.pages.get(i).container.appendChild(hl); state.pages.get(i).highlights.push(hl); state.matches.push({page:i, el:hl});
          from = found + q.length;
        }
      }
    }
    if(state.matches.length){ state.matchIndex=0; state.matches[0].el.classList.add('active'); await goToPage(state.matches[0].page); state.matches[0].el.scrollIntoView({block:'center',behavior:'smooth'}); }
    updateFindLabel();
  }
  function findNext(dir){ const total=state.matches.length; if(!total) return; state.matches[state.matchIndex]?.el.classList.remove('active'); state.matchIndex=(state.matchIndex+(dir>0?1:-1)+total)%total; const hit=state.matches[state.matchIndex]; hit.el.classList.add('active'); goToPage(hit.page).then(()=> hit.el.scrollIntoView({block:'center',behavior:'smooth'})); updateFindLabel(); }

  // ===== PARAM CONFIG (no JSON) =====
  function coerceVersion(v){ if(v==null) return 1; if(typeof v==='number'){ return v===2?2:1; } if(typeof v==='string'){ const s=v.trim().toLowerCase(); return (s==='2'||s==='v2')?2:1; } return 1; }
  async function tryLoadFromParams(){
    const qs = new URLSearchParams(location.search);
    const path = qs.get('path');
    const title = qs.get('title');
    if(path){
      await openPDF(path, title || path.split('/').pop());
      const ann = qs.get('ann');
      if(ann){ try{ const r=await fetch(ann,{cache:'no-store'}); if(r.ok){ const data=await r.json(); restoreAnnotationsFromObject(data,true); } }catch(_){ } }
      return true;
    }
    return false;
  }
  async function tryLoadFallbackConfig(){
    try{
      const res = await fetch('file_path.json', {cache:'no-store'});
      if(!res.ok) return false;
      const cfg = await res.json();
      if(cfg?.path){ await openPDF(cfg.path, cfg.title || cfg.path.split('/').pop()); if(cfg.annotationsUrl){ try{ const r=await fetch(cfg.annotationsUrl,{cache:'no-store'}); if(r.ok){ restoreAnnotationsFromObject(await r.json(), true); } }catch(_){ } } return true; }
    }catch(_){}
    setTitle('— otwórz plik PDF —');
    return false;
  }

  // ===== VERSION SOURCE (version.json) =====
  async function loadVersionFromJson(){
    try{
      const res = await fetch('version.json', {cache:'no-store'});
      if(res.ok){ const v = (await res.json())?.version; state.version = coerceVersion(v); }
    }catch(_){ /* keep default */ }
  }

  // ===== OPEN PDF =====
  async function openPDF(input, titleHint){
    let task;
    if(input instanceof ArrayBuffer){ const blob=new Blob([input],{type:'application/pdf'}); state.url=URL.createObjectURL(blob); task=pdfjsLib.getDocument({data:input}); setTitle(titleHint||'Dokument PDF'); }
    else if(typeof input==='string'){ state.url=input; task=pdfjsLib.getDocument({url:input}); setTitle(titleHint||(input.split('/').pop()||'Dokument PDF')); }
    else throw new Error('Unsupported input');

    state.pdf = await task.promise; state.docId = state.pdf.fingerprint || state.url || ('doc-'+Date.now()); state.total = state.pdf.numPages;
    el.pageCount && (el.pageCount.textContent='/ '+state.total); el.pageNum && (el.pageNum.max=String(state.total));

    await collectPageDims(); ensurePageContainers(); await fitPage(); layoutPages(); await buildThumbnails(); await buildOutline(); await goToPage(1);

    try{ const raw=localStorage.getItem(storageKey()); if(raw){ restoreAnnotationsFromObject(JSON.parse(raw), true); } }catch(_){ }
  }

  // ===== TOOLS =====
  function activateTool(name){ state.tool=name; $$('#toolbox .tool-btn').forEach(b=>b.classList.toggle('active', b.dataset.tool===name)); applyOverlayCursor(); }
  function bindToolButtons(){
    const palette=['#ef4444','#f97316','#f59e0b','#eab308','#84cc16','#22c55e','#10b981','#06b6d4','#0ea5e9','#3b82f6','#6366f1','#8b5cf6','#a855f7','#d946ef','#ec4899','#f43f5e','#ffffff','#000000','#6b7280','#111827'];
    const colorRow=el.colorPicker?.closest('.tb-controls');
    if(colorRow){
      colorRow.querySelectorAll('.color-swatch').forEach(n=>n.remove());
      palette.forEach(col=>{ const sw=document.createElement('div'); sw.className='color-swatch'; sw.style.background=col; sw.title=col; sw.addEventListener('click',()=>{ if(el.colorPicker) el.colorPicker.value=col; state.strokeColor=col; applyFontColorIfNoteSelected(); scheduleSaveDebounced(); }); colorRow.appendChild(sw); });
    }
    if(el.widthRange){ el.widthRange.min='1'; el.widthRange.max='12'; el.widthRange.step='1'; el.widthRange.value=String(clamp(state.strokeWidth,1,12)); el.widthRange.addEventListener('input',()=>{ state.strokeWidth=clamp(parseInt(el.widthRange.value||'3',10),1,12); }); }

    // font size
    const row = colorRow;
    const label=document.createElement('label'); label.style.display='inline-flex'; label.style.alignItems='center'; label.style.gap='6px'; label.style.marginLeft='8px'; label.textContent='Czcionka';
    const input=document.createElement('input'); input.type='number'; input.min='8'; input.max='72'; input.step='1'; input.value=String(state.fontSize); input.style.width='64px';
    input.addEventListener('input',()=>{ state.fontSize=clamp(parseInt(input.value||'14',10),8,72); const sel=document.querySelector('.overlay .shape.selected'); if(sel?.dataset.type==='note'){ const div=sel.querySelector('foreignObject>div'); if(div){ div.style.fontSize=state.fontSize+'px'; scheduleSaveDebounced(); } } });
    row && row.append(label,input);

    // background toggle
    const bgWrap=document.createElement('label'); bgWrap.style.display='inline-flex'; bgWrap.style.alignItems='center'; bgWrap.style.gap='6px'; bgWrap.style.marginLeft='8px';
    const bg=document.createElement('input'); bg.type='checkbox'; bg.addEventListener('change',()=>{ state.noteBgEnabled=!!bg.checked; const sel=document.querySelector('.overlay .shape.selected'); if(sel?.dataset.type==='note'){ setNoteBackground(sel, state.noteBgEnabled); scheduleSaveDebounced(); } }); bgWrap.append('Tło', bg); row && row.appendChild(bgWrap);

    // extra ops
    const tbBody=el.toolbox?.querySelector('.tb-body');
    if(tbBody){
      const lab=document.createElement('div'); lab.className='tb-label'; lab.textContent='Widoczność i operacje';
      const ops=document.createElement('div'); ops.className='tb-controls';
      const btnToggle=document.createElement('button'); btnToggle.className='tool-btn'; btnToggle.textContent='👁 Ukryj adnotacje'; let hid=false;
      btnToggle.addEventListener('click',()=>{ hid=!hid; for(const {svg} of state.pages.values()){ svg.style.display=hid?'none':'block'; } btnToggle.textContent=hid?'👁 Pokaż adnotacje':'👁 Ukryj adnotacje'; });
      const btnClearPage=document.createElement('button'); btnClearPage.className='tool-btn'; btnClearPage.textContent='Wyczyść adnotacje ze strony'; btnClearPage.addEventListener('click',()=>{ clearPage(); scheduleSave(true); });
      const btnClearAll=document.createElement('button'); btnClearAll.className='tool-btn'; btnClearAll.textContent='Wyczyść wszystkie adnotacje'; btnClearAll.addEventListener('click',()=>{ clearAll(); scheduleSave(true); });
      const btnFront=document.createElement('button'); btnFront.className='tool-btn'; btnFront.textContent='Na wierzch'; btnFront.addEventListener('click',()=>{ bringToFront(); scheduleSaveDebounced(); });
      const btnBack=document.createElement('button'); btnBack.className='tool-btn'; btnBack.textContent='Na spód'; btnBack.addEventListener('click',()=>{ sendToBack(); scheduleSaveDebounced(); });
      ops.append(btnToggle, btnClearPage, btnClearAll, btnFront, btnBack);
      tbBody.append(lab, ops);

      const lab2=document.createElement('div'); lab2.className='tb-label'; lab2.textContent='Import / Eksport adnotacji';
      const row2=document.createElement('div'); row2.className='tb-controls';
      const btnExp=document.createElement('button'); btnExp.className='tool-btn'; btnExp.textContent='Eksportuj (JSON)';
      btnExp.addEventListener('click',()=>{ const blob=new Blob([JSON.stringify(serializeAnnotations(),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); const base=(el.title?.textContent||'annotations').replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_'); a.download=base+'.annotations.json'; document.body.appendChild(a); a.click(); a.remove(); });
      const btnImp=document.createElement('button'); btnImp.className='tool-btn'; btnImp.textContent='Importuj (JSON)';
      const fi=document.createElement('input'); fi.type='file'; fi.accept='.json,application/json'; fi.style.display='none';
      btnImp.addEventListener('click',()=>fi.click());
      fi.addEventListener('change',async()=>{ const f=fi.files&&fi.files[0]; if(!f) return; try{ const txt=await f.text(); const obj=JSON.parse(txt); restoreAnnotationsFromObject(obj,true); scheduleSave(true); }catch(e){ alert('Nie udało się wczytać adnotacji: '+e); } fi.value=''; });
      row2.append(btnExp, btnImp, fi);
      tbBody.append(lab2, row2);
    }

    $$('#toolbox .tool-btn').forEach(b=> b.addEventListener('click', ()=> activateTool(b.dataset.tool || state.tool)));
    activateTool('select');
    el.colorPicker?.addEventListener('input',()=>{ state.strokeColor = el.colorPicker.value; applyFontColorIfNoteSelected(); scheduleSaveDebounced(); });
    el.tbClose?.addEventListener('click',()=> el.toolbox?.classList.remove('open'));
  }
  function setNoteBackground(g,on){ const rect=g.querySelector('rect'); if(rect) rect.setAttribute('fill', on?'rgba(255,255,255,.9)':'transparent'); }
  function applyFontColorIfNoteSelected(){ const sel=document.querySelector('.overlay .shape.selected'); if(sel&&sel.dataset.type==='note'){ const div=sel.querySelector('foreignObject>div'); if(div) div.style.color=state.strokeColor; const rect=sel.querySelector('rect'); rect?.setAttribute('stroke',state.strokeColor); } }

  // ===== OVERLAY EVENTS =====
  function bindOverlayEvents(svg, page){
    let draggingSel=null;
    svg.addEventListener('pointerdown',(e)=>{
      const tool=state.tool; const pt=svgPoint(svg,e.clientX,e.clientY); const target=e.target;
      if(tool==='eraser'){ const sh=target.closest && target.closest('.shape'); if(sh){ sh.remove(); scheduleSaveDebounced(); } svg.setPointerCapture(e.pointerId); return; }
      if(tool==='laser'){ spawnLaserDot(e.clientX,e.clientY); svg.setPointerCapture(e.pointerId); return; }
      if(tool==='note'){
        const g=svgNS('g'); g.classList.add('shape'); g.dataset.page=String(page); g.dataset.type='note'; g.dataset.ready='0';
        const rect=svgNS('rect'); rect.setAttribute('rx','6'); rect.setAttribute('ry','6'); rect.setAttribute('fill',state.noteBgEnabled?'rgba(255,255,255,.9)':'transparent'); rect.setAttribute('stroke',state.strokeColor); rect.setAttribute('stroke-width','1.5'); rect.style.cursor='move';
        const fo=svgNS('foreignObject'); const div=document.createElement('div'); div.className='note-box'; div.contentEditable='true'; div.innerText='Notatka…'; div.style.fontSize=state.fontSize+'px'; div.style.color=state.strokeColor; div.style.background='transparent'; div.style.outline='none';
        div.addEventListener('focus',()=>{ if(div.innerText.trim()==='Notatka…') div.innerText=''; });
        div.addEventListener('blur',()=>{ if(div.innerText.trim()===''){ div.innerText='Notatka…'; div.style.opacity='.7'; } else { div.style.opacity='1'; } scheduleSaveDebounced(); });
        div.addEventListener('input',()=>{ div.style.opacity='1'; scheduleSaveDebounced(); });
        fo.appendChild(div);
        const handle=svgNS('rect'); handle.setAttribute('data-role','resize-handle'); handle.setAttribute('width','10'); handle.setAttribute('height','10'); handle.setAttribute('fill','#7aa2f7'); handle.setAttribute('rx','2'); handle.setAttribute('ry','2'); handle.style.cursor='nwse-resize'; handle.style.display='none';
        g.append(rect, fo, handle); svg.appendChild(g);
        setNoteBox(g, pt.x, pt.y, DEFAULT_NOTE.w, DEFAULT_NOTE.h);
        attachNoteInteractions(g);
        selectOnly(g, { showHandle:false });
        requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ g.dataset.ready='1'; if(g.classList.contains('selected')){ const h=g.querySelector('[data-role="resize-handle"]'); if(h) h.style.display='block'; } }); });
        scheduleSaveDebounced();
        activateTool('select');
        return;
      }
      if(tool==='select'){ const sh=target.closest && target.closest('.shape'); if(sh && sh.dataset.type==='path'){ selectOnly(sh); const t0=parseTransform(sh.getAttribute('transform')); const p0=svgPoint(svg,e.clientX,e.clientY); draggingSel={el:sh,startPt:p0,t0}; svg.setPointerCapture(e.pointerId);} else if(sh){ selectOnly(sh); } else { clearSelection(); } return; }
      if(tool==='pencil'||tool==='brush'){
        const path=svgNS('path'); path.setAttribute('fill','none'); path.setAttribute('stroke',state.strokeColor); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round'); path.setAttribute('stroke-width', String(tool==='brush'?clamp(Math.round(state.strokeWidth*1.6),2,24):state.strokeWidth)); path.classList.add('shape'); path.dataset.page=String(page); path.dataset.type='path'; path.setAttribute('d',`M ${pt.x} ${pt.y}`); svg.appendChild(path);
        state.drawing={page,svg,pathEl:path,points:[pt.x,pt.y]}; svg.setPointerCapture(e.pointerId); return;
      }
    });
    svg.addEventListener('pointermove',(e)=>{
      const tool=state.tool;
      if(tool==='laser'){ if(e.buttons || e.pressure>0) spawnLaserDot(e.clientX,e.clientY); return; }
      if(tool==='eraser'){ if(e.buttons){ const elAt=document.elementFromPoint(e.clientX,e.clientY); const sh=elAt && elAt.closest ? elAt.closest('.shape') : null; if(sh){ sh.remove(); scheduleSaveDebounced(); } } return; }
      if(state.drawing){ const {svg,pathEl,points}=state.drawing; const p=svgPoint(svg,e.clientX,e.clientY); points.push(p.x,p.y); pathEl.setAttribute('d',buildPathD(points)); return; }
      if(draggingSel){ const p=svgPoint(svg,e.clientX,e.clientY); const dx=p.x-draggingSel.startPt.x; const dy=p.y-draggingSel.startPt.y; const nx=(draggingSel.t0.x||0)+dx; const ny=(draggingSel.t0.y||0)+dy; draggingSel.el.setAttribute('transform',`translate(${nx}, ${ny})`); return; }
    });
    svg.addEventListener('pointerup',(e)=>{ if(state.drawing) scheduleSaveDebounced(); if(draggingSel) scheduleSaveDebounced(); state.drawing=null; draggingSel=null; try{ svg.releasePointerCapture(e.pointerId);}catch(_){ } });
  }
  function noteRect(g){ return g.querySelector('rect'); }
  function noteFO(g){ return g.querySelector('foreignObject'); }
  function noteDiv(g){ return g.querySelector('foreignObject > div'); }
  function getNoteBox(g){ const r=noteRect(g); const t=parseTransform(g.getAttribute('transform')); const x=parseFloat(r.getAttribute('x')||'0')+(t.x||0); const y=parseFloat(r.getAttribute('y')||'0')+(t.y||0); const w=parseFloat(r.getAttribute('width')||'0'); const h=parseFloat(r.getAttribute('height')||'0'); return {x,y,w,h}; }
  function setNoteBox(g, x,y,w,h){ const r=noteRect(g), fo=noteFO(g); r.setAttribute('x',String(x)); r.setAttribute('y',String(y)); if(w!=null) r.setAttribute('width',String(w)); if(h!=null) r.setAttribute('height',String(h)); const W=parseFloat(r.getAttribute('width')), H=parseFloat(r.getAttribute('height')); fo.setAttribute('x',String(x+6)); fo.setAttribute('y',String(y+6)); fo.setAttribute('width',String(Math.max(1,(w!=null?w:W)-12))); fo.setAttribute('height',String(Math.max(1,(h!=null?h:H)-12))); g.removeAttribute('transform'); const handle=g.querySelector('[data-role="resize-handle"]'); if(handle){ handle.setAttribute('x',String(x+(w!=null?w:W)-8)); handle.setAttribute('y',String(y+(h!=null?h:H)-8)); } }
  function attachNoteInteractions(g){
    const svg=g.ownerSVGElement, rect=noteRect(g), fo=noteFO(g), div=noteDiv(g), handle=g.querySelector('[data-role="resize-handle"]');
    g.addEventListener('click',()=>{ if(state.tool==='select') selectOnly(g); });
    g.addEventListener('dblclick',(e)=>{ if(state.tool!=='select') return; e.stopPropagation(); div && div.focus(); });
    let dragging=false, p0=null, box0=null;
    rect.addEventListener('pointerdown',(e)=>{ if(state.tool!=='select') return; e.stopPropagation(); dragging=true; p0=svgPoint(svg,e.clientX,e.clientY); box0=getNoteBox(g); rect.setPointerCapture(e.pointerId); });
    rect.addEventListener('pointermove',(e)=>{ if(!dragging) return; const p=svgPoint(svg,e.clientX,e.clientY); setNoteBox(g, box0.x+(p.x-p0.x), box0.y+(p.y-p0.y), box0.w, box0.h); });
    rect.addEventListener('pointerup',(e)=>{ dragging=false; scheduleSaveDebounced(); try{ rect.releasePointerCapture(e.pointerId);}catch(_){ }});
    let resizing=false, s0=null, geom0=null;
    if(handle){
      handle.addEventListener('pointerdown',(e)=>{ if(state.tool!=='select') return; e.stopPropagation(); resizing=true; s0=svgPoint(svg,e.clientX,e.clientY); geom0=getNoteBox(g); handle.setPointerCapture(e.pointerId); });
      handle.addEventListener('pointermove',(e)=>{ if(!resizing) return; const p=svgPoint(svg,e.clientX,e.clientY); const w=Math.max(40, geom0.w+(p.x-s0.x)); const h=Math.max(30, geom0.h+(p.y-s0.y)); setNoteBox(g, geom0.x, geom0.y, w, h); });
      handle.addEventListener('pointerup',(e)=>{ resizing=false; scheduleSaveDebounced(); try{ handle.releasePointerCapture(e.pointerId);}catch(_){ }});
    }
    if(div){ div.addEventListener('focus',()=>{ if(div.innerText.trim()==='Notatka…') div.innerText=''; }); div.addEventListener('blur',()=>{ if(div.innerText.trim()===''){ div.innerText='Notatka…'; div.style.opacity='.7'; } else { div.style.opacity='1'; } scheduleSaveDebounced(); }); div.addEventListener('input',()=>{ div.style.opacity='1'; scheduleSaveDebounced(); }); }
  }
  function buildPathD(points){ if(points.length<=2) return `M ${points[0]} ${points[1]}`; let d=`M ${points[0]} ${points[1]}`; for(let i=2;i<points.length;i+=2){ d+=` L ${points[i]} ${points[i+1]}`; } return d; }
  function selectOnly(el,opts={}){ clearSelection(); el.classList.add('selected'); if(el.dataset.type==='note'){ const h=el.querySelector('[data-role="resize-handle"]'); if(h){ const show = opts.showHandle!==false && el.dataset.ready!=='0'; h.style.display = show ? 'block' : 'none'; } } }
  function clearSelection(){ $$('.overlay .shape.selected').forEach(s=>{ s.classList.remove('selected'); const h=s.querySelector('[data-role="resize-handle"]'); if(h) h.style.display='none'; }); }

  // ===== STORAGE =====
  function storageKey(){ return state.docId ? `annot:${state.docId}` : null; }
  function serializeAnnotations(){
    const data={version:2, pages:{}};
    for(const [n,{svg}] of state.pages){
      const arr=[];
      svg.querySelectorAll('.shape').forEach(sh=>{
        const type=sh.dataset.type;
        if(type==='note'){ const box=getNoteBox(sh); const rect=noteRect(sh); const div=noteDiv(sh); arr.push({type:'note', x:box.x,y:box.y,w:box.w,h:box.h, stroke:rect.getAttribute('stroke')||'#000', bg:(rect.getAttribute('fill')||'transparent')!=='transparent', fontSize:div?parseFloat((div.style.fontSize||'14px')):14, color:div?(div.style.color||'#000'):'#000', text:div?div.innerText:''}); }
        else if(type==='path'){ const t=parseTransform(sh.getAttribute('transform')); arr.push({type:'path', d:sh.getAttribute('d')||'', stroke:sh.getAttribute('stroke')||'#000', strokeWidth:parseFloat(sh.getAttribute('stroke-width')||'1'), tx:t.x||0, ty:t.y||0}); }
      }); data.pages[n]=arr;
    }
    return data;
  }
  function restoreAnnotationsFromObject(data, clearFirst=false){
    if(!data||!data.pages) return;
    for(const [nStr,arr] of Object.entries(data.pages)){
      const n=parseInt(nStr,10); const svg=state.pages.get(n)?.svg; if(!svg) continue;
      if(clearFirst) svg.querySelectorAll('.shape').forEach(x=>x.remove());
      arr.forEach(item=>{
        if(item.type==='note'){ const g=svgNS('g'); g.classList.add('shape'); g.dataset.page=String(n); g.dataset.type='note'; g.dataset.ready='1'; const rect=svgNS('rect'); rect.setAttribute('rx','6'); rect.setAttribute('ry','6'); rect.setAttribute('stroke',item.stroke||'#000'); rect.setAttribute('stroke-width','1.5'); rect.setAttribute('fill',item.bg?'rgba(255,255,255,0.9)':'transparent'); rect.setAttribute('x',String(item.x||0)); rect.setAttribute('y',String(item.y||0)); rect.setAttribute('width',String(Math.max(40,item.w||DEFAULT_NOTE.w))); rect.setAttribute('height',String(Math.max(30,item.h||DEFAULT_NOTE.h))); const fo=svgNS('foreignObject'); fo.setAttribute('x',String((item.x||0)+6)); fo.setAttribute('y',String((item.y||0)+6)); fo.setAttribute('width',String(Math.max(1,(item.w||DEFAULT_NOTE.w)-12))); fo.setAttribute('height',String(Math.max(1,(item.h||DEFAULT_NOTE.h)-12))); const div=document.createElement('div'); div.className='note-box'; div.contentEditable='true'; div.innerText=(item.text&&item.text.length)?item.text:'Notatka…'; div.style.fontSize=(item.fontSize||14)+'px'; div.style.color=item.color||item.stroke||'#000'; div.style.background='transparent'; div.style.outline='none'; div.addEventListener('focus',()=>{ if(div.innerText.trim()==='Notatka…') div.innerText=''; }); div.addEventListener('blur',()=>{ if(div.innerText.trim()===''){ div.innerText='Notatka…'; div.style.opacity='.7'; } else { div.style.opacity='1'; } scheduleSaveDebounced(); }); div.addEventListener('input',()=>{ div.style.opacity='1'; scheduleSaveDebounced(); }); fo.appendChild(div); const handle=svgNS('rect'); handle.setAttribute('data-role','resize-handle'); handle.setAttribute('width','10'); handle.setAttribute('height','10'); handle.setAttribute('fill','#7aa2f7'); handle.setAttribute('rx','2'); handle.setAttribute('ry','2'); handle.style.cursor='nwse-resize'; handle.style.display='block'; g.append(rect, fo, handle); svg.appendChild(g); attachNoteInteractions(g); }
        else if(item.type==='path'){ const path=svgNS('path'); path.classList.add('shape'); path.dataset.page=String(n); path.dataset.type='path'; path.setAttribute('fill','none'); path.setAttribute('stroke',item.stroke||'#000'); path.setAttribute('stroke-width',String(item.strokeWidth||1)); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round'); path.setAttribute('d',item.d||''); const tx=item.tx||0,ty=item.ty||0; if(tx||ty) path.setAttribute('transform',`translate(${tx}, ${ty})`); svg.appendChild(path); }
      });
    }
  }
  function restoreAnnotations(){ const key=storageKey(); if(!key) return; try{ const raw=localStorage.getItem(key); if(raw){ restoreAnnotationsFromObject(JSON.parse(raw), true); } }catch(_){ } }
  function scheduleSave(immediate=false){ if(immediate){ doSave(); return; } clearTimeout(scheduleSave._t); scheduleSave._t=setTimeout(doSave,250); }
  function scheduleSaveDebounced(){ scheduleSave(false); }
  function doSave(){ const key=storageKey(); if(!key) return; try{ localStorage.setItem(key, JSON.stringify(serializeAnnotations())); }catch(_){ } }

  function allShapesIn(svg){ return svg.querySelectorAll('.shape'); }
  function clearPage(){ const p=state.page; const o=state.pages.get(p); if(!o) return; o.svg.querySelectorAll('.shape').forEach(n=>n.remove()); o.highlights.forEach(h=>h.remove()); o.highlights.length=0; }
  function clearAll(){ for(const {svg,highlights} of state.pages.values()){ svg.querySelectorAll('.shape').forEach(n=>n.remove()); highlights.forEach(h=>h.remove()); highlights.length=0; } }
  function bringToFront(){ const sel=document.querySelector('.overlay .shape.selected'); if(sel){ sel.parentNode.appendChild(sel); scheduleSaveDebounced(); } }
  function sendToBack(){ const sel=document.querySelector('.overlay .shape.selected'); if(sel){ const p=sel.parentNode; p.insertBefore(sel, p.firstChild); scheduleSaveDebounced(); } }

  // ===== LASER =====
  (function ensureLaserCSS(){ if(document.getElementById('laser-kf')) return; const st=document.createElement('style'); st.id='laser-kf'; st.textContent=`@keyframes laserDot{0%{transform:scale(.6);opacity:0}20%{opacity:.6}100%{transform:scale(1.2);opacity:0}}@keyframes laserRing{0%{transform:scale(.2);opacity:.35}100%{transform:scale(1.8);opacity:0}}`; document.head.appendChild(st); })();
  function spawnLaserDot(clientX, clientY){
    const dot=document.createElement('div'); dot.style.position='fixed'; dot.style.left=clientX+'px'; dot.style.top=clientY+'px'; dot.style.width='10px'; dot.style.height='10px'; dot.style.margin='-5px 0 0 -5px'; dot.style.borderRadius='50%'; dot.style.background='rgba(239,68,68,.85)'; dot.style.boxShadow='0 0 14px rgba(239,68,68,.6)'; dot.style.pointerEvents='none'; dot.style.animation='laserDot 700ms ease-out forwards';
    const ring=document.createElement('div'); ring.style.position='fixed'; ring.style.left=clientX+'px'; ring.style.top=clientY+'px'; ring.style.width='16px'; ring.style.height='16px'; ring.style.margin='-8px 0 0 -8px'; ring.style.borderRadius='50%'; ring.style.border='2px solid rgba(239,68,68,.5)'; ring.style.pointerEvents='none'; ring.style.animation='laserRing 800ms ease-out forwards';
    document.body.append(dot, ring); setTimeout(()=>{ dot.remove(); ring.remove(); }, 900);
  }

  // ===== FULLSCREEN =====
  function isFS(){ return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement; }
  async function enterFS(){ const r=el.app; try{ if(r.requestFullscreen) await r.requestFullscreen(); else if(r.webkitRequestFullscreen) await r.webkitRequestFullscreen(); else if(r.msRequestFullscreen) await r.msRequestFullscreen(); }catch(_){ } }
  async function exitFS(){ try{ if(document.exitFullscreen) await document.exitFullscreen(); else if(document.webkitExitFullscreen) await document.webkitExitFullscreen(); else if(document.msExitFullscreen) await document.msExitFullscreen(); }catch(_){ } }
  function onFSChange(){ const active=!!isFS(); if(el.fullscreen){ el.fullscreen.classList.toggle('active',active); el.fullscreen.title = active ? 'Wyjdź z pełnego ekranu (F)' : 'Pełny ekran (F)'; } }
  ['fullscreenchange','webkitfullscreenchange','msfullscreenchange'].forEach(ev=>document.addEventListener(ev,onFSChange));
  (function rewireFS(){ if(!el.fullscreen) return; const old=el.fullscreen; const clone=old.cloneNode(true); old.parentNode.replaceChild(clone,old); el.fullscreen=clone; clone.addEventListener('click',()=>{ isFS()?exitFS():enterFS(); }); })();

  // ===== PRINT & SAVE (robust) =====
  async function ensureAllRendered(){ if(!state.pdf) return; for(let i=1;i<=state.total;i++){ await renderPage(i); } }
  function drawOverlayOntoCanvas(ctx, pageNum){
    const { svg } = state.pages.get(pageNum); if(!svg) return;
    const ov=overlayBaseSize(pageNum); const sx=ctx.canvas.width/ov.w; const sy=ctx.canvas.height/ov.h;
    ctx.save(); ctx.scale(sx, sy);
    svg.querySelectorAll('.shape').forEach(sh=>{
      const type=sh.dataset.type;
      if(type==='path'){
        const d=sh.getAttribute('d')||''; if(!d) return;
        const p2=new Path2D(d); const stroke=sh.getAttribute('stroke')||'#000'; const w=parseFloat(sh.getAttribute('stroke-width')||'1');
        const t=parseTransform(sh.getAttribute('transform'));
        ctx.save(); if((t.x||0)!==0 || (t.y||0)!==0) ctx.translate(t.x||0, t.y||0);
        ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle=stroke; ctx.lineWidth=w; ctx.stroke(p2); ctx.restore();
      } else if(type==='note'){
        const r=sh.querySelector('rect'); const div=sh.querySelector('foreignObject > div'); if(!r) return;
        const x=parseFloat(r.getAttribute('x')||'0'), y=parseFloat(r.getAttribute('y')||'0');
        const w=parseFloat(r.getAttribute('width')||'0'), h=parseFloat(r.getAttribute('height')||'0');
        const stroke=r.getAttribute('stroke')||'#000'; const bg=r.getAttribute('fill')||'transparent';
        const fontSize = div ? parseFloat((div.style.fontSize||'14px')) : 14; const color = div ? (div.style.color||'#000') : '#000';
        ctx.save();
        if(bg && bg!=='transparent'){ ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.fillRect(x,y,w,h); }
        ctx.strokeStyle=stroke; ctx.lineWidth=1.5; ctx.strokeRect(x,y,w,h);
        const padding=6; const text=(div&&div.innerText)?div.innerText:'';
        ctx.font=`${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, sans-serif`;
        ctx.fillStyle=color; const maxW=Math.max(1, w-padding*2); const lineH=Math.round(fontSize*1.3);
        let cursorY=y+padding+fontSize;
        const paragraphs=String(text).split(/\r?\n/);
        for(const para of paragraphs){
          const words=para.split(/\s+/); let line='';
          for(const word of words){
            const test=line?(line+' '+word):word;
            if(ctx.measureText(test).width<=maxW){ line=test; } else { ctx.fillText(line, x+padding, cursorY); cursorY+=lineH; line=word; }
          }
          if(line){ ctx.fillText(line, x+padding, cursorY); cursorY+=lineH; }
        }
        ctx.restore();
      }
    });
    ctx.restore();
  }
  async function compositePageBlobURL(i){
    const {canvas}=state.pages.get(i);
    // Downscale large canvases to keep print lightweight
    const MAX_W = 2200;
    const sc = canvas.width > MAX_W ? (MAX_W / Math.max(1, canvas.width)) : 1;
    const tw = Math.max(1, Math.floor(canvas.width * sc));
    const th = Math.max(1, Math.floor(canvas.height * sc));
    const off=document.createElement('canvas'); off.width=tw; off.height=th; const ctx=off.getContext('2d');
    ctx.drawImage(canvas,0,0,tw,th); drawOverlayOntoCanvas(ctx, i);
    const blob = await new Promise(res=> off.toBlob(b=>res(b||new Blob()), 'image/png'));
    return URL.createObjectURL(blob);
  }
  async function printWithAnnotations(){
    // Hidden iframe approach to avoid opening a new window/tab
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(ifr);
    const w = ifr.contentWindow; const d = ifr.contentDocument;
    if(!w || !d){ alert('Nie udało się zainicjować drukowania.'); ifr.remove(); return; }
    const safeTitle = (el.title?.textContent||'Drukuj').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    d.open();
    d.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
@page{ margin:10mm }
html,body{ background:#fff; margin:0 }
.page{ page-break-after:always; display:flex; justify-content:center }
img{ max-width:100%; height:auto; display:block }
</style>
</head><body>
<script>
  window.__expectedPages=${state.total};
  window.__loaded=0;
  window.addPage = function(src){
    const holder=document.createElement('div'); holder.className='page';
    const img=new Image(); img.loading='eager';
    function done(){ if(++window.__loaded>=window.__expectedPages){ setTimeout(()=>{ try{ window.focus(); window.print(); }catch(e){} },150); } }
    img.addEventListener('load',done); img.addEventListener('error',done);
    img.src=src; holder.appendChild(img); document.body.appendChild(holder);
  };
</script>
</body></html>`);
    d.close();

    // Wait until the iframe script defines addPage
    await new Promise(resolve=>{
      const t0=Date.now();
      const iv=setInterval(()=>{
        if(!w){ clearInterval(iv); resolve(); return; }
        try{ if(typeof w.addPage==='function'){ clearInterval(iv); resolve(); return; } }catch(_){ }
        if(Date.now()-t0>3000){ clearInterval(iv); resolve(); }
      }, 30);
    });

    // Render pages and stream into the iframe incrementally
    await ensureAllRendered();
    for(let i=1;i<=state.total;i++){
      const url = await compositePageBlobURL(i);
      try{ if(typeof w.addPage==='function'){ w.addPage(url); } }catch(_){ break; }
      await new Promise(r=>setTimeout(r,0));
    }

    // Cleanup iframe later (print dialog usually blocks callbacks)
    setTimeout(()=>{ try{ ifr.remove(); }catch(_){ } }, 20000);
  }
  async function compositePageDataURL(i){
    const {canvas}=state.pages.get(i);
    const MAX_W=2200; const sc=canvas.width>MAX_W?(MAX_W/Math.max(1,canvas.width)):1;
    const tw=Math.max(1,Math.floor(canvas.width*sc)); const th=Math.max(1,Math.floor(canvas.height*sc));
    const off=document.createElement('canvas'); off.width=tw; off.height=th; const ctx=off.getContext('2d');
    ctx.drawImage(canvas,0,0,tw,th); drawOverlayOntoCanvas(ctx,i);
    return off.toDataURL('image/png');
  }
  async function saveWithAnnotationsHTML(){
    await ensureAllRendered();
    const urls=[];
    for(let i=1;i<=state.total;i++){ urls.push(await compositePageDataURL(i)); await new Promise(r=>setTimeout(r,0)); }
    const body = urls.map(u=>`<div class="page"><img src="${u}" /></div>`).join('\n');
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>${(el.title?.textContent||'Dokument z adnotacjami')}</title>
<style>
@page{ margin:10mm }
html,body{ background:#fff; margin:0 }
.page{ page-break-after:always; display:flex; justify-content:center }
img{ max-width:100%; height:auto; display:block }
</style>
</head><body>
${body}
</body></html>`;
    const blob=new Blob([html],{type:'text/html'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    const base=(el.title?.textContent||'document').replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_');
    a.download=base+'.with-annotations.html'; document.body.appendChild(a); a.click(); a.remove();
  }

  // ===== VERSIONING / SHORTCUTS =====
  function applyVersioning(){
    const v=state.version|0, enable=(v===2);
    if(el.download) el.download.style.display = enable ? '' : 'none';
    if(el.print)    el.print.style.display    = enable ? '' : 'none';
    function rewire(btn, handler){ if(!btn) return; const clone=btn.cloneNode(true); btn.parentNode.replaceChild(clone,btn); clone.addEventListener('click', handler); return clone; }
    if(enable){
      rewire(el.download, async()=>{ const choice=await modalConfirmAnnotations('zapis'); if(choice===null) return; if(choice===false){ if(!state.url) return; const a=document.createElement('a'); a.href=state.url; const nm=(el.title?.textContent||'document').replace(/[\\/:*?"<>|]+/g,'_'); a.download=/\.pdf$/i.test(nm)?nm:nm+'.pdf'; document.body.appendChild(a); a.click(); a.remove();
        } else { await saveWithAnnotationsHTML(); } });
      rewire(el.print, async()=>{ const choice=await modalConfirmAnnotations('druk'); if(choice===null) return; if(choice===false){ if(!state.url) return; const ifr=document.createElement('iframe'); ifr.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0'; ifr.src=state.url; document.body.appendChild(ifr); ifr.onload=()=>{ try{ ifr.contentWindow.focus(); ifr.contentWindow.print(); }catch(_){ } setTimeout(()=>ifr.remove(), 20000); };
        } else { await printWithAnnotations(); } });
    }
    function blockGlobal(e){
      const k=(e.key||'').toLowerCase(), ctrl=e.ctrlKey||e.metaKey, shift=e.shiftKey;
      if(!enable && ctrl && (k==='s'||k==='p')){ e.preventDefault(); e.stopImmediatePropagation(); return; }
      if(k==='f12'){ e.preventDefault(); e.stopImmediatePropagation(); return; }
      if(ctrl && shift && (k==='i'||k==='j'||k==='c')){ e.preventDefault(); e.stopImmediatePropagation(); return; }
      if(ctrl && k==='u'){ e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
    window.removeEventListener('keydown', applyVersioning._blk, true);
    document.removeEventListener('keydown', applyVersioning._blk, true);
    applyVersioning._blk = blockGlobal;
    window.addEventListener('keydown', blockGlobal, true);
    document.addEventListener('keydown', blockGlobal, true);
    window.addEventListener('contextmenu', (e)=>e.preventDefault(), true);
  }

  // ===== MODAL =====
  function modalConfirmAnnotations(kind /* 'druk' | 'zapis' */){
    return new Promise(resolve=>{
      const root=document.createElement('div');
      root.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
      const card=document.createElement('div');
      card.style.cssText='min-width:320px;max-width:92vw;border-radius:14px;background:#ffffff;color:#111;box-shadow:0 22px 70px rgba(0,0,0,.35);padding:20px;';
      const h=document.createElement('div'); h.style.cssText='font-size:18px;font-weight:700;margin-bottom:6px;';
      h.textContent=(kind==='druk'?'Drukowanie':'Zapis')+' dokumentu';
      const p=document.createElement('div'); p.style.cssText='margin:2px 0 16px;line-height:1.5;'; p.textContent='Czy chcesz dołączyć adnotacje (rysunki i notatki)?';
      const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end';
      const no=document.createElement('button'); no.textContent='Nie'; no.style.cssText='padding:8px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;color:#111;';
      const yes=document.createElement('button'); yes.textContent='Tak'; yes.style.cssText='padding:8px 12px;border-radius:10px;border:0;background:#111827;color:#fff;';
      no.addEventListener('click',()=>{ cleanup(); resolve(false); });
      yes.addEventListener('click',()=>{ cleanup(); resolve(true); });
      function onKey(e){ if(e.key==='Escape'){ e.preventDefault(); cleanup(); resolve(null); } }
      function cleanup(){ document.removeEventListener('keydown',onKey,true); root.remove(); }
      document.addEventListener('keydown',onKey,true);
      card.append(h,p,row); row.append(no,yes); root.append(card); document.body.append(root);
    });
  }

  // ===== EVENTS =====
  el.file?.addEventListener('change', async(e)=>{ const f=e.target.files[0]; if(!f) return; const buf=await f.arrayBuffer(); await openPDF(buf, f.name); });
  el.toolboxToggle?.addEventListener('click',()=> el.toolbox?.classList.toggle('open'));
  (function(){ const head=el.tbHead; if(!head) return; let dragging=false,ox=0,oy=0; head.addEventListener('pointerdown',(e)=>{ if(e.target===el.tbClose) return; dragging=true; const r=el.toolbox.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top; head.setPointerCapture(e.pointerId); }); head.addEventListener('pointermove',(e)=>{ if(!dragging) return; el.toolbox.style.left=Math.max(8,e.clientX-ox)+'px'; el.toolbox.style.top=Math.max(8,e.clientY-oy)+'px'; el.toolbox.style.right='auto'; }); head.addEventListener('pointerup',(e)=>{ dragging=false; try{ head.releasePointerCapture(e.pointerId);}catch(_){ } }); })();
  el.btnSidebar?.addEventListener('click',()=>{ state.isSidebarVisible=!state.isSidebarVisible; const app=document.querySelector('.app'); if(app) app.style.gridTemplateColumns=state.isSidebarVisible?'280px 1fr':'1fr'; if(el.sidebar) el.sidebar.style.display=state.isSidebarVisible?'block':'none'; });
  el.prev?.addEventListener('click',()=> goToPage(state.page-1));
  el.next?.addEventListener('click',()=> goToPage(state.page+1));
  el.pageNum?.addEventListener('change',()=>{ const v=parseInt(el.pageNum.value||'1',10); goToPage(v); });
  el.zoomIn?.addEventListener('click',()=> zoom(0.1));
  el.zoomOut?.addEventListener('click',()=> zoom(-0.1));
  el.zoomReset?.addEventListener('click',()=> setZoom(1));
  // New larger-step zoom controls (+/- 25%)
  el.zoomInBig?.addEventListener('click',()=> zoom(0.25));
  el.zoomOutBig?.addEventListener('click',()=> zoom(-0.25));
  el.fitWidth?.addEventListener('click',()=> fitWidth());
  el.fitPage?.addEventListener('click',()=> fitPage());
  el.rotateL?.addEventListener('click', async()=>{ if(!state.pdf) return; state.rotation=(state.rotation+270)%360; layoutPages(); await renderAllVisible(); buildThumbnails(); });
  el.rotateR?.addEventListener('click', async()=>{ if(!state.pdf) return; state.rotation=(state.rotation+90)%360; layoutPages(); await renderAllVisible(); buildThumbnails(); });
  el.search?.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); search(el.search.value.trim()); } });
  el.findNext?.addEventListener('click',()=> findNext(1));
  el.findPrev?.addEventListener('click',()=> findNext(-1));
  el.tabThumbs?.addEventListener('click',()=>{ $('#paneThumbs').classList.add('active'); $('#paneOutline').classList.remove('active'); });
  el.tabOutline?.addEventListener('click',()=>{ $('#paneOutline').classList.add('active'); $('#paneThumbs').classList.remove('active'); });

  document.addEventListener('keydown',(e)=>{
    const ae=document.activeElement; const isEditing=ae && (ae.isContentEditable || /^(input|textarea)$/i.test(ae.tagName));
    if(e.target===el.search || e.target===el.pageNum) return;
    const ctrl=e.ctrlKey||e.metaKey; const k=e.key;
    if(ctrl&&(k==='+'||k==='=')){ e.preventDefault(); zoom(0.1); return; }
    if(ctrl&&(k==='-'||k==='_')){ e.preventDefault(); zoom(-0.1); return; }
    if(ctrl&&k==='0'){ e.preventDefault(); setZoom(1); return; }
    if(k==='PageUp'){ e.preventDefault(); goToPage(state.page-1); return; }
    if(k==='PageDown'){ e.preventDefault(); goToPage(state.page+1); return; }
    if(k.toLowerCase()==='f' && !ctrl && !isEditing){ e.preventDefault(); el.fullscreen?.click(); return; }
    if(ctrl && k.toLowerCase()==='f'){ e.preventDefault(); el.search?.focus(); el.search?.select?.(); return; }
    if(k==='Enter' && !ctrl && !isEditing){ e.preventDefault(); findNext(e.shiftKey?-1:1); return; }
    if(k.toLowerCase()==='r' && !e.shiftKey && !isEditing){ e.preventDefault(); el.rotateL?.click(); return; }
    if(k.toLowerCase()==='r' &&  e.shiftKey && !isEditing){ e.preventDefault(); el.rotateR?.click(); return; }
    if(k.toLowerCase()==='t' && !isEditing){ e.preventDefault(); el.btnSidebar?.click(); return; }
    if(k.toLowerCase()==='b' && !ctrl && !isEditing){ e.preventDefault(); el.toolboxToggle?.click(); return; }
    if((k==='Delete'||k==='Backspace') && !isEditing){ e.preventDefault(); const sel=document.querySelector('.overlay .shape.selected'); if(sel){ sel.remove(); scheduleSaveDebounced(); } return; }
    if(k==='Escape'){ if(isEditing){ ae.blur(); } else { clearSelection(); } return; }
  });

  let scrollTimer=null;
  el.wrap?.addEventListener('scroll',()=>{
    if(!state.pdf) return;
    clearTimeout(scrollTimer); scrollTimer=setTimeout(()=>{ renderAllVisible(); },60);
    const center = el.wrap.scrollTop + el.wrap.clientHeight/2;
    for(const [n,{container}] of state.pages){
      const top=offsetWithin(el.wrap,container); const bottom=top+container.offsetHeight;
      if(top<=center && bottom>center){ if(state.page!==n){ state.page=n; el.pageNum && (el.pageNum.value=String(n)); selectThumb(n); centerThumbInSidebar(n); } break; }
    }
  });

  // ===== MODAL (shared) =====
  function modalConfirmAnnotations(kind){
    return new Promise(resolve=>{
      const root=document.createElement('div');
      root.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
      const card=document.createElement('div');
      card.style.cssText='min-width:320px;max-width:92vw;border-radius:14px;background:#ffffff;color:#111;box-shadow:0 22px 70px rgba(0,0,0,.35);padding:20px;';
      const h=document.createElement('div'); h.style.cssText='font-size:18px;font-weight:700;margin-bottom:6px;';
      h.textContent=(kind==='druk'?'Drukowanie':'Zapis')+' dokumentu';
      const p=document.createElement('div'); p.style.cssText='margin:2px 0 16px;line-height:1.5;'; p.textContent='Czy chcesz dołączyć adnotacje (rysunki i notatki)?';
      const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end';
      const no=document.createElement('button'); no.textContent='Nie'; no.style.cssText='padding:8px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;color:#111;';
      const yes=document.createElement('button'); yes.textContent='Tak'; yes.style.cssText='padding:8px 12px;border-radius:10px;border:0;background:#111827;color:#fff;';
      no.addEventListener('click',()=>{ cleanup(); resolve(false); });
      yes.addEventListener('click',()=>{ cleanup(); resolve(true); });
      function onKey(e){ if(e.key==='Escape'){ e.preventDefault(); cleanup(); resolve(null); } }
      function cleanup(){ document.removeEventListener('keydown',onKey,true); root.remove(); }
      document.addEventListener('keydown',onKey,true);
      card.append(h,p,row); row.append(no,yes); root.append(card); document.body.append(root);
    });
  }

  // ===== START =====
  bindToolButtons();
  (async ()=>{
    await loadVersionFromJson();
    const ok = await tryLoadFromParams();
    if(!ok){ await tryLoadFallbackConfig(); }
    applyVersioning();
  })();

  // Expose for debugging
  window.PDF_APP = { state, openPDF, serializeAnnotations, restoreAnnotationsFromObject };
})();
