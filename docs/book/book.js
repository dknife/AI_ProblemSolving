/* AI 문제해결 — 웹 본문 공통 스크립트 (손으로 관리하는 파일)
 *
 * 앞선 두 책(알짜 파이썬·WebGL)에서는 코드 블록에 [실행] 버튼이 붙어
 * Pyodide나 WebGL 캔버스가 돌았다. 이 책은 구현이 아니라 활용을 다루므로
 * 그 자리에 다음 네 가지가 들어간다.
 *
 *  1. 프롬프트 실습 카드 — [복사] + [도구에서 열기] (전 장)
 *  2. 토큰 예측 위젯      — 언어 모델이 다음 낱말을 고르는 방식 체험 (3.1절)
 *  3. 확산 위젯           — 노이즈에서 형상이 떠오르는 과정 체험 (3.2절)
 *  4. 도구 비교표         — 정렬·필터되는 표 (부록 A)
 *
 * 위젯은 원고의 \webwidget{이름} 매크로가 만든 <div class="widget" data-widget="...">
 * 자리에 마운트된다. 데이터는 data/*.json에 두어 원고를 건드리지 않고 갱신한다.
 *
 * 위젯 2·3은 실제 모델을 브라우저에서 돌리지 않는다. 수십~수백 MB를 내려받게
 * 하는 대신, 원리를 눈으로 보여 주는 데 필요한 만큼만 미리 계산해 두거나
 * 그 자리에서 계산한다. 목적은 정확한 재현이 아니라 직관의 전달이다.
 */
