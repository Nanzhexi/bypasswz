// Offline stand-in for the Geetest v3 slide captcha that GSXT shows after a search.
// It copies the real widget's DOM (class names, bg / fullbg / slice canvases, a slider button that
// listens for mousedown, document-level mousemove / mouseup) and judges the drop position
// geometrically. It cannot model Geetest's server-side behaviour analysis, so a pass here proves
// alignment and event flow only, not acceptance by the real service.
// Opt-in variants (MOCK='{"moveMode":"repaint","sliceMode":"full"}'): "repaint" redraws the piece inside a
// static slice canvas, "other" leaves the slice canvas still and moves a separate element instead.

export function mockOptions(seed, overrides = {}) {
  let s = (Math.imul(seed + 1, 2654435761) >>> 0);
  const r = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = list => list[Math.floor(r() * list.length)];
  const scale = pick([1, 1, 1, 1, 1.15, 0.9]);
  return {
    seed, W: 260, H: 160,
    sliceMode: pick(['full', 'full', 'strip', 'small']),
    moveMode: pick(['left', 'left', 'transform']),
    scale,
    naiveScale: scale !== 1 && r() < 0.5,
    sliceRatio: pick([1, 1, 1, 1, 0.92, 1.08]),
    dark: r() < 0.2,
    stripes: r() < 0.15,
    noise: pick([0, 2, 4, 6]),
    inset: 5 + Math.floor(r() * 5),
    tol: 3,
    listenOn: pick(['document', 'document', 'window']),
    panelPosition: pick(['fixed', 'fixed', 'absolute']),
    hasFullbg: true,
    paintDelay: 250 + Math.floor(r() * 450),
    ...overrides
  };
}

