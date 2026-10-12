/*
 * Webex Click-to-Call widget (guest calling, Webex Calling Customer Assist)
 *
 * Embed on any page:
 *   <link rel="stylesheet" href="https://YOUR-SERVER/c2c-widget.css">
 *   <script src="https://YOUR-SERVER/c2c-widget.js"
 *           data-api-base="https://YOUR-SERVER" data-label="Call us" defer></script>
 *
 * Call flow (each click):
 *   1. Load the Webex Calling SDK      (pinned version from unpkg, cached after the first call)
 *   2. Ask for the microphone          (no Webex tokens are spent if the visitor declines)
 *   3. POST /api/c2c/session           (our server mints a guest token + JWE call token)
 *   4. Calling.init + register line    (as a guest: serviceData.indicator = 'guestcalling')
 *   5. line.makeCall() + call.dial()   (destination is inside the JWE; the browser never sees it)
 *   6. On hang-up: stop mic, deregister, discard tokens
 *
 * The host page can follow progress through `webex-c2c:state` and `webex-c2c:log`
 * events dispatched on `window`.
 */
(function () {
  'use strict';

  const script = document.currentScript;
  const REGISTER_TIMEOUT_MS = 30000;

  const STATES = {
    idle: 'Talk to us from your browser',
    mic: 'Allow microphone access…',
    session: 'Preparing your call…',
    sdk: 'Loading calling service…',
    registering: 'Connecting…',
    dialing: 'Calling…',
    ringing: 'Ringing…',
    connected: 'Connected',
    ending: 'Ending call…',
    ended: 'Call ended',
    error: 'Call failed',
  };

  function emit(type, detail) {
    window.dispatchEvent(new CustomEvent('webex-c2c:' + type, { detail }));
  }

  function log(msg, level) {
    const entry = { time: new Date(), level: level || 'info', msg };
    (level === 'error' ? console.error : console.log)('[click-to-call] ' + msg);
    emit('log', entry);
  }

  const sdkLoads = {};
  function loadSdk(version) {
    if (window.Calling) return Promise.resolve(window.Calling);
    sdkLoads[version] ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/webex@' + version + '/umd/calling.min.js';
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Calling ? resolve(window.Calling) : reject(new Error('Calling SDK did not load')));
      s.onerror = () => {
        delete sdkLoads[version];
        reject(new Error('Could not download the Webex Calling SDK'));
      };
      document.head.appendChild(s);
    });
    return sdkLoads[version];
  }

  function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(what + ' timed out after ' + ms / 1000 + 's')), ms);
      }),
    ]).finally(() => clearTimeout(t));
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children || []) n.appendChild(c);
    return n;
  }

  class ClickToCall {
    constructor({ apiBase, label, container }) {
      this.apiBase = (apiBase || '').replace(/\/$/, '');
      this.label = label || 'Call us';
      this.container = container || document.body;
      this.state = 'idle';
      this.reset();
      this.render();
      this.loadConfig();
    }

    reset() {
      this.calling = null;
      this.line = null;
      this.call = null;
      this.mic = null;
      this.muted = false;
      this.held = false;
      this.connectedAt = 0;
      clearInterval(this.timer);
    }

    async loadConfig() {
      try {
        const res = await fetch(this.apiBase + '/api/config');
        this.config = await res.json();
        this.nameField.hidden = !this.config.allowGuestName;
        log('Config loaded: Webex SDK ' + this.config.sdkVersion);
      } catch (err) {
        this.config = null;
        log('Could not reach the click-to-call server at ' + (this.apiBase || window.location.origin), 'error');
      }
    }

    // ---------- UI ----------
    render() {
      this.statusText = el('p', { class: 'c2c-status', 'aria-live': 'polite' });
      this.timerText = el('span', { class: 'c2c-timer' });
      this.nameInput = el('input', { type: 'text', maxlength: '40', placeholder: 'Your name (optional)', 'aria-label': 'Your name', autocomplete: 'name' });
      this.nameField = el('div', { class: 'c2c-name' }, [this.nameInput]);
      this.startBtn = el('button', { class: 'c2c-btn c2c-btn-call', type: 'button', text: 'Start call', onclick: () => this.start() });
      this.muteBtn = el('button', { class: 'c2c-btn', type: 'button', text: 'Mute', 'aria-pressed': 'false', onclick: () => this.toggleMute() });
      this.holdBtn = el('button', { class: 'c2c-btn', type: 'button', text: 'Hold', 'aria-pressed': 'false', onclick: () => this.toggleHold() });
      this.padBtn = el('button', { class: 'c2c-btn', type: 'button', text: 'Keypad', 'aria-expanded': 'false', onclick: () => this.toggleKeypad() });
      this.endBtn = el('button', { class: 'c2c-btn c2c-btn-end', type: 'button', text: 'End call', onclick: () => this.hangUp() });
      this.keypad = el(
        'div',
        { class: 'c2c-keypad', hidden: '' },
        '123456789*0#'.split('').map((d) => el('button', { type: 'button', class: 'c2c-key', text: d, 'aria-label': 'Dial ' + d, onclick: () => this.sendDigit(d) })),
      );
      this.inCall = el('div', { class: 'c2c-incall', hidden: '' }, [
        el('div', { class: 'c2c-controls' }, [this.muteBtn, this.holdBtn, this.padBtn]),
        this.keypad,
        this.endBtn,
      ]);
      this.remoteAudio = el('audio', { autoplay: '' });

      this.panel = el('div', { class: 'c2c-panel', role: 'dialog', 'aria-label': this.label, hidden: '' }, [
        el('div', { class: 'c2c-head' }, [
          el('strong', { text: this.label }),
          el('button', { class: 'c2c-close', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => this.togglePanel(false) }),
        ]),
        el('div', { class: 'c2c-statusrow' }, [this.statusText, this.timerText]),
        this.nameField,
        this.startBtn,
        this.inCall,
        el('p', { class: 'c2c-note', text: 'Your call uses your browser microphone. No app or account needed.' }),
        this.remoteAudio,
      ]);
      this.launcher = el('button', { class: 'c2c-launcher', type: 'button', 'aria-expanded': 'false', onclick: () => this.togglePanel() }, [
        el('span', { class: 'c2c-launcher-icon', 'aria-hidden': 'true', text: '📞' }),
        el('span', { text: this.label }),
      ]);
      this.root = el('div', { class: 'c2c-root' }, [this.panel, this.launcher]);
      this.container.appendChild(this.root);
      this.setState('idle');
    }

    togglePanel(force) {
      const open = force ?? this.panel.hidden;
      this.panel.hidden = !open;
      this.launcher.setAttribute('aria-expanded', String(open));
    }

    setState(state, message) {
      this.state = state;
      this.statusText.textContent = message || STATES[state];
      this.root.dataset.state = state;
      const busy = !['idle', 'ended', 'error'].includes(state);
      this.startBtn.hidden = busy;
      this.startBtn.textContent = state === 'idle' ? 'Start call' : 'Call again';
      this.nameInput.disabled = busy;
      this.inCall.hidden = !busy || state === 'mic';
      const live = state === 'connected';
      for (const b of [this.muteBtn, this.holdBtn, this.padBtn]) b.disabled = !live;
      if (!live) this.keypad.hidden = true;
      emit('state', { state, message: this.statusText.textContent });
    }

    startTimer() {
      this.connectedAt = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - this.connectedAt) / 1000);
        this.timerText.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      };
      tick();
      this.timer = setInterval(tick, 1000);
    }

    // ---------- Call flow ----------
    async start() {
      if (!this.config) await this.loadConfig();
      if (!this.config) return this.fail(new Error('Click-to-call server is unreachable'));
      this.timerText.textContent = '';
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot make calls (needs HTTPS and WebRTC)');
        this.setState('sdk');
        const Calling = await loadSdk(this.config.sdkVersion);
        log('Webex Calling SDK loaded');

        // 1. Microphone before tokens: a visitor who declines costs no Webex tokens.
        this.setState('mic');
        this.mic = await Calling.createMicrophoneStream({ audio: true });
        log('Microphone access granted');

        // 2. Guest token + JWE call token from our server.
        this.setState('session');
        const session = await this.createSession();
        log('Session ' + session.sessionId + ' created for guest "' + session.guestName + '"');

        // 4. Initialise the SDK as a guest and register a line.
        this.setState('registering');
        await this.register(Calling, session);

        // 5. Place the call. No destination: it is fixed inside the JWE call token.
        this.setState('dialing');
        this.call = this.line.makeCall();
        if (!this.call) throw new Error('The SDK could not create the call');
        this.bindCallEvents();
        this.call.dial(this.mic);
        log('Dialing…');
      } catch (err) {
        this.fail(err);
      }
    }

    async createSession() {
      const res = await fetch(this.apiBase + '/api/c2c/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.nameInput.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Server error ' + res.status);
      if (!body.guestToken || !body.callToken) throw new Error('Server returned an incomplete session');
      return body;
    }

    async register(Calling, session) {
      const callingClientConfig = {
        logger: { level: 'info' },
        serviceData: { indicator: 'guestcalling', domain: '', guestName: session.guestName },
        jwe: session.callToken,
      };
      if (session.sdk.region || session.sdk.country) {
        callingClientConfig.discovery = { region: session.sdk.region, country: session.sdk.country };
      }

      this.calling = await Calling.init({
        webexConfig: {
          config: {
            logger: { level: 'info' },
            encryption: { kmsInitialTimeout: 8000, kmsMaxTimeout: 40000, batcherMaxCalls: 30, caroots: null },
            dss: {},
          },
          credentials: { access_token: session.guestToken },
        },
        callingConfig: {
          clientConfig: { calling: true, callHistory: false },
          callingClientConfig,
          logger: { level: 'info' },
        },
      });

      await withTimeout(
        new Promise((resolve, reject) => {
          this.calling.on('ready', async () => {
            try {
              log('SDK ready, registering guest device');
              await this.calling.register();
              this.line = Object.values(this.calling.callingClient.getLines())[0];
              if (!this.line) throw new Error('No calling line was created for the guest');
              this.line.on('registered', () => {
                log('Line registered with Webex Calling');
                resolve();
              });
              this.line.on('error', (e) => reject(new Error('Line registration failed: ' + (e?.message || e?.type || 'unknown'))));
              this.line.register();
            } catch (err) {
              reject(err);
            }
          });
        }),
        REGISTER_TIMEOUT_MS,
        'Registration',
      );
    }

    bindCallEvents() {
      const c = this.call;
      // Ignore late events from a call that has already been cleaned up.
      const on = (evt, fn) => c.on(evt, (...args) => this.call === c && fn(...args));
      on('progress', () => {
        log('Ringing (call is progressing)');
        this.setState('ringing');
      });
      const onConnected = () => {
        if (this.state === 'connected') return;
        log('Call connected');
        this.setState('connected');
        this.startTimer();
      };
      on('connect', onConnected);
      on('established', onConnected);
      on('remote_media', (track) => {
        log('Receiving remote audio');
        this.remoteAudio.srcObject = new MediaStream([track]);
      });
      on('call_error', (e) => this.fail(new Error(e?.message || 'Call error')));
      on('disconnect', () => {
        log('Call disconnected');
        this.cleanup('ended');
      });
    }

    toggleMute() {
      if (!this.call) return;
      this.call.mute(this.mic);
      this.muted = !this.muted;
      this.muteBtn.textContent = this.muted ? 'Unmute' : 'Mute';
      this.muteBtn.setAttribute('aria-pressed', String(this.muted));
      log(this.muted ? 'Muted' : 'Unmuted');
    }

    toggleHold() {
      if (!this.call) return;
      this.call.doHoldResume();
      this.held = !this.held;
      this.holdBtn.textContent = this.held ? 'Resume' : 'Hold';
      this.holdBtn.setAttribute('aria-pressed', String(this.held));
      log(this.held ? 'Call on hold' : 'Call resumed');
    }

    toggleKeypad() {
      this.keypad.hidden = !this.keypad.hidden;
      this.padBtn.setAttribute('aria-expanded', String(!this.keypad.hidden));
    }

    // DTMF, for auto attendant / IVR menus ("press 1 for sales").
    sendDigit(d) {
      if (!this.call) return;
      this.call.sendDigit(d);
      log('Sent DTMF ' + d);
    }

    hangUp() {
      log('Hanging up');
      this.setState('ending');
      try {
        this.call?.end();
      } catch (err) {
        log('end() failed: ' + err.message, 'error');
      }
      this.cleanup('ended');
    }

    fail(err) {
      log(err.message || String(err), 'error');
      this.cleanup('error', friendly(err));
    }

    async cleanup(finalState, message) {
      if (this.cleaning) return;
      this.cleaning = true;
      const { mic, line, calling } = this;
      clearInterval(this.timer);
      this.reset();
      this.setState(finalState, message);
      try {
        mic?.outputStream?.getTracks().forEach((t) => t.stop());
        mic?.stop?.();
      } catch {}
      this.remoteAudio.srcObject = null;
      try {
        await line?.deregister?.();
        await calling?.deregister?.();
        if (line) log('Guest device deregistered');
      } catch (err) {
        log('Deregister failed: ' + err.message, 'error');
      }
      this.muteBtn.textContent = 'Mute';
      this.holdBtn.textContent = 'Hold';
      this.muteBtn.setAttribute('aria-pressed', 'false');
      this.holdBtn.setAttribute('aria-pressed', 'false');
      this.padBtn.setAttribute('aria-expanded', 'false');
      this.cleaning = false;
    }
  }

  function friendly(err) {
    const m = (err && err.message) || '';
    if (/Permission|NotAllowed|denied/i.test(m)) return 'Microphone access was blocked. Allow it and try again.';
    if (/NotFound|no audio|Requested device/i.test(m)) return 'No microphone was found.';
    if (/Too many/i.test(m)) return m;
    if (/HTTPS|WebRTC/i.test(m)) return m;
    return 'We could not connect your call. Please try again.';
  }

  window.WebexClickToCall = {
    mount: (opts) => new ClickToCall(opts || {}),
  };

  if (script && script.dataset.autoMount !== 'false') {
    const init = () =>
      (window.webexClickToCall = new ClickToCall({
        apiBase: script.dataset.apiBase || '',
        label: script.dataset.label,
      }));
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
  }
})();
