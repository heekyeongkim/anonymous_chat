// 실시간 익명 채팅 – 화면 동작 (Supabase 실시간 방송만 씀 · DB 저장 없음)
// 화면 상태 6종: 로딩 · 0건 · 정상 · 실패(끊김) · 중복 입력 · 접근 불가(연결 도구 없음)
(function () {
  'use strict';

  var MAX_LEN = 500;
  var NICK_LEN = 30;
  var DEFAULT_NICK = '익명';
  var GROUP_MS = 3 * 60 * 1000;   // 같은 사람이 3분 안에 이어 쓰면 묶어 보여 준다
  var UNDO_MS = 4000;             // 지우기 되돌리기 시간
  var DUP_MS = 3000;              // 같은 글 연속 전송 막는 시간
  var CHIPS = ['🙋 질문 있어요', '👍 이해했어요', '🔁 다시 설명해 주세요', '🐢 조금 빨라요', '💡 좋은 생각!', '👏'];

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    list: $('list'), msgs: $('msgs'), skeleton: $('skeleton'), guide: $('guide'), noserver: $('noserver'),
    guideTitle: $('guideTitle'), guideSub: $('guideSub'), guideChips: $('guideChips'), chips: $('chips'),
    form: $('form'), input: $('input'), send: $('sendBtn'), counter: $('counter'), hint: $('hint'),
    nickBtn: $('nickBtn'), nickText: $('nickText'), nickInput: $('nickInput'), myAvatar: $('myAvatar'),
    conn: $('conn'), connText: $('connText'), count: $('count'), countNum: $('countNum'), info: $('infoBtn'),
    banner: $('banner'), bannerText: $('bannerText'), bannerBtn: $('bannerBtn'),
    newPill: $('newPill'), newNum: $('newNum'), toast: $('toast'), toastText: $('toastText'), toastBtn: $('toastBtn'),
    demo: $('demo')
  };

  // ---------- 브라우저 저장소 (실패해도 동작) ----------
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  // ---------- 방 · 나 ----------
  var params = new URLSearchParams(location.search);
  var rawRoom = (params.get('room') || '').trim().toUpperCase();
  var room = /^[A-Z0-9_-]{1,20}$/.test(rawRoom) ? rawRoom : 'MAIN';
  $('roomName').textContent = room;
  document.title = '실시간 채팅 · ' + room;

  var pid = load('chat_pid');
  if (!pid) { pid = newId(); save('chat_pid', pid); }

  // 내가 쓴 글 번호 (새로고침해도 '나' 표시 · 지우기 가능)
  var MINE_KEY = 'chat_mine_' + room;
  var mineIds = [];
  try { mineIds = JSON.parse(load(MINE_KEY) || '[]'); } catch (e) { mineIds = []; }
  function rememberMine(id) {
    mineIds.push(id);
    if (mineIds.length > 300) mineIds = mineIds.slice(-300);
    save(MINE_KEY, JSON.stringify(mineIds));
  }
  function isMine(m) { return !!m.local || !!m.demoMine || mineIds.indexOf(m.id) >= 0; }

  function cleanNick(v) { return (v || '').trim().slice(0, NICK_LEN) || DEFAULT_NICK; }
  var nickname = cleanNick(load('chat_nick'));

  // ---------- 아바타 (닉네임마다 색이 정해짐) ----------
  var HUES = [200, 160, 265, 25, 330, 45, 120, 290];
  function hueOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }
  function paintAvatar(node, name) {
    var hue = hueOf(name);
    node.textContent = Array.from(name)[0] || '?';
    node.style.background = 'hsl(' + hue + ' 70% 60% / .18)';
    node.style.color = 'hsl(' + hue + ' 85% 74%)';
    node.style.border = '1px solid hsl(' + hue + ' 70% 60% / .35)';
  }
  function whoColor(name) { return 'hsl(' + hueOf(name) + ' 85% 74%)'; }

  function showNick() {
    el.nickText.textContent = nickname;
    paintAvatar(el.myAvatar, nickname);
    el.hint.textContent = '';
    var b = document.createElement('b');
    b.textContent = nickname;
    el.hint.appendChild(b);
    el.hint.appendChild(document.createTextNode(' 이름으로 보여요 · Enter 보내기 · Shift+Enter 줄바꿈'));
  }
  showNick();

  // ---------- 상태 ----------
  // view: loading | ready | offline | noserver
  var view = 'loading';
  var messages = [];          // {id, cid, nickname, content, created_at, local?, status?: pending|failed|deleting, err?}
  var guideOpen = false;
  var unread = 0;
  var failCount = 0;
  var seen = {};               // 이미 그린 글 (등장 효과는 새 글에만)

  function setConn(kind, text) {
    el.conn.className = 'pill conn ' + kind;
    el.connText.textContent = text;
    el.conn.title = text;
  }

  function setBanner(text, withRetry) {
    el.banner.hidden = !text;
    el.bannerText.textContent = text || '';
    el.bannerBtn.hidden = !withRetry;
  }

  var toastTimer = null;
  function toast(text, btnText, onBtn, ms) {
    clearTimeout(toastTimer);
    el.toastText.textContent = text;
    el.toastBtn.hidden = !btnText;
    el.toastBtn.textContent = btnText || '';
    el.toastBtn.onclick = onBtn ? function () { hideToast(); onBtn(); } : null;
    el.toast.hidden = false;
    toastTimer = setTimeout(hideToast, ms || 3000);
  }
  function hideToast() { el.toast.hidden = true; }

  function setView(v) {
    view = v;
    var canType = v === 'ready' || v === 'offline';
    el.input.disabled = !canType;
    el.skeleton.hidden = v !== 'loading';
    el.noserver.hidden = v !== 'noserver';

    if (v === 'loading') { setConn('wait', '연결하는 중…'); setBanner(''); }
    if (v === 'ready') { setConn('ok', '실시간 연결됨'); setBanner(''); }
    if (v === 'offline') {
      setConn('bad', '연결 끊김');
      setBanner(failCount >= 3
        ? '채팅 프로그램이 꺼졌을 수 있어요. 강사님께 알려 주세요. 지금 쓴 글은 연결되면 다시 보낼 수 있어요.'
        : '연결이 잠깐 끊겼어요. 자동으로 다시 연결하는 중이에요.', true);
    }
    if (v === 'noserver') { setConn('bad', '서버 없음'); setBanner(''); el.count.hidden = true; }
    updateComposer();
    render(false);
  }

  // ---------- 그리기 ----------
  var URL_RE = /(https?:\/\/[^\s<>"')]+)/gi;
  function fillContent(node, text) {      // 링크만 <a>, 나머지는 글자 그대로
    var last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }
  var EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|️|‍|\s){1,8}$/u;

  function pad(n) { return String(n).padStart(2, '0'); }
  function timeText(iso) { var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dayText(iso) {
    var d = new Date(iso), t = new Date();
    if (d.toDateString() === t.toDateString()) return '오늘';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  function sameGroup(a, b) {
    return a && b && a.nickname === b.nickname && isMine(a) === isMine(b) &&
      Math.abs(new Date(b.created_at) - new Date(a.created_at)) < GROUP_MS &&
      new Date(a.created_at).toDateString() === new Date(b.created_at).toDateString();
  }

  function btn(text, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'link-btn' + (cls ? ' ' + cls : ''); b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function nearBottom() { return el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 90; }
  function toBottom() { el.list.scrollTop = el.list.scrollHeight; unread = 0; el.newPill.hidden = true; }

  function render(forceBottom) {
    var stick = forceBottom || nearBottom();
    var showMsgs = view === 'ready' || view === 'offline';
    var empty = messages.length === 0;

    el.msgs.hidden = !showMsgs;
    el.guide.hidden = !(showMsgs && (empty || guideOpen));
    el.guideTitle.textContent = empty ? '아직 아무도 글을 남기지 않았어요' : '이 채팅방에서는';
    el.guideSub.textContent = empty ? '첫 글을 남기면 이 방에 있는 모두에게 바로 보여요.' : '이름 없이 편하게 이야기하는 곳이에요.';
    el.info.setAttribute('aria-pressed', guideOpen ? 'true' : 'false');

    el.msgs.textContent = '';
    var frag = document.createDocumentFragment();
    messages.forEach(function (m, i) {
      var prev = messages[i - 1], next = messages[i + 1];
      if (!prev || dayText(prev.created_at) !== dayText(m.created_at)) {
        var day = document.createElement('div');
        day.className = 'day';
        day.textContent = dayText(m.created_at);
        frag.appendChild(day);
      }
      var mine = isMine(m);
      var grouped = sameGroup(prev, m);
      var row = document.createElement('div');
      row.className = 'msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '') +
        (sameGroup(m, next) ? ' grouped-next' : '') + (m.status ? ' ' + m.status : '');
      var key = m.cid || m.id;
      if (!seen[key]) { seen[key] = 1; row.classList.add('new'); }

      if (!mine) {
        if (grouped) { var sp = document.createElement('span'); sp.className = 'av-space'; row.appendChild(sp); }
        else { var av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, m.nickname); row.appendChild(av); }
      }

      var body = document.createElement('div');
      body.className = 'body';
      if (!mine && !grouped) {
        var meta = document.createElement('div');
        meta.className = 'meta';
        var who = document.createElement('span');
        who.className = 'who'; who.textContent = m.nickname; who.style.color = whoColor(m.nickname);
        var at = document.createElement('span');
        at.className = 'at'; at.textContent = timeText(m.created_at);
        meta.appendChild(who); meta.appendChild(at);
        body.appendChild(meta);
      }

      var bubble = document.createElement('div');
      bubble.className = 'bubble' + (EMOJI_ONLY.test(m.content) ? ' big' : '');
      fillContent(bubble, m.content);
      body.appendChild(bubble);

      if (mine) {
        var line = document.createElement('div');
        line.className = 'mine-line';
        if (m.status === 'pending') {
          line.appendChild(document.createTextNode('보내는 중…'));
        } else if (m.status === 'failed') {
          line.appendChild(document.createTextNode((m.err || '보내지 못했어요') + ' · '));
          line.appendChild(btn('다시 보내기', 'strong', function () { retry(m); }));
          line.appendChild(btn('지우기', '', function () { dropLocal(m); }));
        } else if (m.status === 'deleting') {
          line.appendChild(document.createTextNode('지우는 중 · '));
          line.appendChild(btn('되돌리기', 'strong', function () { undoDelete(m); }));
        } else {
          line.appendChild(document.createTextNode(timeText(m.created_at) + ' · '));
          line.appendChild(btn('지우기', '', function () { askDelete(m); }));
        }
        body.appendChild(line);
      }

      row.appendChild(body);
      frag.appendChild(row);
    });
    el.msgs.appendChild(frag);
    el.chips.hidden = view === 'noserver';
    if (empty && showMsgs && !guideOpen) el.list.scrollTop = 0;   // 0건: 안내 카드를 위에서부터
    else if (stick) toBottom();
  }

  // ---------- 입력칸 ----------
  function connected() { return view === 'ready'; }

  function updateComposer() {
    var len = el.input.value.length;
    el.counter.textContent = len >= 400 ? len + ' / ' + MAX_LEN : '';
    el.counter.className = 'counter' + (len > MAX_LEN ? ' over' : len >= 400 ? ' near' : '');
    el.send.disabled = !connected() || !el.input.value.trim() || len > MAX_LEN;
    el.input.placeholder = view === 'offline' ? '연결되면 보낼 수 있어요…' : '익명으로 입력…';
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 130) + 'px';
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) { c.disabled = !connected(); });
  }
  el.input.addEventListener('input', updateComposer);
  el.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
  el.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

  // 빠른 반응 버튼
  function makeChips(box) {
    CHIPS.forEach(function (t) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'chip'; c.textContent = t;
      c.addEventListener('click', function () { send(t); });
      box.appendChild(c);
    });
  }
  makeChips(el.chips);
  makeChips(el.guideChips);

  // ---------- 닉네임 ----------
  var nickCancel = false;
  el.nickBtn.addEventListener('click', function () {
    el.nickInput.value = nickname;
    el.nickBtn.hidden = true; el.nickInput.hidden = false;
    el.nickInput.focus(); el.nickInput.select();
  });
  el.nickInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.nickInput.blur(); }
    if (e.key === 'Escape') { nickCancel = true; el.nickInput.blur(); }
  });
  el.nickInput.addEventListener('blur', function () {
    if (!nickCancel) {
      var before = nickname;
      nickname = cleanNick(el.nickInput.value);
      save('chat_nick', nickname);
      showNick();
      if (before !== nickname) toast('이제 ‘' + nickname + '’ 이름으로 보여요', '되돌리기', function () {
        nickname = before; save('chat_nick', nickname); showNick();
      });
    }
    nickCancel = false;
    el.nickInput.hidden = true; el.nickBtn.hidden = false;
  });

  // ---------- 안내 · 새 글 ----------
  el.info.addEventListener('click', function () {
    guideOpen = !guideOpen;
    render(false);
    if (guideOpen) el.list.scrollTop = 0;
  });
  el.newPill.addEventListener('click', toBottom);
  el.list.addEventListener('scroll', function () { if (nearBottom()) { unread = 0; el.newPill.hidden = true; } });

  // ---------- 보내기 ----------
  var lastSent = { text: '', at: 0 };
  var sentTimes = [];          // 도배 막기: 5초에 5개까지

  function submit() {
    if (send(el.input.value)) { el.input.value = ''; updateComposer(); }
    el.input.focus();
  }

  function send(raw) {
    var text = String(raw || '').trim();
    if (!connected() || !text || text.length > MAX_LEN) return false;
    if (text === lastSent.text && Date.now() - lastSent.at < DUP_MS) {   // 중복 입력 막기
      toast('방금 같은 글을 보냈어요');
      return false;
    }
    var now = Date.now();
    sentTimes = sentTimes.filter(function (t) { return now - t < 5000; });
    if (sentTimes.length >= 5) { toast('너무 빨라요. 잠시 후 보내 주세요'); return false; }
    sentTimes.push(now);
    lastSent = { text: text, at: now };

    var m = { id: newId(), nickname: nickname, content: text, created_at: new Date().toISOString(),
              local: true, status: 'pending', secret: newId() };
    messages.push(m);
    render(true);
    post(m);
    return true;
  }

  // 지우기 열쇠: 글에는 열쇠의 지문(tag)만 붙이고, 지울 때 열쇠를 보여 준다
  var KEYS_KEY = 'chat_keys_' + room;
  var keys = {};
  try { keys = JSON.parse(load(KEYS_KEY) || '{}') || {}; } catch (e) { keys = {}; }
  function saveKey(id, secret) {
    keys[id] = secret;
    var ids = Object.keys(keys);
    if (ids.length > 300) delete keys[ids[0]];
    save(KEYS_KEY, JSON.stringify(keys));
  }
  function sha(text) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve('');
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function publicMsg(m) {
    return { id: m.id, nickname: m.nickname, content: m.content, created_at: m.created_at, tag: m.tag || '' };
  }

  function broadcast(event, payload) {
    if (demoMode) return Promise.resolve();
    if (!live || !chan) return Promise.reject(new Error('연결이 끊겨 보내지 못했어요'));
    return chan.send({ type: 'broadcast', event: event, payload: payload }).then(function (r) {
      if (r !== 'ok') throw new Error(r === 'timed out' ? '응답이 늦어 보내지 못했어요' : '보내지 못했어요');
    });
  }

  function post(m) {
    (m.tag ? Promise.resolve(m.tag) : sha(m.secret))
      .then(function (tag) { m.tag = tag; return broadcast('msg', publicMsg(m)); })
      .then(function () {
        rememberMine(m.id);
        saveKey(m.id, m.secret);
        m.local = false; m.status = ''; m.err = '';
        render(false);
      })
      .catch(function (err) {
        m.status = 'failed'; m.err = err.message;
        render(false);
      });
  }

  function retry(m) {
    if (!connected()) { toast('연결되면 다시 보낼 수 있어요'); return; }
    m.status = 'pending'; m.err = '';
    render(false);
    post(m);
  }
  function dropLocal(m) {
    messages = messages.filter(function (x) { return x !== m; });
    render(false);
  }

  // ---------- 지우기 (되돌리기 4초) ----------
  function askDelete(m) {
    m.status = 'deleting';
    render(false);
    m.timer = setTimeout(function () {
      var secret = keys[m.id];
      var go = secret ? broadcast('del', { id: m.id, key: secret })
                      : Promise.reject(new Error('이 글은 이 기기에서 지울 수 없어요'));
      go.then(function () {
        messages = messages.filter(function (x) { return x.id !== m.id; });
        delete keys[m.id]; save(KEYS_KEY, JSON.stringify(keys));
        render(false);
        toast('글을 지웠어요');
      }).catch(function (err) {
        m.status = '';
        render(false);
        toast(err.message);
      });
    }, UNDO_MS);
  }
  function undoDelete(m) {
    clearTimeout(m.timer);
    m.status = '';
    render(false);
  }

  // ---------- 받은 글 검사 (다른 사람이 보낸 값은 믿지 않는다) ----------
  function cleanMsg(p) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 64) return null;
    var content = String(p.content || '').slice(0, MAX_LEN).trim();
    if (!content) return null;
    var d = new Date(p.created_at);
    if (isNaN(d) || d.getTime() > Date.now() + 60000) d = new Date();
    return { id: p.id, nickname: cleanNick(String(p.nickname || '')), content: content,
             created_at: d.toISOString(), tag: typeof p.tag === 'string' ? p.tag.slice(0, 64) : '' };
  }
  function addIncoming(p) {
    var m = cleanMsg(p);
    if (!m || messages.some(function (x) { return x.id === m.id; })) return null;
    messages.push(m);
    messages.sort(function (a, b) {
      if (!!a.local !== !!b.local) return a.local ? 1 : -1;    // 보내는 중인 내 글은 맨 아래
      return a.created_at.localeCompare(b.created_at);
    });
    return m;
  }

  // ---------- 실시간 연결 (Supabase 실시간 방송 · 저장 없음) ----------
  var client = null, chan = null, live = false;
  var myKey = newId();                    // 이 탭의 접속 이름표 (인원 세기용)

  function onMsg(p) {
    var wasBottom = nearBottom();
    if (!addIncoming(p)) return;
    render(false);
    if (!wasBottom) { unread++; el.newNum.textContent = unread; el.newPill.hidden = false; }
    else toBottom();
  }
  function onDel(p) {
    if (!p || typeof p.id !== 'string' || typeof p.key !== 'string') return;
    var m = messages.filter(function (x) { return x.id === p.id; })[0];
    if (!m || !m.tag) return;
    sha(p.key).then(function (h) {
      if (h && h === m.tag) {                  // 열쇠가 맞을 때만 지운다
        messages = messages.filter(function (x) { return x.id !== p.id; });
        render(false);
      }
    });
  }
  // 새로 온 사람에게 최근 글 넘겨주기: 먼저 와 있던 사람 중 한 명만 답한다
  function onHello(p) {
    if (!p || typeof p.key !== 'string' || p.key === myKey || !chan) return;
    var others = Object.keys(chan.presenceState()).filter(function (k) { return k !== p.key; }).sort();
    if (others[0] !== myKey) return;
    var recent = messages.filter(function (m) { return !m.local; }).slice(-50).map(publicMsg);
    if (recent.length) broadcast('history', { to: p.key, messages: recent }).catch(function () {});
  }
  function onHistory(p) {
    if (!p || p.to !== myKey || !Array.isArray(p.messages)) return;
    var added = 0;
    p.messages.slice(0, 50).forEach(function (x) { if (addIncoming(x)) added++; });
    if (added) render(true);
  }

  function connect() {
    if (chan) { var old = chan; chan = null; client.removeChannel(old); }
    live = false;
    if (view !== 'ready') setConn('wait', '연결하는 중…');

    var ch = client.channel('anonchat-' + room, {
      config: { broadcast: { self: false, ack: true }, presence: { key: myKey } }
    });
    chan = ch;
    ch.on('broadcast', { event: 'msg' }, function (e) { onMsg(e.payload); })
      .on('broadcast', { event: 'del' }, function (e) { onDel(e.payload); })
      .on('broadcast', { event: 'hello' }, function (e) { onHello(e.payload); })
      .on('broadcast', { event: 'history' }, function (e) { onHistory(e.payload); })
      .on('presence', { event: 'sync' }, function () {
        el.countNum.textContent = Object.keys(ch.presenceState()).length;
        el.count.hidden = false;
      })
      .subscribe(function (status) {
        if (ch !== chan) return;                     // 일부러 닫은 옛 연결은 무시
        if (status === 'SUBSCRIBED') {
          live = true; failCount = 0;
          setView('ready');
          ch.track({ at: Date.now() });
          broadcast('hello', { key: myKey }).catch(function () {});
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          live = false; failCount++;
          if (view === 'loading' && failCount < 2) return;   // 처음 한 번은 조금 기다린다
          setView('offline');                        // supabase-js 가 알아서 다시 붙는다
        }
      });
  }
  el.bannerBtn.addEventListener('click', function () {
    if (demoMode) { setView('ready'); return; }
    failCount = 0;
    setConn('wait', '연결하는 중…');
    connect();
  });

  // ---------- 상태 미리보기 (?demo=1) ----------
  var DEMO_STATES = ['loading', 'empty', 'ready', 'offline', 'noserver'];
  var demoParam = params.get('demo');
  var demoMode = demoParam === '1' || DEMO_STATES.indexOf(demoParam) >= 0;
  function demoData() {
    var t = Date.now();
    function at(min) { return new Date(t - min * 60000).toISOString(); }
    return [
      { id: 'd1', nickname: '파란고래', content: '안녕하세요! 오늘 자료 링크 있나요?', created_at: at(9) },
      { id: 'd2', nickname: '파란고래', content: 'https://example.com 여기 맞나요?', created_at: at(8) },
      { id: 'd3', nickname: '익명', content: '🙋 질문 있어요', created_at: at(6) },
      { id: 'd4', nickname: '노란우산', content: '👍', created_at: at(5) },
      { id: 'd5', nickname: '노란우산', content: '예시가 이해하기 쉬웠어요.\n두 번째 실습도 기대돼요', created_at: at(4) },
      { id: 'd6', nickname: nickname, content: '저도 같은 질문이요!', created_at: at(2), demoMine: true },
      { id: 'd7', nickname: nickname, content: '💡 좋은 생각!', created_at: at(1.5), demoMine: true }
    ];
  }
  function runDemo(state) {
    Array.prototype.forEach.call(el.demo.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-demo') === state);
    });
    guideOpen = false;
    if (state === 'loading') { messages = []; failCount = 0; setView('loading'); return; }
    if (state === 'noserver') { messages = []; setView('noserver'); return; }
    el.count.hidden = false; el.countNum.textContent = '12';
    if (state === 'empty') { messages = []; failCount = 0; setView('ready'); return; }
    messages = demoData();
    if (state === 'ready') { failCount = 0; setView('ready'); }
    if (state === 'offline') {
      messages.push({ id: 'd8', cid: 'd8', nickname: nickname, content: '실습 파일은 어디서 받나요?',
                      created_at: new Date().toISOString(), local: true, status: 'failed', err: '연결이 끊겨 보내지 못했어요' });
      failCount = 3; setView('offline');
    }
    render(true);
  }

  // ---------- 시작 ----------
  updateComposer();
  if (demoMode) {
    el.demo.hidden = false;
    Array.prototype.forEach.call(el.demo.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { runDemo(b.getAttribute('data-demo')); });
    });
    runDemo(DEMO_STATES.indexOf(demoParam) >= 0 ? demoParam : 'ready');
  } else if (!window.supabase || typeof SUPABASE_URL !== 'string' || typeof SUPABASE_ANON_KEY !== 'string') {
    setView('noserver');               // 접근 불가: 막기만 하지 않고 다음 행동 안내
  } else {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    setView('loading');
    connect();
  }
})();