function widgetMain(opts) {
  const { W, H } = opts;
  let state = (opts.seed * 7919 + 17) >>> 0;
  const rand = () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ri = (a, b) => Math.floor(a + rand() * (b - a + 1));
  const stats = window.__geetest = { shown: 0, attempts: 0, successes: 0, failures: 0, solved: false, errors: [], puzzle: null, last: null };
  const panel = document.querySelector('.geetest_panel');
  const bg = panel.querySelector('.geetest_canvas_bg');
  const full = panel.querySelector('.geetest_canvas_fullbg');
  const slice = panel.querySelector('.geetest_canvas_slice');
  const sliceWrap = panel.querySelector('.geetest_slice');
  const btn = panel.querySelector('.geetest_slider_button');
  const track = panel.querySelector('.geetest_slider_track');
  const tip = panel.querySelector('.geetest_result_tip');
  const slider = panel.querySelector('.geetest_slider');
  const refreshEl = panel.querySelector('.geetest_refresh_1');
  const viewPiece = panel.querySelector('.geetest_piece_view');
  let ready = false, puzzle = null, drag = null, sliceLeft = 0, current = null;

  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const addNoise = (g, w, h, amount) => {
    if (!amount) return;
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] += Math.round((rand() - 0.5) * 2 * amount);
      d[i + 1] += Math.round((rand() - 0.5) * 2 * amount);
      d[i + 2] += Math.round((rand() - 0.5) * 2 * amount);
    }
    g.putImageData(img, 0, 0);
  };

  const makePicture = () => {
    const c = canvasOf(W, H), g = c.getContext('2d');
    const light = opts.dark ? [8, 40] : [30, 85];
    const hsl = () => `hsl(${ri(0, 360)}, ${ri(15, 85)}%, ${ri(light[0], light[1])}%)`;
    const grad = g.createLinearGradient(ri(0, W), ri(0, H), ri(0, W), ri(0, H));
    grad.addColorStop(0, hsl());
    grad.addColorStop(1, hsl());
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const count = ri(30, 70);
    for (let i = 0; i < count; i++) {
      g.globalAlpha = 0.25 + rand() * 0.65;
      g.fillStyle = hsl();
      g.beginPath();
      const kind = ri(0, 2);
      if (kind === 0) g.ellipse(ri(0, W), ri(0, H), ri(3, 45), ri(3, 45), rand() * 3, 0, Math.PI * 2);
      else if (kind === 1) g.rect(ri(0, W), ri(0, H), ri(4, 70), ri(4, 70));
      else { g.moveTo(ri(0, W), ri(0, H)); g.lineTo(ri(0, W), ri(0, H)); g.lineTo(ri(0, W), ri(0, H)); }
      g.fill();
    }
    g.globalAlpha = 1;
    if (opts.stripes) {
      for (let x = 0; x < W; x += 4) {
        g.fillStyle = `rgba(255,255,255,${(x / 4) % 2 ? 0.18 : 0})`;
        g.fillRect(x, 0, 2, H);
      }
    }
    return c;
  };

  const makeShape = () => {
    const S = ri(38, 48), r = Math.round(S * 0.17), pad = r * 2 + 3;
    const c = canvasOf(S + pad * 2, S + pad * 2), g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(pad, pad, S, S);
    const sides = [ri(0, 2), ri(0, 2), ri(0, 2), ri(0, 2)]; // top, right, bottom, left: 0 flat, 1 knob, 2 notch
    if (!sides.includes(1)) sides[ri(0, 3)] = 1;
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const mids = [[pad + S / 2, pad], [pad + S, pad + S / 2], [pad + S / 2, pad + S], [pad, pad + S / 2]];
    sides.forEach((kind, i) => {
      const [dx, dy] = dirs[i], [mx, my] = mids[i];
      if (kind === 1) {
        g.globalCompositeOperation = 'source-over';
        g.beginPath(); g.arc(mx + dx * r * 0.3, my + dy * r * 0.3, r, 0, Math.PI * 2); g.fill();
      }
      if (kind === 2) {
        g.globalCompositeOperation = 'destination-out';
        g.beginPath(); g.arc(mx - dx * r * 0.3, my - dy * r * 0.3, r, 0, Math.PI * 2); g.fill();
      }
    });
    g.globalCompositeOperation = 'source-over';
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 127) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, out = canvasOf(w, h);
    out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
    return { canvas: out, w, h };
  };

  const buildPuzzle = () => {
    const pic = makePicture(), shape = makeShape();
    return { pic, shape, gapX: ri(64, W - shape.w - 8), gapY: ri(4, H - shape.h - 4) };
  };

  const drawPiece = () => {
    if (!current) return;
    const sg = slice.getContext('2d');
    sg.clearRect(0, 0, slice.width, slice.height);
    sg.save();
    sg.shadowColor = 'rgba(255,255,255,0.9)';
    sg.shadowBlur = 2;
    sg.drawImage(current.piece, opts.inset + (opts.moveMode === 'repaint' ? sliceLeft : 0), current.y);
    sg.restore();
  };
  const apply = dist => {
    sliceLeft = dist * opts.sliceRatio;
    if (opts.moveMode === 'repaint') drawPiece();
    else if (opts.moveMode === 'other') viewPiece.style.left = `${opts.inset + sliceLeft}px`;
    else if (sliceWrap) sliceWrap.style.transform = `translateX(${sliceLeft}px)`;
    else slice.style.left = `${sliceLeft}px`;
    btn.style.transform = `translateX(${dist}px)`;
    track.style.width = `${dist + 25}px`;
  };
  const reset = () => apply(0);

  const paint = p => {
    if (opts.hasFullbg) {
      const gf = full.getContext('2d');
      gf.clearRect(0, 0, W, H);
      gf.drawImage(p.pic, 0, 0);
      addNoise(gf, W, H, opts.noise);
    }
    const gb = bg.getContext('2d');
    gb.clearRect(0, 0, W, H);
    gb.drawImage(p.pic, 0, 0);
    const tint = canvasOf(p.shape.w, p.shape.h), gt = tint.getContext('2d');
    gt.drawImage(p.shape.canvas, 0, 0);
    gt.globalCompositeOperation = 'source-in';
    gt.fillStyle = `rgba(0,0,0,${0.5 + (p.gapX % 7) / 70})`;
    gt.fillRect(0, 0, p.shape.w, p.shape.h);
    gb.save();
    gb.shadowColor = 'rgba(255,255,255,0.5)';
    gb.shadowBlur = 3;
    gb.drawImage(tint, p.gapX, p.gapY);
    gb.restore();
    addNoise(gb, W, H, opts.noise);
    slice.width = opts.sliceMode === 'full' ? W : p.shape.w + opts.inset + 14;
    slice.height = opts.sliceMode === 'small' ? p.shape.h + 4 : H;
    slice.style.top = opts.sliceMode === 'small' ? `${p.gapY - 2}px` : '0px';
    const piece = canvasOf(p.shape.w, p.shape.h), gp = piece.getContext('2d');
    gp.drawImage(p.shape.canvas, 0, 0);
    gp.globalCompositeOperation = 'source-in';
    gp.drawImage(p.pic, p.gapX, p.gapY, p.shape.w, p.shape.h, 0, 0, p.shape.w, p.shape.h);
    current = { piece, y: opts.sliceMode === 'small' ? 2 : p.gapY };
    drawPiece();
    if (opts.moveMode === 'other') {
      slice.style.visibility = 'hidden';
      viewPiece.style.backgroundImage = `url(${piece.toDataURL()})`;
      viewPiece.style.width = `${p.shape.w}px`;
      viewPiece.style.height = `${p.shape.h}px`;
      viewPiece.style.top = `${p.gapY}px`;
    }
  };

  if (!opts.hasFullbg) full.remove();
  const clearAll = () => { for (const c of [bg, opts.hasFullbg ? full : null, slice]) if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); };
  const newImages = () => {
    ready = false;
    slider.classList.remove('geetest_ready');
    clearAll();
    setTimeout(() => {
      puzzle = buildPuzzle();
      paint(puzzle);
      stats.puzzle = { gapX: puzzle.gapX, gapY: puzzle.gapY, w: puzzle.shape.w, h: puzzle.shape.h };
      ready = true;
      slider.classList.add('geetest_ready');
    }, opts.paintDelay);
  };

  const win = () => {
    stats.successes++;
    ready = false;
    slider.classList.add('geetest_success');
    tip.textContent = '验证通过';
    tip.style.display = 'block';
    setTimeout(() => {
      panel.style.display = 'none';
      stats.solved = true;
      if (typeof window.__onGeetestSuccess === 'function') window.__onGeetestSuccess();
    }, 700);
  };
  const lose = (err, human) => {
    stats.failures++;
    stats.errors.push({ err: +err.toFixed(2), human });
    ready = false;
    slider.classList.add('geetest_error');
    tip.textContent = '怪物吃了拼图，请重试';
    tip.style.display = 'block';
    setTimeout(() => {
      slider.classList.remove('geetest_error');
      tip.style.display = 'none';
      reset();
      newImages();
    }, 900);
  };

  btn.addEventListener('mousedown', e => {
    if (!ready || drag || e.button !== 0) return;
    drag = { x0: e.clientX, t0: performance.now(), moves: 0, last: e.clientX, maxJump: 0, ys: new Set() };
    e.preventDefault();
  });
  const listener = opts.listenOn === 'window' ? window : document;
  listener.addEventListener('mousemove', e => {
    if (!drag) return;
    drag.maxJump = Math.max(drag.maxJump, Math.abs(e.clientX - drag.last));
    drag.last = e.clientX;
    drag.moves++;
    drag.ys.add(Math.round(e.clientY));
    apply(Math.max(0, Math.min(W + 40, (e.clientX - drag.x0) / (opts.naiveScale ? 1 : opts.scale))));
  });
  listener.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const duration = performance.now() - d.t0;
    const err = sliceLeft + opts.inset - puzzle.gapX;
    const human = d.moves >= 12 && duration >= 350 && duration <= 15000 && d.maxJump <= 45 && d.ys.size >= 2;
    stats.attempts++;
    stats.last = { err: +err.toFixed(2), duration: Math.round(duration), moves: d.moves, human };
    if (Math.abs(err) <= opts.tol && human) win(); else lose(err, human);
  });
  refreshEl.addEventListener('click', () => { if (ready) newImages(); });

  window.__geetest.show = () => {
    stats.shown++;
    slider.classList.remove('geetest_success', 'geetest_error');
    tip.style.display = 'none';
    reset();
    panel.style.display = 'block';
    newImages();
  };
}