(function () {
  'use strict';

  /* ================================================================
     1. 복사 버튼
     tex2html.py가 이미 <button class="prompt-copy">를 심어 두었다.
     여기서는 동작만 붙인다.
     ================================================================ */
  function copyText(btn, text) {
    function done(ok) {
      var old = btn.textContent;
      btn.textContent = ok ? '복사됨!' : '복사 실패';
      btn.classList.toggle('ok', ok);
      setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove('ok');
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); },
                                              function () { done(false); });
      return;
    }
    // 구형 브라우저 / 비보안 컨텍스트 폴백
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  }

  document.querySelectorAll('.prompt-copy').forEach(function (btn) {
    // 버튼이 속한 카드/래퍼 안의 코드 블록을 찾는다
    var host = btn.closest('.promptcard') || btn.closest('.prompt-wrap');
    if (!host) return;
    var code = host.querySelector('pre code');
    if (!code) { btn.remove(); return; }
    // innerText는 <br>와 문단 경계를 줄바꿈으로 준다. 프롬프트가 본문 흐름으로
    // 바뀐 뒤로는 textContent만 쓰면 줄이 다 붙어 버린다.
    btn.addEventListener('click', function () {
      copyText(btn, (code.innerText || code.textContent).trim());
    });
  });

  // 설정값 상자·AI 응답에도 복사 버튼을 붙인다 (원고에는 버튼이 없다)
  document.querySelectorAll('.settingbox-wrap').forEach(function (wrap) {
    var code = wrap.querySelector('pre code');
    if (!code) return;
    wrap.classList.add('prompt-wrap');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prompt-copy';
    btn.textContent = '복사';
    btn.addEventListener('click', function () { copyText(btn, code.textContent); });
    wrap.insertBefore(btn, wrap.firstChild);
  });

  /* ================================================================
     2. 토큰 예측 위젯 — data-widget="tokens"
     ================================================================ */
  var TOKENS_FALLBACK = {
    examples: [
      {
        context: '오늘 날씨가 정말',
        candidates: [
          { word: '좋다',   logit: 3.4 },
          { word: '덥다',   logit: 2.7 },
          { word: '춥다',   logit: 2.3 },
          { word: '흐리다', logit: 1.8 },
          { word: '이상하다', logit: 1.1 },
          { word: '보라색', logit: -1.4 }
        ]
      },
      {
        context: '나는 미술관에 가서 그림을',
        candidates: [
          { word: '보았다',   logit: 3.6 },
          { word: '감상했다', logit: 3.0 },
          { word: '그렸다',   logit: 1.9 },
          { word: '샀다',     logit: 1.5 },
          { word: '만졌다',   logit: 0.4 },
          { word: '먹었다',   logit: -2.0 }
        ]
      },
      {
        context: '이 작품에서 가장 인상적인 것은 빛의',
        candidates: [
          { word: '사용',   logit: 3.2 },
          { word: '방향',   logit: 2.6 },
          { word: '대비',   logit: 2.4 },
          { word: '온도',   logit: 1.6 },
          { word: '부재',   logit: 1.2 },
          { word: '무게',   logit: -0.6 }
        ]
      }
    ]
  };

  function softmax(logits, temperature) {
    var t = Math.max(temperature, 0.05);
    var scaled = logits.map(function (l) { return l / t; });
    var max = Math.max.apply(null, scaled);
    var exps = scaled.map(function (s) { return Math.exp(s - max); });
    var sum = exps.reduce(function (a, b) { return a + b; }, 0);
    return exps.map(function (e) { return e / sum; });
  }

  function mountTokens(el, data) {
    var examples = (data && data.examples) || TOKENS_FALLBACK.examples;
    var body = el.querySelector('.widget-body');

    var opts = examples.map(function (ex, i) {
      return '<option value="' + i + '">' + escapeHtml(ex.context) + ' ___</option>';
    }).join('');

    body.innerHTML =
      '<div class="widget-row">' +
        '<label for="tok-ex">문장</label>' +
        '<select id="tok-ex" class="tok-ex">' + opts + '</select>' +
      '</div>' +
      '<div class="tok-context"></div>' +
      '<div class="widget-row">' +
        '<label for="tok-temp">온도</label>' +
        '<input type="range" id="tok-temp" class="tok-temp" ' +
          'min="0.1" max="2.0" step="0.1" value="1.0">' +
        '<span class="widget-val tok-temp-val">1.0</span>' +
      '</div>' +
      '<div class="tok-bars"></div>';

    var sel = body.querySelector('.tok-ex');
    var temp = body.querySelector('.tok-temp');
    var tempVal = body.querySelector('.tok-temp-val');
    var ctxEl = body.querySelector('.tok-context');
    var bars = body.querySelector('.tok-bars');

    function render() {
      var ex = examples[+sel.value];
      var t = +temp.value;
      tempVal.textContent = t.toFixed(1);

      var probs = softmax(ex.candidates.map(function (c) { return c.logit; }), t);
      // 확률 내림차순으로 보여 준다
      var rows = ex.candidates.map(function (c, i) {
        return { word: c.word, p: probs[i] };
      }).sort(function (a, b) { return b.p - a.p; });

      ctxEl.innerHTML = escapeHtml(ex.context) + ' <span class="blank">' +
        escapeHtml(rows[0].word) + '</span>';

      bars.innerHTML = rows.map(function (r) {
        var pct = (r.p * 100);
        return '<div class="tok-row">' +
          '<span class="tok-word">' + escapeHtml(r.word) + '</span>' +
          '<span class="tok-track"><span class="tok-fill" style="width:' +
            pct.toFixed(1) + '%"></span></span>' +
          '<span class="tok-pct">' + pct.toFixed(1) + '%</span>' +
        '</div>';
      }).join('');
    }

    sel.addEventListener('change', render);
    temp.addEventListener('input', render);
    render();
  }

  /* ================================================================
     3. 확산 위젯 — data-widget="diffusion"
     노이즈를 걷어낼수록 형상이 드러나는 과정을 캔버스로 보인다.
     실제 확산 모델을 돌리는 것이 아니라, 목표 이미지에 단계별 노이즈를
     섞어 "되돌리는 쪽"을 슬라이더로 훑게 한 것이다.
     ================================================================ */
  var DIFF_SIZE = 64;   // 내부 해상도 (CSS로 확대 — 픽셀이 보이는 편이 이해에 낫다)

  function makeTarget(kind) {
    // 목표 이미지: 화면 밖에서 한 번만 그려 픽셀 배열로 들고 있는다
    var c = document.createElement('canvas');
    c.width = c.height = DIFF_SIZE;
    var g = c.getContext('2d');
    var S = DIFF_SIZE;

    if (kind === 'face') {
      // 아주 단순화한 인물 실루엣
      g.fillStyle = '#20344F'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#E8C39E';
      g.beginPath(); g.ellipse(S / 2, S * 0.42, S * 0.2, S * 0.25, 0, 0, 7); g.fill();
      g.beginPath(); g.ellipse(S / 2, S * 0.95, S * 0.32, S * 0.3, 0, 0, 7); g.fill();
      g.fillStyle = '#2C2116';
      g.beginPath(); g.ellipse(S * 0.43, S * 0.40, S * 0.025, S * 0.03, 0, 0, 7); g.fill();
      g.beginPath(); g.ellipse(S * 0.57, S * 0.40, S * 0.025, S * 0.03, 0, 0, 7); g.fill();
      g.beginPath(); g.ellipse(S / 2, S * 0.19, S * 0.21, S * 0.13, 0, 0, 7); g.fill();
    } else if (kind === 'landscape') {
      // 하늘 그러데이션 + 산 + 해
      var sky = g.createLinearGradient(0, 0, 0, S * 0.7);
      sky.addColorStop(0, '#F5A45C'); sky.addColorStop(1, '#FBE0B8');
      g.fillStyle = sky; g.fillRect(0, 0, S, S);
      g.fillStyle = '#F26B4B';
      g.beginPath(); g.arc(S * 0.7, S * 0.3, S * 0.1, 0, 7); g.fill();
      g.fillStyle = '#4A6B7A';
      g.beginPath(); g.moveTo(0, S * 0.72); g.lineTo(S * 0.32, S * 0.42);
      g.lineTo(S * 0.62, S * 0.72); g.closePath(); g.fill();
      g.fillStyle = '#33505E';
      g.beginPath(); g.moveTo(S * 0.4, S * 0.72); g.lineTo(S * 0.72, S * 0.5);
      g.lineTo(S, S * 0.72); g.closePath(); g.fill();
      g.fillStyle = '#1E3540'; g.fillRect(0, S * 0.72, S, S * 0.28);
    } else {
      // 정물: 배경 + 탁자 + 꽃병
      g.fillStyle = '#EDE4D6'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#8B5E3C'; g.fillRect(0, S * 0.72, S, S * 0.28);
      g.fillStyle = '#3E7C74';
      g.beginPath(); g.ellipse(S / 2, S * 0.6, S * 0.13, S * 0.16, 0, 0, 7); g.fill();
      g.fillRect(S * 0.45, S * 0.4, S * 0.1, S * 0.15);
      g.fillStyle = '#D4526E';
      [[0.5, 0.33], [0.42, 0.38], [0.58, 0.37]].forEach(function (p) {
        g.beginPath(); g.arc(S * p[0], S * p[1], S * 0.055, 0, 7); g.fill();
      });
    }
    return g.getImageData(0, 0, S, S);
  }

  function mountDiffusion(el) {
    var body = el.querySelector('.widget-body');
    body.innerHTML =
      '<div class="widget-row">' +
        '<label for="dif-kind">목표 이미지</label>' +
        '<select id="dif-kind" class="dif-kind">' +
          '<option value="landscape">풍경</option>' +
          '<option value="face">인물</option>' +
          '<option value="still">정물</option>' +
        '</select>' +
      '</div>' +
      '<div class="diff-stage"><canvas width="' + DIFF_SIZE + '" height="' +
        DIFF_SIZE + '"></canvas></div>' +
      '<div class="widget-row">' +
        '<label for="dif-step">단계</label>' +
        '<input type="range" id="dif-step" class="dif-step" ' +
          'min="0" max="20" step="1" value="0">' +
        '<span class="widget-val dif-step-val">0 / 20</span>' +
      '</div>' +
      '<div class="diff-steps"><span>순수한 노이즈</span><span>완성된 이미지</span></div>';

    var kindSel = body.querySelector('.dif-kind');
    var step = body.querySelector('.dif-step');
    var stepVal = body.querySelector('.dif-step-val');
    var canvas = body.querySelector('canvas');
    var ctx = canvas.getContext('2d');
    var STEPS = 20;

    // 노이즈는 고정 시드로 한 번만 만든다 — 슬라이더를 움직일 때마다
    // 노이즈가 바뀌면 "걷어내고 있다"는 느낌이 사라진다.
    var noise = new Uint8ClampedArray(DIFF_SIZE * DIFF_SIZE * 3);
    var seed = 12345;
    for (var i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;   // 선형 합동 생성기
      noise[i] = (seed >> 16) & 0xff;
    }

    var target = makeTarget(kindSel.value);

    function render() {
      var s = +step.value;
      stepVal.textContent = s + ' / ' + STEPS;
      // t=0이면 전부 노이즈, t=1이면 전부 목표 이미지.
      // 지수를 1보다 크게 주어 초반에는 형상이 잘 안 보이다가 후반에 드러나게 한다.
      // 1.7까지 올리면 중간 지점에서도 아무것도 안 보여 "언제 나타나는지" 감이 안 잡히므로
      // 1.25로 낮춰, 중간쯤에서 형상이 어렴풋이 잡히도록 했다.
      var t = s / STEPS;
      var mix = Math.pow(t, 1.25);
      var out = ctx.createImageData(DIFF_SIZE, DIFF_SIZE);
      for (var p = 0, n = 0; p < out.data.length; p += 4, n += 3) {
        out.data[p]     = target.data[p]     * mix + noise[n]     * (1 - mix);
        out.data[p + 1] = target.data[p + 1] * mix + noise[n + 1] * (1 - mix);
        out.data[p + 2] = target.data[p + 2] * mix + noise[n + 2] * (1 - mix);
        out.data[p + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    }

    kindSel.addEventListener('change', function () {
      target = makeTarget(kindSel.value);
      render();
    });
    step.addEventListener('input', render);
    render();
  }

  /* ================================================================
     4. 도구 비교표 — data-widget="tools"
     data/tools.json을 읽어 정렬·필터되는 표를 만든다.
     도구 정보가 바뀌면 JSON만 고치면 되고 원고는 건드리지 않는다.
     ================================================================ */
  var CATS = [
    ['all',    '전체'],
    ['chat',   '대화형 AI'],
    ['build',  '화면 만들기'],
    ['agent',  '에이전트'],
    ['python', '파이썬'],
    ['deploy', '배포·보관']
  ];
  var PRICE_LABEL = { free: '무료', freemium: '부분 무료',
                      credit: '무료 크레딧', paid: '유료' };
  var PRICE_ORDER = { free: 0, freemium: 1, credit: 2, paid: 3 };

  function mountTools(el, data) {
    var body = el.querySelector('.widget-body');
    var tools = (data && data.tools) || [];
    if (!tools.length) {
      body.innerHTML = '<div class="tooltable-empty">도구 목록을 불러오지 못했습니다.</div>';
      return;
    }

    body.innerHTML =
      '<div class="tooltable-controls">' +
        CATS.map(function (c, i) {
          return '<button type="button" data-cat="' + c[0] + '"' +
                 (i === 0 ? ' class="on"' : '') + '>' + c[1] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="table-wrap"><table class="tooltable">' +
        '<thead><tr>' +
          '<th data-sort="name">도구</th>' +
          '<th data-sort="price">요금</th>' +
          '<th data-sort="free">무료로 되는 것</th>' +
          '<th data-sort="note">메모</th>' +
          '<th data-sort="ch">장</th>' +
        '</tr></thead><tbody></tbody>' +
      '</table></div>';

    var tbody = body.querySelector('tbody');
    var cat = 'all';
    var sortKey = 'price';
    var sortAsc = true;

    function draw() {
      var rows = tools.filter(function (t) {
        return cat === 'all' || (t.cats || []).indexOf(cat) >= 0;
      });
      rows.sort(function (a, b) {
        var va, vb;
        if (sortKey === 'price') {
          va = PRICE_ORDER[a.price] || 9; vb = PRICE_ORDER[b.price] || 9;
        } else if (sortKey === 'ch') {
          va = a.ch || 99; vb = b.ch || 99;
        } else {
          va = String(a[sortKey] || '').toLowerCase();
          vb = String(b[sortKey] || '').toLowerCase();
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="tooltable-empty">' +
                          '해당하는 도구가 없습니다.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (t) {
        return '<tr>' +
          '<td><a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener">' +
            escapeHtml(t.name) + '</a></td>' +
          '<td><span class="price ' + escapeHtml(t.price) + '">' +
            (PRICE_LABEL[t.price] || t.price) + '</span></td>' +
          '<td>' + escapeHtml(t.free || '') + '</td>' +
          '<td>' + escapeHtml(t.note || '') + '</td>' +
          '<td>' + (t.ch ? t.ch + '장' : '') + '</td>' +
        '</tr>';
      }).join('');
    }

    body.querySelectorAll('.tooltable-controls button').forEach(function (b) {
      b.addEventListener('click', function () {
        body.querySelectorAll('.tooltable-controls button')
            .forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        cat = b.dataset.cat;
        draw();
      });
    });

    var ths = body.querySelectorAll('th[data-sort]');
    ths.forEach(function (th) {
      th.addEventListener('click', function () {
        if (sortKey === th.dataset.sort) { sortAsc = !sortAsc; }
        else { sortKey = th.dataset.sort; sortAsc = true; }
        ths.forEach(function (x) { x.classList.remove('asc', 'desc'); });
        th.classList.add(sortAsc ? 'asc' : 'desc');
        draw();
      });
    });

    body.querySelector('th[data-sort="price"]').classList.add('asc');
    draw();
  }

  /* ================================================================
     위젯 마운트 — 데이터가 필요한 것만 fetch한다
     ================================================================ */
  var NEEDS_DATA = { tokens: 'data/tokens.json', tools: 'data/tools.json' };
  var MOUNT = { tokens: mountTokens, diffusion: mountDiffusion, tools: mountTools };

  document.querySelectorAll('.widget[data-widget]').forEach(function (el) {
    var kind = el.dataset.widget;
    var fn = MOUNT[kind];
    if (!fn) return;
    var src = NEEDS_DATA[kind];
    if (!src) { fn(el, null); return; }
    fetch(src)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) { fn(el, data); });
  });

  /* ================================================================
     그림 확대 보기
     ================================================================ */
  document.querySelectorAll('.content img.tikz, .content img.gfx, .content img.shot')
    .forEach(function (img) {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', function () {
        window.open('viewer.html?src=' + encodeURIComponent(img.getAttribute('src')),
                    '_blank');
      });
    });

  /* ================================================================
     5. 편집 모드 — Ctrl+E (로컬 편집 서버가 떠 있을 때만)

     WebBook/editserver.py가 /__edit/ping에 응답하면 편집 UI가 살아난다.
     GitHub Pages에는 그 서버가 없으므로 ping이 실패하고, 아래 코드는
     아무것도 하지 않는다 — 배포된 사이트에서 Ctrl+E는 무반응이다.

     저장하면 서버가 HTML을 LaTeX으로 되돌려 원고 .tex를 직접 고치고,
     그 장만 다시 변환해 새 HTML 조각을 돌려준다. 문단이 늘거나 줄어
     블록 구성이 바뀐 경우에는 reload를 요청해 페이지를 다시 읽는다.
     ================================================================ */
  var EDIT = { ready: false, on: false, open: null, bar: null };

  // 로컬에서만 물어본다. 배포된 사이트에서 /__edit/ping을 때리면 콘솔에
  // 404만 남을 뿐이므로 아예 요청하지 않는다.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    fetch('/__edit/ping', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (info) {
        if (!info || !info.ok) {
          // 로컬인데 편집 서버가 아니다 — python -m http.server로 띄운 경우.
          // Ctrl+E가 왜 안 먹는지 콘솔에서 알 수 있게 알려 준다.
          console.info('[편집 모드] 꺼짐 — 정적 서버입니다. 원고를 고치려면 ' +
                       'python WebBook/editserver.py 로 띄우세요.');
          return;
        }
        EDIT.ready = true;
        document.body.classList.add('can-edit');
        document.addEventListener('keydown', editKey);
        restoreScroll();
        console.info('[편집 모드] Ctrl+E (맥 ⌘E) — 편집 블록 ' +
                     info.blocks + '개');
      });
  }

  function editKey(e) {
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'e') {
      var t = e.target || {};
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
      e.preventDefault();
      toggleEdit();
    }
  }

  function toggleEdit(force) {
    EDIT.on = (force === undefined) ? !EDIT.on : !!force;
    document.body.classList.toggle('edit-mode', EDIT.on);
    if (EDIT.on) { attachEditButtons(); showBar(); }
    else { closeEditor(); if (EDIT.bar) EDIT.bar.hidden = true; }
  }

  function attachEditButtons() {
    document.querySelectorAll('.content [data-blk]').forEach(function (el) {
      if (el.querySelector('.blk-edit')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'blk-edit';
      b.title = el.getAttribute('data-blk');
      b.textContent = '고치기';
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        openEditor(el);
      });
      // <ul>의 직계 자식 버튼은 표준 문법은 아니지만 position:absolute라
      // 배치에 영향이 없고, 로컬 편집용이라 실용을 택했다.
      el.appendChild(b);
    });
  }

  function prettyHtml(el) {
    var c = el.cloneNode(true);
    c.querySelectorAll('.blk-edit').forEach(function (b) { b.remove(); });
    c.classList.remove('blk-hidden');
    if (!c.getAttribute('class')) c.removeAttribute('class');
    var s = c.outerHTML.replace(/ data-blk="[^"]*"/, '');
    if (/^<(ul|ol)\b/.test(s)) {                 // 목록은 항목마다 줄바꿈
      s = s.replace(/(<\/li>|<(?:ul|ol)[^>]*>)(?=<)/g, '$1\n')
           .replace(/(<\/(?:ul|ol)>)$/, '\n$1');
    }
    return s;
  }

  function openEditor(el) {
    closeEditor();
    var id = el.getAttribute('data-blk');
    var box = document.createElement('div');
    box.className = 'blk-editor';
    box.innerHTML =
      '<div class="blk-editor-head">' +
        '<span class="blk-where">' + escapeHtml(id) + '</span>' +
        '<span class="blk-hint">저장하면 원고에 반영됩니다 · ' +
          '⌘/Ctrl+Enter 저장 · Esc 취소</span>' +
      '</div>' +
      '<textarea class="blk-src" spellcheck="false"></textarea>' +
      '<div class="blk-editor-foot">' +
        '<button type="button" class="blk-save">저장</button>' +
        '<button type="button" class="blk-cancel">취소</button>' +
        '<button type="button" class="blk-showtex">LaTeX 원본</button>' +
        '<span class="blk-msg"></span>' +
      '</div>' +
      '<pre class="blk-tex" hidden></pre>';

    var ta = box.querySelector('.blk-src');
    ta.value = prettyHtml(el);
    ta.rows = Math.min(24, Math.max(4, ta.value.split('\n').length +
                                      Math.floor(ta.value.length / 90)));
    el.parentNode.insertBefore(box, el);
    el.classList.add('blk-hidden');
    EDIT.open = { el: el, box: box, id: id };

    box.querySelector('.blk-save').addEventListener('click', saveEditor);
    box.querySelector('.blk-cancel').addEventListener('click', function () {
      closeEditor();
    });
    box.querySelector('.blk-showtex').addEventListener('click', function () {
      var pre = box.querySelector('.blk-tex');
      if (!pre.hidden) { pre.hidden = true; return; }
      fetch('/__edit/block?id=' + encodeURIComponent(id), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          pre.textContent = res.ok
            ? res.file + ':' + res.start + '–' + res.end + '\n\n' + res.latex
            : (res.error || '불러오지 못했습니다');
          pre.hidden = false;
        });
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); saveEditor();
      }
    });
    ta.focus();
  }

  function closeEditor() {
    var st = EDIT.open;
    if (!st) return;
    st.box.remove();
    st.el.classList.remove('blk-hidden');
    EDIT.open = null;
  }

  function saveEditor() {
    var st = EDIT.open;
    if (!st) return;
    var msg = st.box.querySelector('.blk-msg');
    msg.className = 'blk-msg';
    msg.textContent = '저장 중…';
    fetch('/__edit/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: st.id,
                             html: st.box.querySelector('.blk-src').value })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) {
          msg.className = 'blk-msg bad';
          msg.textContent = res.error || '저장하지 못했습니다';
          return;
        }
        if (res.reload) { rememberScroll(); location.reload(); return; }
        if (res.unchanged) { closeEditor(); return; }
        var tmp = document.createElement('div');
        tmp.innerHTML = res.html;
        var fresh = tmp.firstElementChild;
        st.el.parentNode.replaceChild(fresh, st.el);
        st.box.remove();
        EDIT.open = null;
        attachEditButtons();
        fresh.classList.add('blk-saved');
        setTimeout(function () { fresh.classList.remove('blk-saved'); }, 1200);
      })
      .catch(function (err) {
        msg.className = 'blk-msg bad';
        msg.textContent = '편집 서버에 닿지 못했습니다: ' + err;
      });
  }

  function showBar() {
    if (EDIT.bar) { EDIT.bar.hidden = false; return; }
    var b = document.createElement('div');
    b.className = 'edit-bar';
    b.innerHTML = '<span class="edit-dot"></span>편집 모드 — 고칠 문단에 ' +
                  '마우스를 올리세요. <kbd>Ctrl</kbd>+<kbd>E</kbd>로 끄기';
    document.body.appendChild(b);
    EDIT.bar = b;
  }

  function rememberScroll() {
    try { sessionStorage.setItem('blkScroll', String(window.scrollY)); }
    catch (e) { /* 사파리 프라이빗 모드 등 */ }
  }

  function restoreScroll() {
    try {
      var y = sessionStorage.getItem('blkScroll');
      if (y === null) return;
      sessionStorage.removeItem('blkScroll');
      window.scrollTo(0, +y);
      toggleEdit(true);            // 저장 직후의 새로고침이면 편집 모드 유지
    } catch (e) { /* 무시 */ }
  }

  /* ---------------- utilities ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;',
               '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();

/* ============================================================
   점검 목록(checklist) — 눌러서 표시하고, 그 표시를 기기에 남긴다.
   『AI 문제해결』에서 더한 부분. 8·12장 실습과 부록 D에서 쓴다.
   ============================================================ */
(function () {
  'use strict';
  var KEY = 'aips-checklist';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* 저장이 막힌 환경이면 그냥 넘어간다 */ }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var page = (location.pathname.split('/').pop() || 'index').replace('.html', '');
    var state = load();
    var lists = document.querySelectorAll('ul.checklist');
    if (!lists.length) return;

    lists.forEach(function (ul, li_i) {
      ul.querySelectorAll(':scope > li').forEach(function (li, j) {
        var id = page + ':' + li_i + ':' + j;
        if (state[id]) li.classList.add('done');
        li.setAttribute('role', 'checkbox');
        li.setAttribute('tabindex', '0');
        li.setAttribute('aria-checked', state[id] ? 'true' : 'false');

        function toggle() {
          var on = li.classList.toggle('done');
          li.setAttribute('aria-checked', on ? 'true' : 'false');
          if (on) { state[id] = 1; } else { delete state[id]; }
          save(state);
        }
        li.addEventListener('click', function (e) {
          // 목록 안의 링크를 누른 경우는 표시하지 않는다
          if (e.target.closest('a')) return;
          toggle();
        });
        li.addEventListener('keydown', function (e) {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        });
      });
    });
  });
})();