export function widgetHtml(opts) {
  const { W, H } = opts;
  const sliceTag = `<canvas class="geetest_canvas_slice geetest_absolute" width="${W}" height="${H}"></canvas>`;
  const sliceBlock = opts.moveMode === 'transform' ? `<div class="geetest_slice geetest_absolute">${sliceTag}</div>` : sliceTag;
  const otherView = opts.moveMode === 'other' ? '<div class="geetest_piece_view geetest_absolute" style="background-size:100% 100%"></div>' : '';
  return `<style>
.geetest_absolute { position: absolute; left: 0; top: 0; }
.geetest_panel { display: none; position: ${opts.panelPosition}; left: 50%; top: 60px; margin-left: -150px; z-index: 99999; width: ${W + 30}px; padding: 15px; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,.3);${opts.scale !== 1 ? ` transform: scale(${opts.scale}); transform-origin: top left;` : ''} }
.geetest_window { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
.geetest_slider { position: relative; width: ${W}px; height: 44px; margin-top: 12px; background: #e8e8e8; border-radius: 22px; }
.geetest_slider_track { position: absolute; left: 0; top: 0; height: 44px; width: 0; background: #9fd0ff; border-radius: 22px; }
.geetest_slider_tip { position: absolute; left: 60px; top: 12px; color: #666; font-size: 13px; }
.geetest_slider_button { position: absolute; left: 0; top: 0; width: 50px; height: 44px; background: #3a8ee6; border-radius: 22px; cursor: pointer; }
.geetest_refresh_1 { position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; background: #0006; border-radius: 12px; }
.geetest_result_tip { position: absolute; left: 0; bottom: 0; width: 100%; padding: 6px 0; background: rgba(0,0,0,.7); color: #fff; display: none; text-align: center; }
</style>
<div class="geetest_panel geetest_wind"><div class="geetest_panel_box geetest_panelshowslide"><div class="geetest_panel_next"><div class="geetest_wrap"><div class="geetest_widget">
  <div class="geetest_window">
    <div class="geetest_slicebg geetest_absolute">
      <canvas class="geetest_canvas_bg geetest_absolute" width="${W}" height="${H}"></canvas>
      ${sliceBlock}${otherView}
    </div>
    <canvas class="geetest_canvas_fullbg geetest_fade geetest_absolute" width="${W}" height="${H}" style="display:none"></canvas>
    <a class="geetest_refresh_1" href="javascript:;"></a>
    <div class="geetest_result_tip"></div>
  </div>
  <div class="geetest_slider"><div class="geetest_slider_track"></div><div class="geetest_slider_tip">按住左边滑块，拖动完成上方拼图</div><div class="geetest_slider_button"><div class="geetest_slider_button_icon"></div></div></div>
</div></div></div></div></div>
<script>(${widgetMain.toString()})(${JSON.stringify(opts)});</script>`;
}
